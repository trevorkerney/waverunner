//! Band membership, from MusicBrainz's "member of band" relationships —
//! read for identified artists and stored by MBID, so a group's page can
//! name its members and a member's page its groups. A lens beside the
//! credits, never a change to them: track and album credits stay exactly
//! as MusicBrainz has them (Highwayman stays one credit, The Highwaymen
//! "credited as" the four names), and a group's albums stay the group's — a
//! member's page lists them in a section of their own, never in the
//! member's counts (user's calls, 2026-09-27).
//!
//! MusicBrainz has no lineup objects. Each person↔group pair is one
//! relationship with optional begin/end dates, an `ended` flag and
//! attributes (instrument, vocals, "original"); a stint that ended and
//! resumed is two rows (Slash in Guns N' Roses 1985–1996 and 2016–). Member
//! rows often carry no dates at all (The Highwaymen's four), so the group's
//! own life span is kept on its fetch stamp: a group that has ended has no
//! current members. Dates are optional everywhere and shown where they are.
//!
//! One request per identified artist, once: a person's forward rels name
//! their groups, a group's backward rels name its members, and both land in
//! the same table (the relationship is one fact seen from either end).
//! Fetched in the matching pass's credit-harvest phase (folded in there
//! rather than a map step of its own — user's call) and right after a user
//! matches an artist, so the page shows it at once; a stamp older than
//! REFRESH_DAYS is fetched again by the next pass. Members the library has
//! are links, absent ones stay muted names.

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

/// A pass refetches memberships stamped longer ago than this.
const REFRESH_DAYS: i64 = 30;

/// One name on a page's membership line: a member of this group, or a
/// group this artist is in — the same shape either way.
#[derive(Debug, Clone, Serialize)]
pub struct MemberView {
    pub name: String,
    pub mbid: String,
    /// The library's page for them, when it has one (linkable).
    pub artist_id: Option<i64>,
    pub begin: Option<String>,
    pub end: Option<String>,
    /// Left, or the group itself has ended.
    pub former: bool,
    /// MusicBrainz's attributes on the stint: instruments, "original"…
    pub attributes: Vec<String>,
}

pub struct FetchedRow {
    pub group_mbid: String,
    pub group_name: String,
    pub member_mbid: String,
    pub member_name: String,
    pub begin: Option<String>,
    pub end: Option<String>,
    pub ended: bool,
    pub attributes: Vec<String>,
}

/// One artist's relationships as MusicBrainz reports them.
pub struct Fetched {
    pub artist_type: Option<String>,
    pub life_begin: Option<String>,
    pub life_end: Option<String>,
    pub life_ended: bool,
    pub rows: Vec<FetchedRow>,
}

