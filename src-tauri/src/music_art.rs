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
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

/// Synthetic cached_images key for an artist's fetched images (artists have
/// no reliable folder of their own — feature-only artists have none at all).
pub(crate) fn artist_fetch_rel(artist_id: i64) -> String {
    format!("_fetched/artists/{artist_id}")
}

fn art_client() -> Result<reqwest::Client, String> {
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

/// Enrichment phase: fetch images for every artist that has none. Attempts
/// are stamped (found/notfound) so settled artists aren't re-queried every
/// pass; transient errors stay unstamped and retry. Honors the shared
/// skip-remaining flag via `cancelled`.
pub async fn fetch_artist_images(
    app: &AppHandle,
    pool: &SqlitePool,
    library_id: &str,
    cancelled: impl Fn() -> bool,
) -> Result<usize, String> {
    let artists: Vec<(i64, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT a.id, a.title, a.folder_path, a.selected_cover, a.musicbrainz_id
         FROM artist a JOIN media_entry me ON me.id = a.id
         WHERE me.library_id = ?
           AND NOT EXISTS (SELECT 1 FROM artist_image_fetch f WHERE f.artist_id = a.id)
         ORDER BY a.sort_title COLLATE NOCASE",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if artists.is_empty() {
        return Ok(0);
    }

    let client = art_client()?;
    let cache_base = app.state::<AppState>().app_data_dir.join("cache").join(library_id);
    let total = artists.len();
    let mut fetched = 0usize;
    for (i, (artist_id, title, folder_path, selected_cover, mbid)) in artists.into_iter().enumerate() {
        if cancelled() {
            break;
        }
        let _ = app.emit(
            "music-enrich-progress",
            serde_json::json!({ "phase": "artist-images", "done": i, "total": total, "name": title }),
        );
        if artist_has_image(pool, library_id, artist_id, &folder_path, selected_cover.as_deref()).await? {
            stamp(pool, artist_id, "has-own").await?;
            continue;
        }
        match fetch_one(pool, library_id, &cache_base, &client, artist_id, &title, mbid.as_deref()).await {
            Ok(Some(source)) => {
                fetched += 1;
                stamp(pool, artist_id, source).await?;
            }
            Ok(None) => stamp(pool, artist_id, "notfound").await?,
            // Transient (network, rate limiting) — unstamped, retried later.
            Err(e) => eprintln!("artist image fetch '{title}': {e}"),
        }
        // Politeness gap for Wikidata/Deezer (no hard limit, but be gentle).
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Ok(fetched)
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
