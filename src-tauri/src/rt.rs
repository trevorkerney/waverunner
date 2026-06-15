//! Rotten Tomatoes scraper.
//!
//! RT has no public API (their real API is partner-licensed), and the audience
//! score in particular exists nowhere else — so this module scrapes it from the
//! public website. Scrapers break: everything here is written as a chain of
//! independent strategies so an RT redesign degrades coverage instead of
//! removing it, and every public function returns gracefully on failure.
//!
//! Extraction strategies (verified against RT page structure, 2026-06):
//!   1. `media-scorecard` JSON blob: `"audienceScore":{..."score":"93"...}`
//!   2. `<score-board>` web-component attributes: `audiencescore="93"`
//!
//! Page discovery, in order:
//!   1. A known slug (cached in `movie.rotten_tomatoes_id`, user-correctable)
//!   2. RT's private search endpoint (JSON; has been stable for years)
//!   3. Slug guessing: `/m/the_batman`, then `/m/the_batman_2022`

use reqwest::Client;

/// Browsery UA — RT serves 403s to default library user agents.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

#[derive(Debug, Clone)]
pub struct RtScores {
    /// The audience score is all this scraper exists for — critic scores come
    /// from OMDB, which carries them legitimately.
    pub audience: Option<u8>,
    /// Slug ("the_batman") the score was found under — cache this.
    pub slug: String,
}

/// Best-effort fetch of RT scores for a movie. `known_slug` short-circuits
/// discovery when we've found (or the user has entered) the page before.
pub async fn fetch_movie_scores(
    client: &Client,
    title: &str,
    year: Option<&str>,
    known_slug: Option<&str>,
) -> Option<RtScores> {
    fetch_scores(client, title, year, known_slug, "m").await
}

/// Same, for TV series — RT serves those under /tv/ with a separate search section.
pub async fn fetch_tv_scores(
    client: &Client,
    title: &str,
    year: Option<&str>,
    known_slug: Option<&str>,
) -> Option<RtScores> {
    fetch_scores(client, title, year, known_slug, "tv").await
}

async fn fetch_scores(
    client: &Client,
    title: &str,
    year: Option<&str>,
    known_slug: Option<&str>,
    prefix: &str, // "m" (movies) or "tv" (series)
) -> Option<RtScores> {
    let mut candidates: Vec<String> = Vec::new();

    if let Some(slug) = known_slug {
        let cleaned = slug
            .trim()
            .trim_start_matches("/m/")
            .trim_start_matches("m/")
            .trim_start_matches("/tv/")
            .trim_start_matches("tv/");
        if !cleaned.is_empty() {
            candidates.push(cleaned.to_string());
        }
    }

    if candidates.is_empty() {
        if let Some(slug) = search_slug(client, title, year, prefix).await {
            candidates.push(slug);
        }
        let guess = slugify(title);
        if !guess.is_empty() {
            if prefix == "tv" {
                // TV slugs rarely carry a year suffix — plain guess first.
                candidates.push(guess.clone());
                if let Some(y) = year {
                    candidates.push(format!("{guess}_{y}"));
                }
            } else {
                if let Some(y) = year {
                    candidates.push(format!("{guess}_{y}"));
                }
                candidates.push(guess);
            }
        }
    }

    for slug in candidates {
        if let Some(scores) = scrape_page(client, &slug, prefix).await {
            return Some(scores);
        }
    }
    None
}

/// RT's site-search JSON endpoint. Private but long-stable; parsed leniently
/// through serde_json::Value so shape drift doesn't panic.
async fn search_slug(client: &Client, title: &str, year: Option<&str>, prefix: &str) -> Option<String> {
    let url = format!(
        "https://www.rottentomatoes.com/api/private/v2.0/search?q={}&limit=10",
        urlencoding(title)
    );
    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let (section, url_prefix) = if prefix == "tv" { ("tvSeries", "/tv/") } else { ("movies", "/m/") };
    let items = body.get(section)?.as_array()?;

    let want_title = normalize(title);
    let want_year: Option<i64> = year.and_then(|y| y.parse().ok());

    let mut fallback: Option<String> = None;
    for m in items {
        // Movies carry name/year; tvSeries carries title/startYear. Read both.
        let name = m
            .get("name")
            .or_else(|| m.get("title"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let m_year = m
            .get("year")
            .or_else(|| m.get("startYear"))
            .and_then(|v| v.as_i64());
        let url = m.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let slug = url.trim_start_matches(url_prefix);
        if slug.is_empty() || normalize(name) != want_title {
            continue;
        }
        match (want_year, m_year) {
            // ±1 year tolerance: RT and TMDB disagree on festival/wide release years.
            (Some(wy), Some(my)) if (wy - my).abs() <= 1 => return Some(slug.to_string()),
            (None, _) => return Some(slug.to_string()),
            _ => {
                if fallback.is_none() {
                    fallback = Some(slug.to_string());
                }
            }
        }
    }
    fallback
}

/// Fetch /{prefix}/{slug} and run the extraction strategy chain.
async fn scrape_page(client: &Client, slug: &str, prefix: &str) -> Option<RtScores> {
    let url = format!("https://www.rottentomatoes.com/{prefix}/{slug}");
    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let html = resp.text().await.ok()?;

    let audience = extract_score(&html, "\"audienceScore\"")
        .or_else(|| extract_attr_score(&html, "audiencescore=\""));

    if audience.is_none() {
        // The page exists but no strategy matched — either the title genuinely
        // has no audience score yet, or RT changed their markup. Logged so a
        // scraper breakage is diagnosable instead of silently looking like
        // "RT doesn't have it" for everything.
        eprintln!("rt: /{prefix}/{slug} loaded but no audience score extracted");
    }

    audience.map(|_| RtScores {
        audience,
        slug: slug.to_string(),
    })
}

/// Strategy 1: find `"audienceScore"` / `"criticsScore"` JSON keys and pull the
/// first `"score"` within the following object. Tolerates quoted and unquoted
/// numbers and ignores surrounding shape changes.
fn extract_score(html: &str, key: &str) -> Option<u8> {
    let start = html.find(key)?;
    let window = &html[start..(start + 400).min(html.len())];
    let score_pos = window.find("\"score\"")?;
    let after = &window[score_pos + 7..];
    parse_leading_score(after)
}

/// Strategy 2: web-component attribute, e.g. `audiencescore="93"`.
fn extract_attr_score(html: &str, attr: &str) -> Option<u8> {
    let start = html.find(attr)? + attr.len();
    parse_leading_score(&html[start..])
}

/// Parse the first integer in a string, skipping `:`, quotes, and whitespace.
/// Returns None for values that can't be a percentage.
fn parse_leading_score(s: &str) -> Option<u8> {
    let trimmed = s.trim_start_matches([':', '"', ' ', '\t', '\n', '\r']);
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    let n: u32 = digits.parse().ok()?;
    if n <= 100 { Some(n as u8) } else { None }
}

fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// RT-style slug: lowercase, alphanumerics, underscores.
fn slugify(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_")
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_string()
            } else {
                c.to_string()
                    .bytes()
                    .map(|b| format!("%{:02X}", b))
                    .collect()
            }
        })
        .collect()
}