/// GET the artist with its artist-artist relationships and keep the
/// "member of band" ones, oriented as (group, member) whichever end this
/// artist is.
pub async fn fetch(client: &reqwest::Client, mbid: &str) -> Result<Fetched, String> {
    let url = url::Url::parse_with_params(
        &format!("https://musicbrainz.org/ws/2/artist/{mbid}"),
        &[("inc", "artist-rels"), ("fmt", "json")],
    )
    .map_err(|e| e.to_string())?;
    let resp = crate::music_mb::mb_get(client, url).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = |v: &serde_json::Value| v.as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
    let name = body["name"].as_str().unwrap_or("").to_string();
    let life = &body["life-span"];
    let mut rows = Vec::new();
    for rel in body["relations"].as_array().into_iter().flatten() {
        if rel["type"].as_str() != Some("member of band") {
            continue;
        }
        let other_id = rel["artist"]["id"].as_str().unwrap_or("");
        let other_name = rel["artist"]["name"].as_str().unwrap_or("");
        if other_id.is_empty() || other_name.is_empty() || name.is_empty() {
            continue;
        }
        let attributes: Vec<String> = rel["attributes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str().map(|s| s.to_string()))
            .collect();
        // forward: this artist is a member OF the related group;
        // backward: the related artist is a member of THIS group.
        let (group_mbid, group_name, member_mbid, member_name) =
            if rel["direction"].as_str() == Some("forward") {
                (other_id.to_string(), other_name.to_string(), mbid.to_string(), name.clone())
            } else {
                (mbid.to_string(), name.clone(), other_id.to_string(), other_name.to_string())
            };
        rows.push(FetchedRow {
            group_mbid,
            group_name,
            member_mbid,
            member_name,
            begin: text(&rel["begin"]),
            end: text(&rel["end"]),
            ended: rel["ended"].as_bool().unwrap_or(false),
            attributes,
        });
    }
    Ok(Fetched {
        artist_type: text(&body["type"]),
        life_begin: text(&life["begin"]),
        life_end: text(&life["end"]),
        life_ended: life["ended"].as_bool().unwrap_or(false),
        rows,
    })
}

/// Replace every row this artist takes part in with what the fetch says
/// (the relationship is the same fact from either end, so the other side's
/// earlier rows are simply restated), and stamp the artist.
pub async fn store(pool: &SqlitePool, mbid: &str, fetched: &Fetched) -> Result<(), String> {
    sqlx::query("DELETE FROM mb_membership WHERE group_mbid = ? OR member_mbid = ?")
        .bind(mbid)
        .bind(mbid)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    for r in &fetched.rows {
        sqlx::query(
            "INSERT OR REPLACE INTO mb_membership
               (group_mbid, member_mbid, stint, group_name, member_name, begin_date, end_date, ended, attributes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&r.group_mbid)
        .bind(&r.member_mbid)
        .bind(r.begin.clone().unwrap_or_default())
        .bind(&r.group_name)
        .bind(&r.member_name)
        .bind(&r.begin)
        .bind(&r.end)
        .bind(r.ended as i64)
        .bind(serde_json::to_string(&r.attributes).unwrap_or_else(|_| "[]".to_string()))
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    sqlx::query(
        "INSERT INTO mb_membership_fetch (artist_mbid, artist_type, life_begin, life_end, life_ended, fetched_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(artist_mbid) DO UPDATE SET
           artist_type = excluded.artist_type, life_begin = excluded.life_begin,
           life_end = excluded.life_end, life_ended = excluded.life_ended,
           fetched_at = excluded.fetched_at",
    )
    .bind(mbid)
    .bind(&fetched.artist_type)
    .bind(&fetched.life_begin)
    .bind(&fetched.life_end)
    .bind(fetched.life_ended as i64)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The pass's membership sweep: every identified artist in the library
/// without a fresh stamp, one request each, skip-remaining on cancel like
/// every other phase. A fetch that fails is logged and left unstamped for
/// the next pass; a store failure is a database error and fails the phase.
pub(crate) async fn harvest(
    app: &AppHandle,
    pool: &SqlitePool,
    client: &reqwest::Client,
    library_id: &str,
) -> Result<usize, String> {
    let artists: Vec<(String, String)> = sqlx::query_as(
        "SELECT a.musicbrainz_id, MIN(a.title) FROM artist a
         JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?1 AND a.musicbrainz_id IS NOT NULL AND a.musicbrainz_id <> ''
           AND NOT EXISTS (SELECT 1 FROM mb_membership_fetch f
                           WHERE f.artist_mbid = a.musicbrainz_id
                             AND f.fetched_at > datetime('now', ?2))
         GROUP BY a.musicbrainz_id
         ORDER BY MIN(a.title) COLLATE NOCASE",
    )
    .bind(library_id)
    .bind(format!("-{REFRESH_DAYS} days"))
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    // Failed-request rows for artists no longer in this work are stale.
    let keep: Vec<String> = artists.iter().map(|(mbid, _)| mbid.clone()).collect();
    crate::music_mb::prune_fetch_failures(pool, library_id, "membership", &keep).await?;
    let total = artists.len();
    let mut fetched = 0usize;
    for (i, (mbid, title)) in artists.iter().enumerate() {
        if crate::music_mb::pass_cancelled() {
            break;
        }
        if crate::music_mb::is_placeholder_artist(mbid) {
            continue;
        }
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "libraryId": library_id, "phase": "memberships", "done": i, "total": total, "name": title }),
        );
        match fetch(client, mbid).await {
            Ok(f) => {
                store(pool, mbid, &f).await?;
                crate::music_mb::clear_fetch_failure(pool, "membership", mbid).await?;
                fetched += 1;
            }
            Err(e) => {
                eprintln!("membership fetch {title}: {e}");
                crate::music_mb::record_fetch_failure(
                    pool,
                    library_id,
                    "membership",
                    mbid,
                    &format!("Members of \u{201c}{title}\u{201d}"),
                    "memberships",
                    &e,
                )
                .await?;
            }
        }
    }
    Ok(fetched)
}

/// Has this group's life span ended, per its fetch stamp? Unknown (never
/// fetched) reads as no.
async fn life_ended(pool: &SqlitePool, mbid: &str) -> Result<bool, String> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT life_ended FROM mb_membership_fetch WHERE artist_mbid = ?")
            .bind(mbid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(matches!(row, Some((1,))))
}

async fn view(
    pool: &SqlitePool,
    library_id: &str,
    mbid: String,
    name: String,
    begin: Option<String>,
    end: Option<String>,
    former: bool,
    attributes_json: String,
) -> Result<MemberView, String> {
    let page: Option<(i64,)> = sqlx::query_as(
        "SELECT a.id FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ? AND a.musicbrainz_id = ? LIMIT 1",
    )
    .bind(library_id)
    .bind(&mbid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(MemberView {
        name,
        mbid,
        artist_id: page.map(|(id,)| id),
        begin,
        end,
        former,
        attributes: serde_json::from_str(&attributes_json).unwrap_or_default(),
    })
}

/// Names the library has a page for come first (they're the links — user's
/// call, 2026-09-27), then current before former, then by start year and
/// name.
fn sort_views(views: &mut [MemberView]) {
    views.sort_by(|a, b| {
        a.artist_id
            .is_none()
            .cmp(&b.artist_id.is_none())
            .then_with(|| a.former.cmp(&b.former))
            .then_with(|| a.begin.clone().unwrap_or_default().cmp(&b.begin.clone().unwrap_or_default()))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

type Row = (String, String, Option<String>, Option<String>, i64, String);

/// (this group's members, the groups this artist is in) — current first,
/// former after, each resolved to a library page where one exists. Empty
/// both ways for an unidentified artist.
pub async fn for_artist(
    pool: &SqlitePool,
    library_id: &str,
    mbid: Option<&str>,
) -> Result<(Vec<MemberView>, Vec<MemberView>), String> {
    let Some(mbid) = mbid.filter(|m| !m.is_empty()) else {
        return Ok((Vec::new(), Vec::new()));
    };
    let member_rows: Vec<Row> = sqlx::query_as(
        "SELECT member_mbid, member_name, begin_date, end_date, ended, attributes
         FROM mb_membership WHERE group_mbid = ?",
    )
    .bind(mbid)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let group_rows: Vec<Row> = sqlx::query_as(
        "SELECT group_mbid, group_name, begin_date, end_date, ended, attributes
         FROM mb_membership WHERE member_mbid = ?",
    )
    .bind(mbid)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let self_ended = life_ended(pool, mbid).await?;
    let mut members = Vec::with_capacity(member_rows.len());
    for (m_mbid, name, begin, end, ended, attrs) in member_rows {
        let former = ended != 0 || end.is_some() || self_ended;
        members.push(view(pool, library_id, m_mbid, name, begin, end, former, attrs).await?);
    }
    let mut groups = Vec::with_capacity(group_rows.len());
    for (g_mbid, name, begin, end, ended, attrs) in group_rows {
        let former = ended != 0 || end.is_some() || life_ended(pool, &g_mbid).await?;
        groups.push(view(pool, library_id, g_mbid, name, begin, end, former, attrs).await?);
    }
    sort_views(&mut members);
    sort_views(&mut groups);
    Ok((members, groups))
}
