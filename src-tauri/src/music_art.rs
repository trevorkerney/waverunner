//! Artist image fetching — Wikidata (by stored MBID) with a Deezer name-search
//! fallback. Keyless end to end, and NO MusicBrainz requests: Wikidata stores
//! MusicBrainz artist ids as its own property (P434), so the MBID we saved
//! during matching queries Wikidata directly — no 1-req/s crawl.
//!
//! Gap-fill only: artists that already have any image (folder art, a previous
//! fetch, a user-picked cover) are skipped. Fetched files live in the app
//! cache under a synthetic per-artist path (`_fetched/artists/<id>`), keyed in
//! cached_images with origin 'fetched' — the scan's folder-art sync only
//! manages origin 'library', so the two never fight, and folder art always
//! sorts first (fetched images are appended after it in every cover list).

use std::path::Path;

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// Synthetic cached_images key for an artist's fetched images (artists have
/// no reliable folder of their own — feature-only artists have none at all).
pub(crate) fn artist_fetch_rel(artist_id: i64) -> String {
    format!("_fetched/artists/{artist_id}")
}

pub(crate) fn art_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!(
            "waverunner/{} (https://github.com/trevorkerney/waverunner)",
            env!("CARGO_PKG_VERSION")
        ))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// Commons image URL for an artist via Wikidata's MusicBrainz-id property.
async fn wikidata_image_url(
    client: &reqwest::Client,
    mbid: &str,
) -> Result<Option<String>, String> {
    let query = format!(
        "SELECT ?img WHERE {{ ?a wdt:P434 \"{mbid}\". ?a wdt:P18 ?img }} LIMIT 1"
    );
    let url = url::Url::parse_with_params(
        "https://query.wikidata.org/sparql",
        &[("format", "json"), ("query", query.as_str())],
    )
    .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("wikidata HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let img = body["results"]["bindings"]
        .as_array()
        .and_then(|b| b.first())
        .and_then(|b| b["img"]["value"].as_str())
        .map(|s| {
            // Ask Commons for a bounded-width rendition instead of the
            // original (which can be a 40MB scan).
            let https = s.replacen("http://", "https://", 1);
            format!("{https}?width=1000")
        });
    Ok(img)
}

/// Deezer artist picture by exact (case-insensitive) name match — the
/// fallback for artists Wikidata has no photo for.
async fn deezer_image_url(
    client: &reqwest::Client,
    name: &str,
) -> Result<Option<String>, String> {
    let url = url::Url::parse_with_params(
        "https://api.deezer.com/search/artist",
        &[("q", name), ("limit", "5")],
    )
    .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("deezer HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| {
            a["name"]
                .as_str()
                .map(|n| n.eq_ignore_ascii_case(name))
                .unwrap_or(false)
        })
        .and_then(|a| a["picture_xl"].as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string()))
}

/// Download + cache one image for an artist (full-res + grid thumb), keyed
/// under the synthetic per-artist path with origin 'fetched'.
async fn store_artist_image(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
    artist_id: i64,
    client: &reqwest::Client,
    image_url: &str,
    source_filename: &str,
) -> Result<bool, String> {
    let resp = client.get(image_url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("image HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() < 1024 {
        return Ok(false); // error page / placeholder, not an image
    }

    let rel = artist_fetch_rel(artist_id);
    let cover_dir = cache_base.join(&rel).join("covers");
    let thumb_dir = cache_base.join(&rel).join("covers_thumb");
    std::fs::create_dir_all(&cover_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&thumb_dir).map_err(|e| e.to_string())?;
    let cached = cover_dir.join(source_filename);
    std::fs::write(&cached, &bytes).map_err(|e| e.to_string())?;
    let thumbed = image::load_from_memory(&bytes)
        .ok()
        .and_then(|img| img.thumbnail(600, 900).save(thumb_dir.join(source_filename)).ok())
        .is_some();
    if !thumbed {
        let _ = std::fs::copy(&cached, thumb_dir.join(source_filename));
    }
    sqlx::query(
        "INSERT OR REPLACE INTO cached_images
            (library_id, entry_folder_path, image_type, source_filename, cached_path, origin)
         VALUES (?, ?, 'cover', ?, ?, 'fetched')",
    )
    .bind(library_id)
    .bind(&rel)
    .bind(source_filename)
    .bind(cached.to_string_lossy().to_string())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Does this artist already have ANY image (folder art, fetched, selected)?
async fn artist_has_image(
    pool: &SqlitePool,
    library_id: &str,
    artist_id: i64,
    folder_path: &str,
    selected_cover: Option<&str>,
) -> Result<bool, String> {
    if selected_cover.map(|s| !s.is_empty()).unwrap_or(false) {
        return Ok(true);
    }
    let mut keys: Vec<String> = vec![artist_fetch_rel(artist_id)];
    if !folder_path.is_empty() {
        keys.push(folder_path.to_string());
    }
    for key in keys {
        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM cached_images WHERE library_id = ? AND entry_folder_path = ? AND image_type = 'cover' LIMIT 1",
        )
        .bind(library_id)
        .bind(&key)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if row.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Try Wikidata (by MBID) then Deezer (by name) for one artist. Returns the
/// source name that produced an image, if any.
async fn fetch_one(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
    client: &reqwest::Client,
    artist_id: i64,
    title: &str,
    mbid: Option<&str>,
) -> Result<Option<&'static str>, String> {
    if let Some(mbid) = mbid.filter(|m| !m.is_empty()) {
        if let Some(url) = wikidata_image_url(client, mbid).await? {
            if store_artist_image(pool, library_id, cache_base, artist_id, client, &url, "wikidata.jpg").await? {
                return Ok(Some("wikidata"));
            }
        }
    }
    if let Some(url) = deezer_image_url(client, title).await? {
        if store_artist_image(pool, library_id, cache_base, artist_id, client, &url, "deezer.jpg").await? {
            return Ok(Some("deezer"));
        }
    }
    Ok(None)
}

pub const IMAGE_JOB_KIND: &str = "artist-images";

/// Artist images as a BACKGROUND JOB (user's call 2026-09-20 — it used to
/// be the matching pass's last phase, which held the wizard open for
/// hundreds of Wikidata/Deezer round-trips that touch no MusicBrainz
/// budget). Same walk as before: every identified artist with no image and
/// no stamped attempt; attempts stamp found / notfound so settled artists
/// aren't re-queried, transient errors stay unstamped and retry next time.
/// The pass starts it at its end; it yields while a pass runs. No-op when
/// one is already going for this library (the caller just reattaches).
pub async fn start_artist_images_job(
    app: &AppHandle,
    pool: &SqlitePool,
    library_id: &str,
) -> Result<(), String> {
    // IDENTIFIED artists only: Wikidata needs the MBID, and the Deezer
    // fallback is a name search — a guess when the artist is unmatched (a
    // same-named stranger's face on an unidentified page). Unmatched artists
    // stay UNSTAMPED, so the walk after they're matched picks them up —
    // images are one more thing the match cascade unlocks.
    let artists: Vec<(i64, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT a.id, a.title, a.folder_path, a.selected_cover, a.musicbrainz_id
         FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?
           AND a.musicbrainz_id IS NOT NULL AND a.musicbrainz_id <> ''
           AND NOT EXISTS (SELECT 1 FROM artist_image_fetch f WHERE f.artist_id = a.id)
         ORDER BY a.sort_title COLLATE NOCASE",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if artists.is_empty() {
        return Ok(());
    }
    let total = artists.len();
    let Some(job) = crate::jobs::start(
        app,
        format!("{IMAGE_JOB_KIND}:{library_id}"),
        IMAGE_JOB_KIND,
        "fetching artist images",
        Some(library_id.to_string()),
        total,
    ) else {
        return Ok(()); // already running — reattach
    };
    let app = app.clone();
    let pool = pool.clone();
    let library_id = library_id.to_string();
    tauri::async_runtime::spawn(async move {
        let Ok(client) = art_client() else {
            job.finish();
            return;
        };
        let cache_base = app.state::<AppState>().app_data_dir.join("cache").join(&library_id);
        for (i, (artist_id, title, folder_path, selected_cover, mbid)) in artists.into_iter().enumerate() {
            if job.cancelled() {
                break;
            }
            // A matching pass rewrites the very rows this reads — wait it out.
            while crate::music_mb::pass_running() && !job.cancelled() {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            job.progress(i, total, Some(title.clone()));
            match artist_has_image(&pool, &library_id, artist_id, &folder_path, selected_cover.as_deref()).await {
                Ok(true) => {
                    let _ = stamp(&pool, artist_id, "has-own").await;
                    continue;
                }
                Ok(false) => {}
                Err(e) => {
                    eprintln!("artist image check '{title}': {e}");
                    continue;
                }
            }
            match fetch_one(&pool, &library_id, &cache_base, &client, artist_id, &title, mbid.as_deref()).await {
                Ok(Some(source)) => {
                    let _ = stamp(&pool, artist_id, source).await;
                }
                Ok(None) => {
                    let _ = stamp(&pool, artist_id, "notfound").await;
                }
                // Transient (network, rate limiting) — unstamped, retried later.
                Err(e) => eprintln!("artist image fetch '{title}': {e}"),
            }
            // Politeness gap for Wikidata/Deezer (no hard limit, but be gentle).
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        job.progress(total, total, None);
        job.finish();
    });
    Ok(())
}

/// Start (or reattach to) the image walk by hand.
#[tauri::command]
pub async fn artist_images_start(
    app: AppHandle,
    state: State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    start_artist_images_job(&app, &state.app_db, &library_id).await
}

async fn stamp(pool: &SqlitePool, artist_id: i64, status: &str) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO artist_image_fetch (artist_id, status) VALUES (?, ?)")
        .bind(artist_id)
        .bind(status)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Explicit per-artist fetch (the artist editor's button): clears the stamp
/// and any previously fetched image, then fetches fresh — even if the artist
/// already has folder art (the fetched image joins the cover list; folder art
/// still sorts first unless the user selects otherwise).
#[tauri::command]
pub async fn music_fetch_artist_image(
    app: AppHandle,
    state: State<'_, AppState>,
    artist_id: i64,
) -> Result<bool, String> {
    let pool = &state.app_db;
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT me.library_id, a.title, a.musicbrainz_id
         FROM artist a JOIN media_entry me ON me.id = a.id WHERE a.id = ?",
    )
    .bind(artist_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((library_id, title, mbid)) = row else {
        return Err("Artist not found".to_string());
    };

    sqlx::query("DELETE FROM artist_image_fetch WHERE artist_id = ?")
        .bind(artist_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    purge_artist_images(pool, &library_id, &state.app_data_dir.join("cache").join(&library_id), artist_id)
        .await?;

    let client = art_client()?;
    let cache_base = app.state::<AppState>().app_data_dir.join("cache").join(&library_id);
    let found = fetch_one(pool, &library_id, &cache_base, &client, artist_id, &title, mbid.as_deref()).await?;
    stamp(pool, artist_id, found.unwrap_or("notfound")).await?;
    Ok(found.is_some())
}

#[derive(serde::Serialize)]
pub struct CaaImage {
    /// 250px thumbnail for the picker grid.
    pub thumb: String,
    /// Full image, downloaded on pick.
    pub url: String,
    pub front: bool,
    /// CAA image types ("Front", "Back", "Booklet", "Medium", …).
    pub types: Vec<String>,
    pub comment: String,
}

#[derive(serde::Serialize)]
pub struct CaaBrowse {
    /// The album has a MusicBrainz release group id.
    pub group_matched: bool,
    /// The release being browsed has its own pinned MB release.
    pub release_pinned: bool,
    /// The group's canonical front cover — CAA serves exactly ONE image for
    /// a release group (the designated release's front).
    pub group: Vec<CaaImage>,
    /// The pinned release's full scan set (front/back/booklet/…); empty when
    /// unpinned or CAA holds nothing for that release.
    pub release: Vec<CaaImage>,
}

async fn caa_fetch(client: &reqwest::Client, path: &str) -> Result<Vec<CaaImage>, String> {
    let resp = client
        .get(format!("https://coverartarchive.org/{path}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().as_u16() == 404 {
        return Ok(Vec::new()); // no art on CAA — a state, not an error
    }
    if !resp.status().is_success() {
        return Err(format!("Cover Art Archive: HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let https = |s: &str| s.replacen("http://", "https://", 1);
    Ok(body["images"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|img| {
            let url = img["image"].as_str()?;
            let thumb = img["thumbnails"]["250"]
                .as_str()
                .or_else(|| img["thumbnails"]["small"].as_str())
                .unwrap_or(url);
            Some(CaaImage {
                thumb: https(thumb),
                url: https(url),
                front: img["front"].as_bool().unwrap_or(false),
                types: img["types"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t.as_str().map(|s| s.to_string()))
                    .collect(),
                comment: img["comment"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect())
}

/// Full scan set for one MB release by mbid — the CAA browser's per-row
/// "all N images" expander for OTHER releases in the group.
#[tauri::command]
pub async fn caa_release_scans(release_mbid: String) -> Result<Vec<CaaImage>, String> {
    if !release_mbid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("Invalid release id".into());
    }
    let client = art_client()?;
    caa_fetch(&client, &format!("release/{release_mbid}")).await
}

/// Pixel size of one Cover Art Archive image, read from its header alone:
/// CAA's listing doesn't carry dimensions and full images run to several
/// MB, so this is a ranged GET for the first 64KB (streamed and cut off
/// there even if the host ignores Range) parsed for a JPEG SOF / PNG IHDR /
/// GIF screen descriptor. None = header not found in that window or an
/// unknown format — a blank in the UI, never an error to show.
#[tauri::command]
pub async fn caa_image_size(url: String) -> Result<Option<(u32, u32)>, String> {
    if !url.starts_with("https://coverartarchive.org/") && !url.starts_with("https://archive.org/") {
        return Err("Not a Cover Art Archive URL".into());
    }
    const HEAD_BYTES: usize = 64 * 1024;
    let client = art_client()?;
    let mut resp = client
        .get(&url)
        .header(reqwest::header::RANGE, format!("bytes=0-{}", HEAD_BYTES - 1))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let mut buf: Vec<u8> = Vec::with_capacity(HEAD_BYTES);
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        buf.extend_from_slice(&chunk);
        if buf.len() >= HEAD_BYTES {
            break;
        }
    }
    Ok(image_dimensions(&buf))
}

/// (width, height) from the leading bytes of a JPEG, PNG, or GIF.
fn image_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() >= 24 && b.starts_with(b"\x89PNG\r\n\x1a\n") {
        let w = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
        let h = u32::from_be_bytes([b[20], b[21], b[22], b[23]]);
        return Some((w, h));
    }
    if b.len() >= 10 && (b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")) {
        let w = u16::from_le_bytes([b[6], b[7]]) as u32;
        let h = u16::from_le_bytes([b[8], b[9]]) as u32;
        return Some((w, h));
    }
    if b.len() >= 4 && b[0] == 0xFF && b[1] == 0xD8 {
        // Walk the marker segments to the first SOFn (C0–CF minus C4/C8/CC),
        // whose payload is precision, height, width.
        let mut i = 2;
        while i + 4 <= b.len() {
            if b[i] != 0xFF {
                i += 1; // resync on stray bytes
                continue;
            }
            let marker = b[i + 1];
            if marker == 0xFF {
                i += 1; // fill byte
                continue;
            }
            if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
                i += 2; // standalone markers carry no length
                continue;
            }
            if marker == 0xD9 || marker == 0xDA {
                return None; // end of image / scan data before any SOF
            }
            let is_sof = (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
            if is_sof {
                if i + 9 > b.len() {
                    return None;
                }
                let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
                let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
                return Some((w, h));
            }
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            if len < 2 {
                return None;
            }
            i += 2 + len;
        }
    }
    None
}

#[cfg(test)]
mod dimension_tests {
    use super::image_dimensions;

    #[test]
    fn png_ihdr() {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.extend_from_slice(&[0, 0, 0, 13]);
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&1400u32.to_be_bytes());
        b.extend_from_slice(&1401u32.to_be_bytes());
        assert_eq!(image_dimensions(&b), Some((1400, 1401)));
    }

    #[test]
    fn jpeg_sof_after_app_segments() {
        let mut b = vec![0xFF, 0xD8];
        // APP0 segment, 16 bytes long (length includes itself).
        b.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        b.extend_from_slice(&[0u8; 14]);
        // SOF0: length 17, precision 8, height 600, width 800.
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        b.extend_from_slice(&600u16.to_be_bytes());
        b.extend_from_slice(&800u16.to_be_bytes());
        b.extend_from_slice(&[0u8; 10]);
        assert_eq!(image_dimensions(&b), Some((800, 600)));
    }

    #[test]
    fn truncated_before_sof_is_none() {
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF];
        b.extend_from_slice(&[0u8; 100]);
        assert_eq!(image_dimensions(&b), None);
        assert_eq!(image_dimensions(b"nope"), None);
    }

    #[test]
    fn gif_screen() {
        let mut b = b"GIF89a".to_vec();
        b.extend_from_slice(&300u16.to_le_bytes());
        b.extend_from_slice(&200u16.to_le_bytes());
        assert_eq!(image_dimensions(&b), Some((300, 200)));
    }
}

/// Cover Art Archive images for one release of an album — the CAA browser
/// modal's data. Group cover always (when group-matched); the release's own
/// full scan set too when its pressing is pinned. No MB API call (CAA is a
/// separate service with no rate gate), keyless.
#[tauri::command]
pub async fn caa_release_images(
    state: State<'_, AppState>,
    album_id: i64,
    release_id: Option<i64>,
) -> Result<CaaBrowse, String> {
    let pool = &state.app_db;
    let group_id = crate::music_mb::mb_id(pool, album_id, crate::music_mb::MB_RELEASE_GROUP)
        .await?
        .map(|(id, _)| id);
    let mut release_mbid: Option<String> = None;
    if let Some(rid) = release_id {
        let folder: Option<(String,)> =
            sqlx::query_as("SELECT folder_path FROM album_release WHERE id = ? AND album_id = ?")
                .bind(rid)
                .bind(album_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((folder,)) = folder {
            release_mbid = crate::music_mb::release_match_of(pool, album_id, &folder)
                .await?
                .map(|(v, _)| v)
                .filter(|v| !v.is_empty());
        }
    }
    if group_id.is_none() && release_mbid.is_none() {
        return Err("Match this album to MusicBrainz first".into());
    }

    let client = art_client()?;
    let release = match &release_mbid {
        Some(mbid) => caa_fetch(&client, &format!("release/{mbid}")).await?,
        None => Vec::new(),
    };
    let mut group = match &group_id {
        Some(id) => caa_fetch(&client, &format!("release-group/{id}")).await?,
        None => Vec::new(),
    };
    // The group's chosen front is often literally one of the pinned
    // release's scans — don't show the same file twice.
    group.retain(|g| !release.iter().any(|r| r.url == g.url));

    Ok(CaaBrowse {
        group_matched: group_id.is_some(),
        release_pinned: release_mbid.is_some(),
        group,
        release,
    })
}

/// Remove an artist's fetched images (rows + files). Called when the artist
/// is swept and by the explicit re-fetch.
pub(crate) async fn purge_artist_images(
    pool: &SqlitePool,
    library_id: &str,
    cache_base: &Path,
    artist_id: i64,
) -> Result<(), String> {
    let rel = artist_fetch_rel(artist_id);
    sqlx::query("DELETE FROM cached_images WHERE library_id = ? AND entry_folder_path = ?")
        .bind(library_id)
        .bind(&rel)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM artist_image_fetch WHERE artist_id = ?")
        .bind(artist_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(cache_base.join(&rel));
    Ok(())
}
