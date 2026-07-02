use crate::AppState;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

fn generate_sort_title(title: &str, language: &str) -> String {
    let articles: &[&str] = match language {
        "en" => &["the ", "a ", "an "],
        "fr" => &["le ", "la ", "les ", "l'", "un ", "une "],
        "de" => &["der ", "die ", "das ", "ein ", "eine "],
        "es" => &["el ", "la ", "los ", "las ", "un ", "una "],
        _ => &[],
    };
    let lower = title.to_lowercase();
    for article in articles {
        if lower.starts_with(article) {
            return lower[article.len()..].to_string();
        }
    }
    lower
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Library {
    pub id: String,
    pub name: String,
    /// Flat list of every source folder (movie + show), kind-agnostic — for display and file
    /// resolution. The per-folder movie/show tag lives in the library_path table; only the
    /// scanner needs it (see get_library_typed_paths).
    pub paths: Vec<String>,
    pub format: String,
    /// 'local' = read folders from disk. Future: 'jellyfin', 'plex', ... (client mode).
    pub source: String,
    pub default_sort_mode: String,
}

/// One tagged source folder of a library (a row of the library_path table).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryPath {
    pub path: String,
    /// "movie" | "show" — the scanner classifies everything under this folder as this kind.
    pub kind: String,
}

/// All source folders of a library, kind-agnostic (just the paths), in stored order.
/// Used everywhere file resolution happens — callers don't care about movie vs show.
async fn get_library_paths(
    app_db: &SqlitePool,
    library_id: &str,
) -> Result<Vec<String>, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT path FROM library_path WHERE library_id = ? ORDER BY sort_order, id",
    )
    .bind(library_id)
    .fetch_all(app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

/// Source folders WITH their movie/show tag, in stored order. For the rescan classifier
/// (deferred) — create-time scan reads the kind straight off the create_library argument.
#[allow(dead_code)]
async fn get_library_typed_paths(
    app_db: &SqlitePool,
    library_id: &str,
) -> Result<Vec<LibraryPath>, String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT path, kind FROM library_path WHERE library_id = ? ORDER BY sort_order, id",
    )
    .bind(library_id)
    .fetch_all(app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(path, kind)| LibraryPath { path, kind }).collect())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaEntry {
    pub id: i64,
    pub title: String,
    pub year: Option<String>,
    pub end_year: Option<String>,
    pub folder_path: String,
    pub parent_id: Option<i64>,
    pub entry_type: String,
    pub covers: Vec<String>,
    pub selected_cover: Option<String>,
    pub child_count: i64,
    pub season_display: Option<String>,
    pub collection_display: Option<String>,
    /// "as Walter White" — the person's character(s) in this title. Only set by
    /// get_entries_for_person; person-page cards show it instead of the usual subtitle.
    #[serde(default)]
    pub role_display: Option<String>,
    pub tmdb_id: Option<String>,
    /// Non-null only when this row represents a `media_link` inside a playlist view.
    /// Frontend uses it to offer "Remove from playlist".
    pub link_id: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EntriesResponse {
    pub entries: Vec<MediaEntry>,
    pub sort_mode: String,
    pub format: String,
    /// The active preset for this view's scope, or null. When non-null, the returned
    /// `entries` are already in the preset's saved order (with stale/extra items appended).
    pub selected_preset_id: Option<i64>,
    /// All presets saved at this scope, alpha of creation.
    pub presets: Vec<SortPresetSummary>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersonInfo {
    pub id: i64,
    pub name: String,
    pub image_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersonSummary {
    pub id: i64,
    pub name: String,
    pub image_path: Option<String>,
    /// Distinct titles credited in the requested role — a movie, or a whole
    /// show no matter how many episodes within it. Drives the "Most credited"
    /// ranking.
    pub work_count: i64,
    pub favorite: bool,
    /// D&C breakdown ("directed … · created …") — populated for the D&C page
    /// and, when non-empty, the all-people page.
    pub dc: Option<DirectorCreatorCounts>,
    /// Acting film/show split ("in 23 movies & 4 shows") — Actors page and,
    /// when non-empty, the all-people page.
    pub acting: Option<TitleCounts>,
    /// Composing film/show split ("scored 12 movies & 3 shows") — Composers
    /// page and, when non-empty, the all-people page.
    pub composing: Option<TitleCounts>,
}

/// Plain film/show split of a role's distinct titles. A show counts once no
/// matter the credit's level (show, season, or episode) or how many
/// characters/episodes were involved.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct TitleCounts {
    pub films: i64,
    pub shows: i64,
}

/// Buckets behind the D&C card subtitle ("directed 3 movies, 1 show & 9
/// episodes across 8 shows · created 2 shows"). Disjoint by title: each title counts
/// once, at the person's highest credit on it (created show > fully-directed
/// show > episode scatter; films are their own bucket) — mirroring the
/// precedence get_entries_for_person uses for per-work labels.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct DirectorCreatorCounts {
    pub films: i64,
    /// Shows where their episode credits cover every episode in the library.
    pub shows: i64,
    /// Episodes directed on shows below full coverage (and not created by them).
    pub episodes: i64,
    /// Distinct shows those scattered episodes span.
    pub episode_shows: i64,
    pub created: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CastInfo {
    pub id: i64,
    pub name: String,
    pub image_path: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MovieDetail {
    pub id: i64,
    pub tmdb_id: Option<String>,
    pub imdb_id: Option<String>,
    pub rotten_tomatoes_id: Option<String>,
    pub release_date: Option<String>,
    pub plot: Option<String>,
    pub tagline: Option<String>,
    pub runtime: Option<i64>,
    pub maturity_rating: Option<String>,
    pub genres: Vec<String>,
    pub directors: Vec<PersonInfo>,
    pub cast: Vec<CastInfo>,
    pub composers: Vec<PersonInfo>,
    pub studios: Vec<String>,
    pub keywords: Vec<String>,
    /// Backdrop for the detail-page hero (selected, or first cached).
    pub backdrop: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MovieDetailUpdate {
    pub tmdb_id: Option<String>,
    pub imdb_id: Option<String>,
    pub rotten_tomatoes_id: Option<String>,
    pub title: Option<String>,
    pub release_date: Option<String>,
    pub plot: Option<String>,
    pub tagline: Option<String>,
    pub runtime: Option<i64>,
    pub maturity_rating: Option<String>,
    pub genres: Option<Vec<String>>,
    pub directors: Option<Vec<String>>,
    pub cast: Option<Vec<CastUpdateInfo>>,
    pub composers: Option<Vec<String>>,
    pub studios: Option<Vec<String>>,
    pub keywords: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CastUpdateInfo {
    pub name: String,
    pub role: Option<String>,
    pub tmdb_id: Option<i64>,
    pub profile_path: Option<String>,
}


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersonUpdateInfo {
    pub name: String,
    pub tmdb_id: Option<i64>,
    pub profile_path: Option<String>,
}

/// Insert or find a person, using tmdb_id for matching when available.
/// Returns the person's database id.
async fn ensure_person(pool: &SqlitePool, name: &str, tmdb_id: Option<i64>) -> Result<i64, String> {
    if let Some(tid) = tmdb_id {
        // Check if person with this tmdb_id already exists
        let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM person WHERE tmdb_id = ?")
            .bind(tid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;

        if let Some((id,)) = existing {
            // Update name in case it changed on TMDB
            sqlx::query("UPDATE person SET name = ? WHERE id = ?")
                .bind(name)
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            return Ok(id);
        }

        // Check if person exists by name without tmdb_id (was manually added)
        let by_name: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM person WHERE name = ? AND tmdb_id IS NULL")
                .bind(name)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;

        if let Some((id,)) = by_name {
            // Attach tmdb_id to existing person
            sqlx::query("UPDATE person SET tmdb_id = ? WHERE id = ?")
                .bind(tid)
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            return Ok(id);
        }

        // Insert new person with tmdb_id
        let result = sqlx::query("INSERT INTO person (name, tmdb_id) VALUES (?, ?)")
            .bind(name)
            .bind(tid)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(result.last_insert_rowid())
    } else {
        // No tmdb_id — use name-based matching
        sqlx::query("INSERT OR IGNORE INTO person (name) VALUES (?)")
            .bind(name)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        let (id,): (i64,) = sqlx::query_as("SELECT id FROM person WHERE name = ? LIMIT 1")
            .bind(name)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(id)
    }
}

/// Max in-flight person-image tasks (each does one CDN fetch).
/// Image CDN is more permissive than the API, but keeping this bounded avoids
/// flooding the network on large applies.
const PROFILE_IMAGE_CONCURRENCY: usize = 8;

/// Download one TMDB profile image (from the provided `profile_path`) for every person
/// in `persons` that currently has none. Called after each apply_* command has finished
/// its DB work. Errors are logged and swallowed — apply itself shouldn't fail on image
/// downloads. Persons whose `profile_path` is None simply get no image.
async fn process_person_images(
    pool: &SqlitePool,
    app_data_dir: &Path,
    persons: Vec<(i64, i64, Option<String>)>, // (person_db_id, tmdb_id, profile_path)
) {
    if persons.is_empty() {
        return;
    }

    // Dedup: same person (by db id) may appear in multiple role lists of one apply.
    let mut seen = std::collections::HashSet::new();
    let persons: Vec<(i64, i64, Option<String>)> = persons
        .into_iter()
        .filter(|p| seen.insert(p.0))
        .collect();

    // Narrow to people who have zero images today AND whose TMDB entry includes a profile_path.
    let mut needs_images: Vec<(i64, i64, String)> = Vec::new();
    for (person_db_id, tmdb_id, profile_path) in &persons {
        let Some(path) = profile_path else { continue };
        if path.is_empty() { continue; }
        let count: Result<(i64,), _> = sqlx::query_as("SELECT COUNT(*) FROM person_image WHERE person_id = ?")
            .bind(person_db_id)
            .fetch_one(pool)
            .await;
        if let Ok((0,)) = count {
            needs_images.push((*person_db_id, *tmdb_id, path.clone()));
        }
    }
    if needs_images.is_empty() {
        return;
    }

    let cache_dir = app_data_dir.join("people_images");
    if std::fs::create_dir_all(&cache_dir).is_err() {
        return;
    }

    let client = reqwest::Client::new();

    // Fan out with bounded concurrency. Each task is one CDN fetch + DB write.
    use futures::stream::StreamExt;
    futures::stream::iter(needs_images.into_iter().map(|(person_db_id, tmdb_id, profile_path)| {
        let pool = pool.clone();
        let client = client.clone();
        let cache_dir = cache_dir.clone();
        async move {
            if let Err(e) = download_person_image(&pool, &client, &cache_dir, person_db_id, tmdb_id, &profile_path).await {
                eprintln!("person image download failed (tmdb_id={tmdb_id}): {e}");
            }
        }
    }))
    .buffer_unordered(PROFILE_IMAGE_CONCURRENCY)
    .for_each(|_| async {})
    .await;
}

async fn download_person_image(
    pool: &SqlitePool,
    client: &reqwest::Client,
    cache_dir: &Path,
    person_db_id: i64,
    tmdb_id: i64,
    profile_path: &str,
) -> Result<(), String> {
    let filename = format!("{}_0.jpg", tmdb_id);
    let local_path = cache_dir.join(&filename);

    // Skip CDN fetch if we already have this file on disk.
    if !local_path.exists() {
        let url = format!("https://image.tmdb.org/t/p/w185{}", profile_path);
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("CDN returned {}", resp.status()));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("read bytes: {e}"))?;
        std::fs::write(&local_path, &bytes).map_err(|e| format!("write file: {e}"))?;
    }

    sqlx::query(
        "INSERT OR IGNORE INTO person_image (person_id, filename, tmdb_path, sort_order) VALUES (?, ?, ?, ?)",
    )
    .bind(person_db_id)
    .bind(&filename)
    .bind(profile_path)
    .bind(0_i64)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Set image_path only if the person didn't already have one.
    sqlx::query("UPDATE person SET image_path = ? WHERE id = ? AND image_path IS NULL")
        .bind(local_path.to_string_lossy().to_string())
        .bind(person_db_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}", now)
}

/// Given a list of root paths and a relative folder_path, find which root contains it.
fn resolve_entry_root<'a>(paths: &'a [String], folder_path: &str) -> Option<&'a str> {
    for p in paths {
        if PathBuf::from(p).join(folder_path).exists() {
            return Some(p.as_str());
        }
    }
    None
}

#[tauri::command]
pub async fn get_settings(
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, String>, String> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM settings")
        .fetch_all(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().collect())
}

#[tauri::command]
pub async fn set_setting(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .bind(&key)
        .bind(&value)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn get_file_size(path: String) -> Result<u64, String> {
    tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

const GITHUB_RELEASES_API: &str =
    "https://api.github.com/repos/trevorkerney/waverunner/releases";

async fn resolve_update_endpoint(channel: &str) -> Result<String, String> {
    let client = reqwest::Client::new();

    if channel == "stable" {
        // /releases/latest only returns non-prerelease
        let release: serde_json::Value = client
            .get(format!("{GITHUB_RELEASES_API}/latest"))
            .header("User-Agent", "waverunner-updater")
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        extract_latest_json_url(&release)
    } else {
        // First release in the list is the most recent (including prereleases)
        let releases: Vec<serde_json::Value> = client
            .get(GITHUB_RELEASES_API)
            .header("User-Agent", "waverunner-updater")
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        let release = releases.first().ok_or("No releases found")?;
        extract_latest_json_url(release)
    }
}

fn extract_latest_json_url(release: &serde_json::Value) -> Result<String, String> {
    let assets = release["assets"]
        .as_array()
        .ok_or("No assets in release")?;
    assets
        .iter()
        .find(|a| a["name"].as_str() == Some("latest.json"))
        .and_then(|a| a["browser_download_url"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "latest.json not found in release assets".to_string())
}

#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let channel = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'release_channel'"
    )
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_else(|| "stable".to_string());

    let endpoint = resolve_update_endpoint(&channel).await?;
    let url: url::Url = endpoint.parse().map_err(|e| format!("invalid endpoint: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => Ok(Some(serde_json::json!({
            "version": update.version,
            "body": update.body,
        }))),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn download_and_install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let channel = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'release_channel'"
    )
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_else(|| "stable".to_string());

    let endpoint = resolve_update_endpoint(&channel).await?;
    let url: url::Url = endpoint.parse().map_err(|e| format!("invalid endpoint: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;

    let handle = app.clone();
    let mut downloaded: usize = 0;

    update
        .download_and_install(
            move |chunk_len, total| {
                downloaded += chunk_len;
                let _ = handle.emit(
                    "update-progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    paths: Vec<LibraryPath>,
    format: String,
    source: String,
) -> Result<Library, String> {
    if !matches!(format.as_str(), "video" | "music") {
        return Err(format!("Unsupported library format: {}", format));
    }
    if source != "local" {
        return Err(format!("Unsupported library source: {}", source));
    }
    if paths.is_empty() {
        return Err("At least one folder is required".to_string());
    }
    // Each folder's kind must be valid for the library format.
    let valid_kinds: &[&str] = match format.as_str() {
        "video" => &["movie", "show"],
        "music" => &["music"],
        _ => &[],
    };
    for lp in &paths {
        if !valid_kinds.contains(&lp.kind.as_str()) {
            return Err(format!("Invalid folder kind '{}' for a {} library", lp.kind, format));
        }
        if !PathBuf::from(&lp.path).exists() {
            return Err(format!("Path does not exist: {}", lp.path));
        }
    }

    let id = uuid_simple();

    let cache_base = state.app_data_dir.join("cache").join(&id);
    std::fs::create_dir_all(&cache_base).map_err(|e| e.to_string())?;

    let library = Library {
        id: id.clone(),
        name: name.clone(),
        paths: paths.iter().map(|lp| lp.path.clone()).collect(),
        format: format.clone(),
        source: source.clone(),
        default_sort_mode: "alpha".to_string(),
    };

    sqlx::query(
        "INSERT INTO library (id, name, format, source, default_sort_mode, creating) VALUES (?, ?, ?, ?, ?, 1)",
    )
    .bind(&library.id)
    .bind(&library.name)
    .bind(&library.format)
    .bind(&library.source)
    .bind(&library.default_sort_mode)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    // Store the tagged source folders (replaces the old library.paths JSON blob).
    for (i, lp) in paths.iter().enumerate() {
        sqlx::query("INSERT INTO library_path (library_id, path, kind, sort_order) VALUES (?, ?, ?, ?)")
            .bind(&id)
            .bind(&lp.path)
            .bind(&lp.kind)
            .bind(i as i64)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }

    state.cancel_creation.store(false, Ordering::SeqCst);
    let cancel = &state.cancel_creation;
    let pool = &state.app_db;

    let scan_result: Result<(), String> = async {
        match format.as_str() {
            "video" => {
                sqlx::query("DELETE FROM media_entry WHERE library_id = ?")
                    .bind(&id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                for lp in &paths {
                    let kind = if lp.kind == "show" { ScanKind::Show } else { ScanKind::Movie };
                    scan_video_library(&app, pool, &id, &PathBuf::from(&lp.path), &cache_base, kind, cancel).await.map_err(|e| e.to_string())?;
                }
            }
            "music" => {
                sqlx::query("DELETE FROM media_entry WHERE library_id = ?")
                    .bind(&id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                for lp in &paths {
                    scan_music_library(&app, pool, &id, &PathBuf::from(&lp.path), &cache_base, cancel).await.map_err(|e| e.to_string())?;
                }
            }
            _ => return Err(format!("Unsupported library format: {}", format)),
        }
        Ok(())
    }.await;

    match scan_result {
        Ok(()) => {
            sqlx::query("UPDATE library SET creating = 0 WHERE id = ?")
                .bind(&id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            Ok(library)
        }
        Err(e) => {
            delete_cache_for_library(&state.app_data_dir, &id);
            let _ = sqlx::query("DELETE FROM library WHERE id = ?")
                .bind(&id)
                .execute(&state.app_db)
                .await;
            if e.contains("cancelled") {
                Err("Library creation cancelled".to_string())
            } else {
                Err(e)
            }
        }
    }
}

#[tauri::command]
pub async fn cancel_library_creation(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.cancel_creation.store(true, Ordering::SeqCst);
    Ok(())
}

pub async fn cleanup_incomplete_libraries(
    app_data_dir: &Path,
    app_db: &sqlx::SqlitePool,
) -> Result<(), String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM library WHERE creating = 1",
    )
    .fetch_all(app_db)
    .await
    .map_err(|e| e.to_string())?;

    for (id,) in rows {
        delete_cache_for_library(app_data_dir, &id);
        let _ = sqlx::query("DELETE FROM library WHERE id = ?")
            .bind(&id)
            .execute(app_db)
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_libraries(state: tauri::State<'_, AppState>) -> Result<Vec<Library>, String> {
    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT id, name, format, source, default_sort_mode FROM library WHERE creating = 0 ORDER BY name",
    )
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    // Folders now live in library_path. Pull them all once and group by library_id so each
    // Library still carries its flat `paths` list (kind-agnostic) as before.
    let path_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT library_id, path FROM library_path ORDER BY sort_order, id",
    )
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let mut paths_by_lib: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (library_id, path) in path_rows {
        paths_by_lib.entry(library_id).or_default().push(path);
    }

    Ok(rows
        .into_iter()
        .map(|(id, name, format, source, default_sort_mode)| Library {
            paths: paths_by_lib.remove(&id).unwrap_or_default(),
            id,
            name,
            format,
            source,
            default_sort_mode,
        })
        .collect())
}

#[tauri::command]
pub async fn rename_library(
    state: tauri::State<'_, AppState>,
    library_id: String,
    new_name: String,
) -> Result<(), String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("Library name cannot be empty".to_string());
    }
    sqlx::query("UPDATE library SET name = ? WHERE id = ?")
        .bind(trimmed)
        .bind(&library_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_library(
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    let cache_dir = state.app_data_dir.join("cache").join(&library_id);
    if cache_dir.exists() {
        std::fs::remove_dir_all(&cache_dir).map_err(|e| {
            format!("Could not delete library cache: {}", e)
        })?;
    }

    // Purge presets scoped to anything inside this library before the cascade deletes their
    // owning rows. We scoop ids now since media_collection / media_playlist / etc. will be
    // gone by the time we're done.
    let library_collection_ids: Vec<(i64,)> = sqlx::query_as(
        "SELECT id FROM media_entry WHERE library_id = ? AND entry_type_id = (SELECT id FROM media_entry_type WHERE name = 'collection')",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let playlist_ids: Vec<(i64,)> = sqlx::query_as("SELECT id FROM media_playlist WHERE library_id = ?")
        .bind(&library_id)
        .fetch_all(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    let pl_collection_ids: Vec<(i64,)> = sqlx::query_as(
        "WITH RECURSIVE descendants(id) AS ( \
           SELECT mpc.id FROM media_playlist_collection mpc \
             JOIN media_playlist mp ON mpc.parent_playlist_id = mp.id \
             WHERE mp.library_id = ? \
           UNION ALL \
           SELECT c.id FROM media_playlist_collection c JOIN descendants d ON c.parent_collection_id = d.id \
         ) SELECT id FROM descendants",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let mut scope_keys: Vec<String> = vec![
        format!("lib-root:{}", library_id),
        format!("movies-only:{}", library_id),
        format!("shows-only:{}", library_id),
    ];
    scope_keys.extend(library_collection_ids.into_iter().map(|(id,)| format!("lib-coll:{id}")));
    scope_keys.extend(playlist_ids.into_iter().map(|(id,)| format!("pl-root:{id}")));
    scope_keys.extend(pl_collection_ids.into_iter().map(|(id,)| format!("pl-coll:{id}")));
    for sk in scope_keys {
        let _ = sqlx::query("DELETE FROM sort_preset WHERE scope_key = ?")
            .bind(sk)
            .execute(&state.app_db)
            .await;
    }

    sqlx::query("DELETE FROM library WHERE id = ?")
        .bind(&library_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Card subtitle for a show, e.g. "season 3" / "seasons 1–6" / "5 seasons".
/// Counts ONLY real seasons (season_number > 0); Specials (Season 0) are never
/// folded into the headline — mirrors Plex/Jellyfin. A show with nothing but
/// specials reads "specials". Expects `mef` (media_entry_full) in scope; used by
/// get_entries and search_entries.
const SEASON_DISPLAY_EXPR: &str = "\
    CASE WHEN mef.entry_type = 'show' THEN \
      (SELECT CASE \
        WHEN SUM(CASE WHEN s.season_number > 0 THEN 1 ELSE 0 END) = 0 THEN \
          CASE \
            WHEN SUM(CASE WHEN s.season_number = 0 THEN 1 ELSE 0 END) > 0 THEN 'specials' \
            WHEN COUNT(*) = 0 THEN NULL \
            WHEN COUNT(*) = 1 THEN '1 season' \
            ELSE COUNT(*) || ' seasons' \
          END \
        WHEN SUM(CASE WHEN s.season_number > 0 THEN 1 ELSE 0 END) = 1 \
          THEN 'season ' || MAX(CASE WHEN s.season_number > 0 THEN s.season_number END) \
        WHEN SUM(CASE WHEN s.season_number > 0 THEN 1 ELSE 0 END) = \
             (MAX(CASE WHEN s.season_number > 0 THEN s.season_number END) \
              - MIN(CASE WHEN s.season_number > 0 THEN s.season_number END) + 1) \
          THEN 'seasons ' || MIN(CASE WHEN s.season_number > 0 THEN s.season_number END) \
               || '\u{2013}' || MAX(CASE WHEN s.season_number > 0 THEN s.season_number END) \
        ELSE SUM(CASE WHEN s.season_number > 0 THEN 1 ELSE 0 END) || ' seasons' \
      END FROM season s WHERE s.show_id = mef.id) \
    END";

#[tauri::command]
pub async fn get_entries(
    state: tauri::State<'_, AppState>,
    library_id: String,
    parent_id: Option<i64>,
    entry_type_filter: Option<String>,
) -> Result<EntriesResponse, String> {
    // Validate entry_type_filter against the known set so we can safely interpolate it.
    let validated_type: Option<&'static str> = match entry_type_filter.as_deref() {
        None => None,
        Some("movie") => Some("movie"),
        Some("show") => Some("show"),
        Some("collection") => Some("collection"),
        Some(other) => return Err(format!("Invalid entry_type_filter: {}", other)),
    };

    let (format, _paths, default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;

    let mut covers_map = get_all_cached_covers(&state.app_db, &library_id)
        .await
        .map_err(|e| e.to_string())?;

    let result = match format.as_str() {
        "video" => {
            // Each sortable scope owns its own sort_mode and selected_preset_id:
            //  - movies-only / shows-only → library.{movies,shows}_sort_mode / _preset_id
            //  - library-root inside a collection → media_collection.sort_mode / selected_preset_id
            //  - library-root at null parent → library.default_sort_mode / library_root_selected_preset_id
            let (sort_mode, selected_preset_id, scope_key) = match validated_type {
                Some("movie") => {
                    let row: Option<(String, Option<i64>)> = sqlx::query_as(
                        "SELECT movies_sort_mode, movies_only_selected_preset_id FROM library WHERE id = ?",
                    )
                    .bind(&library_id)
                    .fetch_optional(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;
                    let (m, p) = row.unwrap_or_else(|| (default_sort_mode.clone(), None));
                    (m, p, format!("movies-only:{}", library_id))
                }
                Some("show") => {
                    let row: Option<(String, Option<i64>)> = sqlx::query_as(
                        "SELECT shows_sort_mode, shows_only_selected_preset_id FROM library WHERE id = ?",
                    )
                    .bind(&library_id)
                    .fetch_optional(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;
                    let (m, p) = row.unwrap_or_else(|| (default_sort_mode.clone(), None));
                    (m, p, format!("shows-only:{}", library_id))
                }
                _ => match parent_id {
                    Some(pid) => {
                        let row: Option<(String, Option<i64>)> = sqlx::query_as(
                            "SELECT sort_mode, selected_preset_id FROM media_collection WHERE id = ?",
                        )
                        .bind(pid)
                        .fetch_optional(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                        let (m, p) = row.unwrap_or_else(|| (default_sort_mode.clone(), None));
                        (m, p, format!("lib-coll:{}", pid))
                    }
                    None => {
                        let row: Option<(Option<i64>,)> = sqlx::query_as(
                            "SELECT library_root_selected_preset_id FROM library WHERE id = ?",
                        )
                        .bind(&library_id)
                        .fetch_optional(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                        let p = row.and_then(|(p,)| p);
                        (default_sort_mode.clone(), p, format!("lib-root:{}", library_id))
                    }
                },
            };

            // Available presets for this scope (shown in the sort dropdown).
            let presets: Vec<SortPresetSummary> = {
                let rows: Vec<(i64, String)> = sqlx::query_as(
                    "SELECT id, name FROM sort_preset WHERE scope_key = ? ORDER BY created_at ASC, id ASC",
                )
                .bind(&scope_key)
                .fetch_all(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
                rows.into_iter().map(|(id, name)| SortPresetSummary { id, name }).collect()
            };

            // Subquery: all years from a collection's descendants (movies + shows' episodes), recursing through nested collections
            let collection_child_years = "\
                WITH RECURSIVE coll_descendants(id) AS ( \
                  SELECT id FROM media_entry WHERE parent_id = mef.id \
                  UNION ALL \
                  SELECT me_d.id FROM media_entry me_d JOIN coll_descendants d ON me_d.parent_id = d.id \
                ) \
                SELECT SUBSTR(m2.release_date, 1, 4) as yr FROM movie m2 \
                  WHERE m2.id IN (SELECT id FROM coll_descendants) AND m2.release_date IS NOT NULL \
                UNION ALL \
                SELECT SUBSTR(e.release_date, 1, 4) as yr FROM episode e \
                  JOIN season s ON e.season_id = s.id \
                  WHERE s.show_id IN (SELECT id FROM coll_descendants) AND e.release_date IS NOT NULL";

            // Subquery: all years from a show's episodes
            let show_episode_years = "\
                SELECT SUBSTR(e.release_date, 1, 4) as yr FROM episode e \
                  JOIN season s ON e.season_id = s.id \
                  WHERE s.show_id = mef.id AND e.release_date IS NOT NULL";

            // Parallel full-date subqueries for date-based sorting
            let collection_child_dates = "\
                WITH RECURSIVE coll_descendants(id) AS ( \
                  SELECT id FROM media_entry WHERE parent_id = mef.id \
                  UNION ALL \
                  SELECT me_d.id FROM media_entry me_d JOIN coll_descendants d ON me_d.parent_id = d.id \
                ) \
                SELECT m2.release_date as dt FROM movie m2 \
                  WHERE m2.id IN (SELECT id FROM coll_descendants) AND m2.release_date IS NOT NULL \
                UNION ALL \
                SELECT e.release_date as dt FROM episode e \
                  JOIN season s ON e.season_id = s.id \
                  WHERE s.show_id IN (SELECT id FROM coll_descendants) AND e.release_date IS NOT NULL";
            let show_episode_dates = "\
                SELECT e.release_date as dt FROM episode e \
                  JOIN season s ON e.season_id = s.id \
                  WHERE s.show_id = mef.id AND e.release_date IS NOT NULL";
            let sort_date_expr = format!("\
                CASE \
                  WHEN mef.entry_type = 'movie' THEN mef.release_date \
                  WHEN mef.entry_type = 'show' THEN (SELECT MIN(dt) FROM ({show_episode_dates})) \
                  WHEN mef.entry_type = 'collection' THEN (SELECT MIN(dt) FROM ({collection_child_dates})) \
                END");

            let order_clause: String = match sort_mode.as_str() {
                "year" | "date" => format!("ORDER BY {sort_date_expr} ASC, mef.sort_title COLLATE NOCASE ASC"),
                "custom" => "ORDER BY mef.sort_order ASC, mef.sort_title COLLATE NOCASE ASC".to_string(),
                _ => "ORDER BY mef.sort_title COLLATE NOCASE ASC".to_string(),
            };

            let base_query = format!(
                "SELECT mef.id, mef.title, \
                 CASE \
                   WHEN mef.entry_type = 'movie' THEN SUBSTR(mef.release_date, 1, 4) \
                   WHEN mef.entry_type = 'show' THEN (SELECT MIN(yr) FROM ({show_episode_years})) \
                   WHEN mef.entry_type = 'collection' THEN (SELECT MIN(yr) FROM ({collection_child_years})) \
                 END as year, \
                 CASE \
                   WHEN mef.entry_type = 'show' THEN \
                     NULLIF((SELECT MAX(yr) FROM ({show_episode_years})), (SELECT MIN(yr) FROM ({show_episode_years}))) \
                   WHEN mef.entry_type = 'collection' THEN \
                     NULLIF((SELECT MAX(yr) FROM ({collection_child_years})), (SELECT MIN(yr) FROM ({collection_child_years}))) \
                 END as end_year, \
                 mef.folder_path, mef.parent_id, mef.entry_type, mef.selected_cover, \
                 CASE \
                   WHEN mef.entry_type = 'movie' THEN (SELECT tmdb_id FROM movie WHERE id = mef.id) \
                   WHEN mef.entry_type = 'show' THEN (SELECT CAST(tmdb_id AS TEXT) FROM show WHERE id = mef.id) \
                   ELSE NULL \
                 END as tmdb_id, \
                 (SELECT COUNT(*) FROM media_entry c WHERE c.parent_id = mef.id) as child_count, \
                 {SEASON_DISPLAY_EXPR} as season_display \
                 FROM media_entry_full mef"
            );
            // When entry_type_filter is set, return a flat list across the whole library
            // (parent_id is intentionally ignored — "all movies" means every movie, even nested ones).
            let where_clause: String = if let Some(t) = validated_type {
                format!("WHERE mef.library_id = ? AND mef.entry_type = '{t}'")
            } else if parent_id.is_some() {
                "WHERE mef.library_id = ? AND mef.parent_id = ?".to_string()
            } else {
                "WHERE mef.library_id = ? AND mef.parent_id IS NULL".to_string()
            };
            let query_str = format!("{base_query} {where_clause} {order_clause}");

            let rows: Vec<(i64, String, Option<String>, Option<String>, String, Option<i64>, String, Option<String>, Option<String>, i64, Option<String>)> = if validated_type.is_some() {
                sqlx::query_as(&query_str)
                    .bind(&library_id)
                    .fetch_all(&state.app_db)
                    .await
            } else if let Some(pid) = parent_id {
                sqlx::query_as(&query_str)
                    .bind(&library_id)
                    .bind(pid)
                    .fetch_all(&state.app_db)
                    .await
            } else {
                sqlx::query_as(&query_str)
                    .bind(&library_id)
                    .fetch_all(&state.app_db)
                    .await
            }
            .map_err(|e| e.to_string())?;

            let entries: Vec<MediaEntry> = rows
                .into_iter()
                .map(|(id, title, year, end_year, folder_path, parent_id, entry_type, selected_cover, tmdb_id, child_count, season_display)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry {
                        id,
                        title,
                        year,
                        end_year,
                        folder_path,
                        parent_id,
                        entry_type,
                        covers,
                        selected_cover,
                        child_count,
                        season_display,
                        collection_display: None,
                        role_display: None,
                        tmdb_id,
                        link_id: None,
                    }
                })
                .collect();

            // Compute collection_display for collection entries
            let mut entries = entries;
            for entry in &mut entries {
                if entry.entry_type == "collection" {
                    let counts: Option<(i64, i64)> = sqlx::query_as(
                        "WITH RECURSIVE descendants(id) AS ( \
                            SELECT id FROM media_entry WHERE parent_id = ? \
                            UNION ALL \
                            SELECT me.id FROM media_entry me JOIN descendants d ON me.parent_id = d.id \
                        ) \
                        SELECT \
                            COALESCE(SUM(CASE WHEN met.name = 'movie' THEN 1 ELSE 0 END), 0), \
                            COALESCE(SUM(CASE WHEN met.name = 'show' THEN 1 ELSE 0 END), 0) \
                        FROM descendants d \
                        JOIN media_entry me ON d.id = me.id \
                        JOIN media_entry_type met ON me.entry_type_id = met.id"
                    )
                    .bind(entry.id)
                    .fetch_optional(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;

                    if let Some((movies, shows)) = counts {
                        let mut parts = Vec::new();
                        if movies > 0 {
                            parts.push(if movies == 1 { "1 movie".to_string() } else { format!("{movies} movies") });
                        }
                        if shows > 0 {
                            parts.push(if shows == 1 { "1 show".to_string() } else { format!("{shows} shows") });
                        }
                        // Always label collections; an empty one reads "empty" instead of blank.
                        entry.collection_display = Some(if parts.is_empty() { "empty".to_string() } else { parts.join(" and ") });
                    }
                }
            }

            // If a preset is active, reorder the entries to match its saved sequence.
            // Items not in the preset stay at the end in their existing sort_order.
            let entries = if sort_mode == "custom" {
                if let Some(pid) = selected_preset_id {
                    apply_library_preset_ordering(&state.app_db, pid, entries).await?
                } else {
                    entries
                }
            } else {
                entries
            };

            EntriesResponse {
                entries,
                sort_mode,
                format,
                selected_preset_id,
                presets,
            }
        }
        "music" => {
            let order_clause = match default_sort_mode.as_str() {
                "custom" => "ORDER BY mef.sort_order ASC, mef.sort_title COLLATE NOCASE ASC",
                _ => "ORDER BY mef.sort_title COLLATE NOCASE ASC",
            };

            let query_str = format!(
                "SELECT mef.id, mef.title, mef.folder_path, mef.selected_cover \
                 FROM media_entry_full mef \
                 WHERE mef.library_id = ? AND mef.parent_id IS NULL AND mef.entry_type = 'artist' {}",
                order_clause
            );

            let rows: Vec<(i64, String, String, Option<String>)> =
                sqlx::query_as(&query_str)
                    .bind(&library_id)
                    .fetch_all(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;

            let entries: Vec<MediaEntry> = rows
                .into_iter()
                .map(|(id, title, folder_path, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry {
                        id,
                        title,
                        year: None,
                        end_year: None,
                        folder_path,
                        parent_id: None,
                        entry_type: "artist".to_string(),
                        covers,
                        selected_cover,
                        child_count: 0,
                        season_display: None,
                        collection_display: None,
                        role_display: None,
                        tmdb_id: None,
                        link_id: None,
                    }
                })
                .collect();

            EntriesResponse {
                entries,
                sort_mode: default_sort_mode,
                format,
                selected_preset_id: None,
                presets: Vec::new(),
            }
        }
        _ => {
            return Err(format!("Unsupported library format: {}", format));
        }
    };

    Ok(result)
}

#[tauri::command]
pub async fn search_entries(
    state: tauri::State<'_, AppState>,
    library_id: String,
    parent_id: Option<i64>,
    query: String,
) -> Result<Vec<MediaEntry>, String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;

    let mut covers_map = get_all_cached_covers(&state.app_db, &library_id)
        .await
        .map_err(|e| e.to_string())?;

    let like_pattern = format!("%{}%", query);

    let entries = match format.as_str() {
        "video" => {
            let collection_child_years = "\
                WITH RECURSIVE coll_descendants(id) AS ( \
                  SELECT id FROM media_entry WHERE parent_id = mef.id \
                  UNION ALL \
                  SELECT me_d.id FROM media_entry me_d JOIN coll_descendants d ON me_d.parent_id = d.id \
                ) \
                SELECT SUBSTR(m2.release_date, 1, 4) as yr FROM movie m2 \
                  WHERE m2.id IN (SELECT id FROM coll_descendants) AND m2.release_date IS NOT NULL \
                UNION ALL \
                SELECT SUBSTR(e.release_date, 1, 4) as yr FROM episode e \
                  JOIN season s ON e.season_id = s.id \
                  WHERE s.show_id IN (SELECT id FROM coll_descendants) AND e.release_date IS NOT NULL";
            let show_episode_years = "\
                SELECT SUBSTR(e.release_date, 1, 4) as yr FROM episode e \
                  JOIN season s ON e.season_id = s.id \
                  WHERE s.show_id = mef.id AND e.release_date IS NOT NULL";
            let year_expr = format!("\
                CASE \
                  WHEN mef.entry_type = 'movie' THEN SUBSTR(mef.release_date, 1, 4) \
                  WHEN mef.entry_type = 'show' THEN (SELECT MIN(yr) FROM ({show_episode_years})) \
                  WHEN mef.entry_type = 'collection' THEN (SELECT MIN(yr) FROM ({collection_child_years})) \
                END");
            let end_year_expr = format!("\
                CASE \
                  WHEN mef.entry_type = 'show' THEN \
                    NULLIF((SELECT MAX(yr) FROM ({show_episode_years})), (SELECT MIN(yr) FROM ({show_episode_years}))) \
                  WHEN mef.entry_type = 'collection' THEN \
                    NULLIF((SELECT MAX(yr) FROM ({collection_child_years})), (SELECT MIN(yr) FROM ({collection_child_years}))) \
                END");
            let season_display_expr = SEASON_DISPLAY_EXPR;
            let query_str = match parent_id {
                Some(_) => format!("\
                    WITH RECURSIVE descendants(id) AS ( \
                        SELECT id FROM media_entry WHERE parent_id = ? \
                        UNION ALL \
                        SELECT me.id FROM media_entry me JOIN descendants d ON me.parent_id = d.id \
                    ) \
                    SELECT mef.id, mef.title, {year_expr} as year, {end_year_expr} as end_year, mef.folder_path, mef.parent_id, mef.entry_type, mef.selected_cover, \
                    CASE \
                      WHEN mef.entry_type = 'movie' THEN (SELECT tmdb_id FROM movie WHERE id = mef.id) \
                      WHEN mef.entry_type = 'show' THEN (SELECT CAST(tmdb_id AS TEXT) FROM show WHERE id = mef.id) \
                      ELSE NULL \
                    END as tmdb_id, \
                    {season_display_expr} as season_display \
                    FROM media_entry_full mef \
                    WHERE mef.library_id = ? AND mef.id IN (SELECT id FROM descendants) AND mef.title LIKE ? \
                    ORDER BY mef.sort_title COLLATE NOCASE ASC"),
                None => format!("\
                    SELECT mef.id, mef.title, {year_expr} as year, {end_year_expr} as end_year, mef.folder_path, mef.parent_id, mef.entry_type, mef.selected_cover, \
                    CASE \
                      WHEN mef.entry_type = 'movie' THEN (SELECT tmdb_id FROM movie WHERE id = mef.id) \
                      WHEN mef.entry_type = 'show' THEN (SELECT CAST(tmdb_id AS TEXT) FROM show WHERE id = mef.id) \
                      ELSE NULL \
                    END as tmdb_id, \
                    {season_display_expr} as season_display \
                    FROM media_entry_full mef \
                    WHERE mef.library_id = ? AND mef.title LIKE ? \
                    ORDER BY mef.sort_title COLLATE NOCASE ASC"),
            };

            let rows: Vec<(i64, String, Option<String>, Option<String>, String, Option<i64>, String, Option<String>, Option<String>, Option<String>)> = match parent_id {
                Some(pid) => {
                    sqlx::query_as(&query_str)
                        .bind(pid)
                        .bind(&library_id)
                        .bind(&like_pattern)
                        .fetch_all(&state.app_db)
                        .await
                }
                None => {
                    sqlx::query_as(&query_str)
                        .bind(&library_id)
                        .bind(&like_pattern)
                        .fetch_all(&state.app_db)
                        .await
                }
            }
            .map_err(|e| e.to_string())?;

            let mut entries: Vec<MediaEntry> = rows.into_iter()
                .map(|(id, title, year, end_year, folder_path, parent_id, entry_type, selected_cover, tmdb_id, season_display)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry { id, title, year, end_year, folder_path, parent_id, entry_type, covers, selected_cover, child_count: 0, season_display, collection_display: None, role_display: None, tmdb_id, link_id: None }
                })
                .collect();

            for entry in &mut entries {
                if entry.entry_type == "collection" {
                    let counts: Option<(i64, i64)> = sqlx::query_as(
                        "WITH RECURSIVE descendants(id) AS ( \
                            SELECT id FROM media_entry WHERE parent_id = ? \
                            UNION ALL \
                            SELECT me.id FROM media_entry me JOIN descendants d ON me.parent_id = d.id \
                        ) \
                        SELECT \
                            COALESCE(SUM(CASE WHEN met.name = 'movie' THEN 1 ELSE 0 END), 0), \
                            COALESCE(SUM(CASE WHEN met.name = 'show' THEN 1 ELSE 0 END), 0) \
                        FROM descendants d \
                        JOIN media_entry me ON d.id = me.id \
                        JOIN media_entry_type met ON me.entry_type_id = met.id"
                    )
                    .bind(entry.id)
                    .fetch_optional(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;

                    if let Some((movies, shows)) = counts {
                        let mut parts = Vec::new();
                        if movies > 0 {
                            parts.push(if movies == 1 { "1 movie".to_string() } else { format!("{movies} movies") });
                        }
                        if shows > 0 {
                            parts.push(if shows == 1 { "1 show".to_string() } else { format!("{shows} shows") });
                        }
                        // Always label collections; an empty one reads "empty" instead of blank.
                        entry.collection_display = Some(if parts.is_empty() { "empty".to_string() } else { parts.join(" and ") });
                    }
                }
            }

            entries
        }
        "music" => {
            let rows: Vec<(i64, String, String, Option<String>)> =
                sqlx::query_as(
                    "SELECT mef.id, mef.title, mef.folder_path, mef.selected_cover \
                     FROM media_entry_full mef \
                     WHERE mef.library_id = ? AND mef.entry_type = 'artist' AND mef.title LIKE ? \
                     ORDER BY mef.sort_title COLLATE NOCASE ASC",
                )
                .bind(&library_id)
                .bind(&like_pattern)
                .fetch_all(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;

            rows.into_iter()
                .map(|(id, title, folder_path, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry { id, title, year: None, end_year: None, folder_path, parent_id: None, entry_type: "artist".to_string(), covers, selected_cover, child_count: 0, season_display: None, collection_display: None, role_display: None, tmdb_id: None, link_id: None }
                })
                .collect()
        }
        _ => {
            return Err(format!("Unsupported library format: {}", format));
        }
    };

    Ok(entries)
}

/// All cached backdrops for an entry, in cache order.
async fn entry_backdrop_list(pool: &sqlx::SqlitePool, entry_id: i64) -> Result<Vec<String>, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT ci.cached_path FROM cached_images ci \
         JOIN media_entry_full mef ON mef.library_id = ci.library_id AND mef.folder_path = ci.entry_folder_path \
         WHERE mef.id = ? AND ci.image_type = 'backdrop' \
         ORDER BY ci.id",
    )
    .bind(entry_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

/// Backdrop to show on a detail page: the user-selected one if it still exists
/// in the cache, otherwise the first cached backdrop, if any.
async fn entry_backdrop(pool: &sqlx::SqlitePool, entry_id: i64) -> Result<Option<String>, String> {
    let all = entry_backdrop_list(pool, entry_id).await?;
    if all.is_empty() {
        return Ok(None);
    }
    let selected: Option<String> =
        sqlx::query_scalar("SELECT path FROM selected_backdrop WHERE entry_id = ?")
            .bind(entry_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(match selected {
        Some(s) if all.contains(&s) => Some(s),
        _ => all.into_iter().next(),
    })
}

#[tauri::command]
pub async fn get_backdrops(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
) -> Result<Vec<String>, String> {
    entry_backdrop_list(&state.app_db, entry_id).await
}

#[tauri::command]
pub async fn set_selected_backdrop(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
    path: String,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO selected_backdrop (entry_id, path) VALUES (?, ?) \
         ON CONFLICT(entry_id) DO UPDATE SET path = excluded.path",
    )
    .bind(entry_id)
    .bind(&path)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_movie_detail(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
) -> Result<MovieDetail, String> {

    // Movie scalar fields
    let movie_row: Option<(i64, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>, Option<i64>)> =
        sqlx::query_as(
            "SELECT id, tmdb_id, imdb_id, rotten_tomatoes_id, release_date, plot, tagline, runtime, maturity_rating_id FROM movie WHERE id = ?",
        )
        .bind(entry_id)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    let (id, tmdb_id, imdb_id, rotten_tomatoes_id, release_date, plot, tagline, runtime, maturity_rating_id) =
        movie_row.ok_or("Movie not found")?;

    // Maturity rating name
    let maturity_rating: Option<String> = if let Some(mr_id) = maturity_rating_id {
        let mr_row: Option<(String,)> = sqlx::query_as("SELECT name FROM maturity_rating WHERE id = ?")
            .bind(mr_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        mr_row.map(|(name,)| name)
    } else {
        None
    };

    // Genres
    let genre_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT g.name FROM movie_genre mg JOIN genre g ON mg.genre_id = g.id WHERE mg.movie_id = ? ORDER BY g.name",
    )
    .bind(entry_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let genres: Vec<String> = genre_rows.into_iter().map(|(n,)| n).collect();

    // Directors
    let director_rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path FROM movie_director md JOIN person p ON md.person_id = p.id WHERE md.movie_id = ? ORDER BY p.name",
    )
    .bind(entry_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let directors: Vec<PersonInfo> = director_rows.into_iter().map(|(id, name, image_path)| PersonInfo { id, name, image_path }).collect();

    // Cast
    let cast_rows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path, mc.role FROM movie_cast mc JOIN person p ON mc.person_id = p.id WHERE mc.movie_id = ? ORDER BY mc.sort_order",
    )
    .bind(entry_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let cast: Vec<CastInfo> = cast_rows.into_iter().map(|(id, name, image_path, role)| CastInfo { id, name, image_path, role }).collect();

    // Composers
    let composer_rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path FROM movie_composer mc JOIN person p ON mc.person_id = p.id WHERE mc.movie_id = ? ORDER BY p.name",
    )
    .bind(entry_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let composers: Vec<PersonInfo> = composer_rows.into_iter().map(|(id, name, image_path)| PersonInfo { id, name, image_path }).collect();

    // Studios
    let studio_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT s.name FROM movie_studio ms JOIN studio s ON ms.studio_id = s.id WHERE ms.movie_id = ? ORDER BY s.name",
    )
    .bind(entry_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let studios: Vec<String> = studio_rows.into_iter().map(|(n,)| n).collect();

    // Keywords
    let keyword_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT k.name FROM movie_keyword mk JOIN keyword k ON mk.keyword_id = k.id WHERE mk.movie_id = ? ORDER BY k.name",
    )
    .bind(entry_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let keywords: Vec<String> = keyword_rows.into_iter().map(|(n,)| n).collect();

    let backdrop = entry_backdrop(&state.app_db, entry_id).await?;

    Ok(MovieDetail {
        id,
        tmdb_id,
        imdb_id,
        rotten_tomatoes_id,
        release_date,
        plot,
        tagline,
        runtime,
        maturity_rating,
        genres,
        directors,
        cast,
        composers,
        studios,
        keywords,
        backdrop,
    })
}

#[tauri::command]
pub async fn update_movie_detail(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
    detail: MovieDetailUpdate,
) -> Result<(), String> {
    // Update movie title/year if provided
    if let Some(ref title) = detail.title {
        let sort_title = generate_sort_title(title, "en");
        sqlx::query("UPDATE movie SET title = ?, sort_title = ? WHERE id = ?")
            .bind(title)
            .bind(&sort_title)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref release_date) = detail.release_date {
        let val = if release_date.is_empty() { None } else { Some(release_date.as_str()) };
        sqlx::query("UPDATE movie SET release_date = ? WHERE id = ?")
            .bind(val)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Update movie scalar fields
    sqlx::query(
        "UPDATE movie SET tmdb_id = COALESCE(?, tmdb_id), imdb_id = COALESCE(?, imdb_id), \
         rotten_tomatoes_id = COALESCE(?, rotten_tomatoes_id), plot = COALESCE(?, plot), \
         tagline = COALESCE(?, tagline), runtime = COALESCE(?, runtime) WHERE id = ?",
    )
    .bind(&detail.tmdb_id)
    .bind(&detail.imdb_id)
    .bind(&detail.rotten_tomatoes_id)
    .bind(&detail.plot)
    .bind(&detail.tagline)
    .bind(&detail.runtime)
    .bind(entry_id)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    // Maturity rating
    if let Some(ref mr_name) = detail.maturity_rating {
        if mr_name.is_empty() {
            sqlx::query("UPDATE movie SET maturity_rating_id = NULL WHERE id = ?")
                .bind(entry_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        } else {
            sqlx::query("INSERT OR IGNORE INTO maturity_rating (name) VALUES (?)")
                .bind(mr_name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("UPDATE movie SET maturity_rating_id = (SELECT id FROM maturity_rating WHERE name = ?) WHERE id = ?")
                .bind(mr_name)
                .bind(entry_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Genres (delete + re-insert)
    if let Some(ref genres) = detail.genres {
        sqlx::query("DELETE FROM movie_genre WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for genre_name in genres {
            sqlx::query("INSERT OR IGNORE INTO genre (name) VALUES (?)")
                .bind(genre_name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_genre (movie_id, genre_id) VALUES (?, (SELECT id FROM genre WHERE name = ?))")
                .bind(entry_id)
                .bind(genre_name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Directors
    if let Some(ref directors) = detail.directors {
        sqlx::query("DELETE FROM movie_director WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for name in directors {
            sqlx::query("INSERT OR IGNORE INTO person (name) VALUES (?)")
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_director (movie_id, person_id) VALUES (?, (SELECT id FROM person WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Cast
    if let Some(ref cast) = detail.cast {
        sqlx::query("DELETE FROM movie_cast WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for (i, c) in cast.iter().enumerate() {
            sqlx::query("INSERT OR IGNORE INTO person (name) VALUES (?)")
                .bind(&c.name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_cast (movie_id, person_id, role, sort_order) VALUES (?, (SELECT id FROM person WHERE name = ?), ?, ?)")
                .bind(entry_id)
                .bind(&c.name)
                .bind(&c.role)
                .bind(i as i64)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Composers
    if let Some(ref composers) = detail.composers {
        sqlx::query("DELETE FROM movie_composer WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for name in composers {
            sqlx::query("INSERT OR IGNORE INTO person (name) VALUES (?)")
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT OR IGNORE INTO movie_composer (movie_id, person_id) VALUES (?, (SELECT id FROM person WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Studios
    if let Some(ref studios) = detail.studios {
        sqlx::query("DELETE FROM movie_studio WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for name in studios {
            sqlx::query("INSERT OR IGNORE INTO studio (name) VALUES (?)")
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_studio (movie_id, studio_id) VALUES (?, (SELECT id FROM studio WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Keywords
    if let Some(ref keywords) = detail.keywords {
        sqlx::query("DELETE FROM movie_keyword WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for name in keywords {
            sqlx::query("INSERT OR IGNORE INTO keyword (name) VALUES (?)")
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_keyword (movie_id, keyword_id) VALUES (?, (SELECT id FROM keyword WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

// ---------- TMDB ----------

#[tauri::command]
pub async fn search_tmdb_movie(
    state: tauri::State<'_, AppState>,
    query: String,
    year: Option<String>,
) -> Result<Vec<crate::tmdb::TmdbSearchResult>, String> {
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;

    if token.trim().is_empty() {
        return Err("TMDB API token is empty. Add one in settings.".to_string());
    }

    let client = reqwest::Client::new();
    let resp = crate::tmdb::search_movie(
        &client,
        &token,
        &query,
        year.as_deref(),
    )
    .await?;

    Ok(resp.results)
}

#[tauri::command]
pub async fn get_tmdb_movie_detail(
    state: tauri::State<'_, AppState>,
    tmdb_id: i64,
) -> Result<crate::tmdb::TmdbMovieDetail, String> {
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;

    let client = reqwest::Client::new();
    crate::tmdb::get_movie_detail(&client, &token, tmdb_id).await
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbFieldSelection {
    pub tmdb_id: Option<String>,
    pub imdb_id: Option<String>,
    pub plot: Option<String>,
    pub tagline: Option<String>,
    pub runtime: Option<i64>,
    pub release_date: Option<String>,
    pub maturity_rating: Option<String>,
    pub genres: Option<Vec<String>>,
    pub directors: Option<Vec<PersonUpdateInfo>>,
    pub cast: Option<Vec<CastUpdateInfo>>,
    pub composers: Option<Vec<PersonUpdateInfo>>,
    pub studios: Option<Vec<String>>,
    pub keywords: Option<Vec<String>>,
}

#[tauri::command]
pub async fn apply_tmdb_metadata(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
    fields: TmdbFieldSelection,
) -> Result<(), String> {
    // Collect (person_db_id, tmdb_id) for post-apply profile-image fetch.
    let mut new_people: Vec<(i64, i64, Option<String>)> = Vec::new();

    // Scalar fields on movie table — only write if provided (Some)
    if let Some(ref tmdb_id) = fields.tmdb_id {
        sqlx::query("UPDATE movie SET tmdb_id = ? WHERE id = ?")
            .bind(tmdb_id)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref imdb_id) = fields.imdb_id {
        sqlx::query("UPDATE movie SET imdb_id = ? WHERE id = ?")
            .bind(imdb_id)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref plot) = fields.plot {
        sqlx::query("UPDATE movie SET plot = ? WHERE id = ?")
            .bind(plot)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref tagline) = fields.tagline {
        sqlx::query("UPDATE movie SET tagline = ? WHERE id = ?")
            .bind(tagline)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(runtime) = fields.runtime {
        sqlx::query("UPDATE movie SET runtime = ? WHERE id = ?")
            .bind(runtime)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Release date on movie table
    if let Some(ref release_date) = fields.release_date {
        let val = if release_date.is_empty() { None } else { Some(release_date.as_str()) };
        sqlx::query("UPDATE movie SET release_date = ? WHERE id = ?")
            .bind(val)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Maturity rating
    if let Some(ref mr_name) = fields.maturity_rating {
        if mr_name.is_empty() {
            sqlx::query("UPDATE movie SET maturity_rating_id = NULL WHERE id = ?")
                .bind(entry_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        } else {
            sqlx::query("INSERT OR IGNORE INTO maturity_rating (name) VALUES (?)")
                .bind(mr_name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("UPDATE movie SET maturity_rating_id = (SELECT id FROM maturity_rating WHERE name = ?) WHERE id = ?")
                .bind(mr_name)
                .bind(entry_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Junction table fields — DELETE+INSERT (frontend only sends these when user approved)
    if let Some(ref genres) = fields.genres {
        sqlx::query("DELETE FROM movie_genre WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for name in genres {
            sqlx::query("INSERT OR IGNORE INTO genre (name) VALUES (?)")
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_genre (movie_id, genre_id) VALUES (?, (SELECT id FROM genre WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref directors) = fields.directors {
        sqlx::query("DELETE FROM movie_director WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for d in directors {
            let person_id = ensure_person(&state.app_db, &d.name, d.tmdb_id).await?;
            if let Some(tid) = d.tmdb_id { new_people.push((person_id, tid, d.profile_path.clone())); }
            sqlx::query("INSERT INTO movie_director (movie_id, person_id) VALUES (?, ?)")
                .bind(entry_id)
                .bind(person_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref cast) = fields.cast {
        sqlx::query("DELETE FROM movie_cast WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for (i, c) in cast.iter().enumerate() {
            let person_id = ensure_person(&state.app_db, &c.name, c.tmdb_id).await?;
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT INTO movie_cast (movie_id, person_id, role, sort_order) VALUES (?, ?, ?, ?)")
                .bind(entry_id)
                .bind(person_id)
                .bind(&c.role)
                .bind(i as i64)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref composers) = fields.composers {
        sqlx::query("DELETE FROM movie_composer WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for c in composers {
            let person_id = ensure_person(&state.app_db, &c.name, c.tmdb_id).await?;
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT OR IGNORE INTO movie_composer (movie_id, person_id) VALUES (?, ?)")
                .bind(entry_id)
                .bind(person_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref studios) = fields.studios {
        sqlx::query("DELETE FROM movie_studio WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for name in studios {
            sqlx::query("INSERT OR IGNORE INTO studio (name) VALUES (?)")
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_studio (movie_id, studio_id) VALUES (?, (SELECT id FROM studio WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref keywords) = fields.keywords {
        sqlx::query("DELETE FROM movie_keyword WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for name in keywords {
            sqlx::query("INSERT OR IGNORE INTO keyword (name) VALUES (?)")
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_keyword (movie_id, keyword_id) VALUES (?, (SELECT id FROM keyword WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    process_person_images(&state.app_db, &state.app_data_dir, new_people).await;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbImageDownload {
    pub file_path: String,  // TMDB path e.g. "/abc123.jpg"
    pub size: String,       // e.g. "w780", "original"
    pub image_type: String, // "cover" or "backdrop"
}

#[tauri::command]
pub async fn download_tmdb_images(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    images: Vec<TmdbImageDownload>,
) -> Result<(), String> {
    // Get entry folder_path from view
    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry_full WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path,) = entry_row.ok_or("Entry not found")?;

    // "Save artwork to source folders" (default on): downloaded covers/backdrops are written into
    // the media folder's covers/ and backdrops/ subdirs, so they travel with the media and are
    // re-read as library artwork on rescan. When off (or the source folder can't be resolved),
    // originals fall back to the app-data mirror, untouched media folders.
    let save_to_source = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = 'save_artwork_to_source'",
    )
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?
    .map(|v| v != "false")
    .unwrap_or(true);

    let app_base = app_images_base(&state.app_data_dir, &library_id);
    let source_root = if save_to_source {
        let lib_paths = get_library_paths(&state.app_db, &library_id).await?;
        resolve_entry_root(&lib_paths, &folder_path).map(PathBuf::from)
    } else {
        None
    };
    // Where originals land, and how the cache records their origin.
    let (base, origin): (PathBuf, &str) = match &source_root {
        Some(root) => (root.clone(), "library"),
        None => (app_base.clone(), "app"),
    };
    let full_entry_path = base.join(&folder_path);

    let client = reqwest::Client::new();
    let mut downloaded_covers = false;
    let mut downloaded_backdrops = false;

    for img in &images {
        let url = format!("https://image.tmdb.org/t/p/{}{}", img.size, img.file_path);
        // Derive filename: tmdb_{size}_{original_name}
        let original_name = img.file_path.trim_start_matches('/');
        let save_name = format!("tmdb_{}_{}", img.size, original_name);

        let (subdir, is_cover) = match img.image_type.as_str() {
            "cover" => ("covers", true),
            "backdrop" => ("backdrops", false),
            _ => continue,
        };

        let target_dir = full_entry_path.join(subdir);
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("Failed to create dir: {e}"))?;
        let target_path = target_dir.join(&save_name);

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed to download image: {e}"))?;

        if !resp.status().is_success() {
            continue; // skip failed downloads silently
        }

        let bytes = resp.bytes().await.map_err(|e| format!("Failed to read image data: {e}"))?;
        std::fs::write(&target_path, &bytes).map_err(|e| format!("Failed to save image: {e}"))?;

        if is_cover {
            downloaded_covers = true;
        } else {
            downloaded_backdrops = true;
        }
    }

    // Sync cached images for updated directories
    let cache_base = state.app_data_dir.join("cache").join(&library_id);

    if downloaded_covers {
        sync_cached_images_for_entry(
            &state.app_db, &library_id, &cache_base, &base, &folder_path, "covers", "cover", origin,
        )
        .await?;
    }
    if downloaded_backdrops {
        sync_cached_images_for_entry(
            &state.app_db, &library_id, &cache_base, &base, &folder_path, "backdrops", "backdrop", origin,
        )
        .await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn add_cover(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    source_path: String,
) -> Result<String, String> {
    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry_full WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path,) = entry_row.ok_or("Entry not found")?;

    // App-added covers never touch the media folders — originals live in app-data.
    // This also covers virtual collections, whose synthetic folder_path has no disk home.
    let app_base = app_images_base(&state.app_data_dir, &library_id);
    let target_dir = app_base.join(&folder_path).join("covers");
    let target_abs = copy_cover_into_dir(&source_path, &target_dir)?;
    let target_name = PathBuf::from(&target_abs)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    sync_cached_images_for_entry(
        &state.app_db, &library_id, &cache_base, &app_base, &folder_path, "covers", "cover", "app",
    )
    .await?;

    let cached_path: Option<(String,)> = sqlx::query_as(
        "SELECT cached_path FROM cached_images WHERE library_id = ? AND entry_folder_path = ? AND image_type = 'cover' AND source_filename = ?",
    )
    .bind(&library_id)
    .bind(&folder_path)
    .bind(&target_name)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;


    cached_path
        .map(|(p,)| p)
        .ok_or_else(|| "Cover added but cache path not found".into())
}

#[tauri::command]
pub async fn delete_cover(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    cover_path: String,
) -> Result<Option<String>, String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;

    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry_full WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path,) = entry_row.ok_or("Entry not found")?;

    let source_row: Option<(String, String)> = sqlx::query_as(
        "SELECT source_filename, origin FROM cached_images WHERE library_id = ? AND entry_folder_path = ? AND image_type = 'cover' AND cached_path = ?",
    )
    .bind(&library_id)
    .bind(&folder_path)
    .bind(&cover_path)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (source_filename, origin) = source_row.ok_or("Cover not found in cache")?;

    // waverunner never deletes files inside the media folders; only covers it added
    // itself (stored in app-data) can be removed from within the app.
    if origin != "app" {
        return Err(
            "This cover is a file in your library folder. waverunner doesn't modify library folders — remove the file there and rescan instead.".into(),
        );
    }

    let app_base = app_images_base(&state.app_data_dir, &library_id);
    let source_file = app_base.join(&folder_path).join("covers").join(&source_filename);

    if source_file.exists() {
        std::fs::remove_file(&source_file)
            .map_err(|e| format!("Failed to delete cover file: {e}"))?;
    }

    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    sync_cached_images_for_entry(
        &state.app_db, &library_id, &cache_base, &app_base, &folder_path, "covers", "cover", "app",
    )
    .await?;

    // Cascade: any playlist links pinning this exact cover path must drop the pin so the
    // UI falls back to the target's new selected_cover instead of rendering a stale path.
    sqlx::query("UPDATE media_link SET selected_cover = NULL WHERE selected_cover = ? AND target_entry_id = ?")
        .bind(&cover_path)
        .bind(entry_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    // Determine if the deleted cover was selected; if so pick a new one
    let current_selected: Option<String> = match format.as_str() {
        "video" => {
            let mut found: Option<Option<String>> = None;
            for table in ["movie", "show", "media_collection"] {
                let q = format!("SELECT selected_cover FROM {} WHERE id = ?", table);
                let r: Option<(Option<String>,)> = sqlx::query_as(&q)
                    .bind(entry_id)
                    .fetch_optional(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some((v,)) = r {
                    found = Some(v);
                    break;
                }
            }
            found.flatten()
        }
        "music" => {
            let r: Option<(Option<String>,)> = sqlx::query_as(
                "SELECT selected_cover FROM artist WHERE id = ?",
            )
            .bind(entry_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
            r.and_then(|(v,)| v)
        }
        _ => {
            return Err(format!("Unsupported library format: {}", format));
        }
    };
    let new_selected: Option<String> = if current_selected.as_deref() == Some(cover_path.as_str()) {
        let remaining: Option<(String,)> = sqlx::query_as(
            "SELECT cached_path FROM cached_images WHERE library_id = ? AND entry_folder_path = ? AND image_type = 'cover' LIMIT 1",
        )
        .bind(&library_id)
        .bind(&folder_path)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
        let new_val = remaining.map(|(p,)| p);

        match format.as_str() {
            "video" => {
                sqlx::query("UPDATE movie SET selected_cover = ? WHERE id = ?")
                    .bind(&new_val).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
                sqlx::query("UPDATE show SET selected_cover = ? WHERE id = ?")
                    .bind(&new_val).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
                sqlx::query("UPDATE media_collection SET selected_cover = ? WHERE id = ?")
                    .bind(&new_val).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            }
            "music" => {
                sqlx::query("UPDATE artist SET selected_cover = ? WHERE id = ?")
                    .bind(&new_val)
                    .bind(entry_id)
                    .execute(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            _ => {
                return Err(format!("Unsupported library format: {}", format));
            }
        }
        new_val
    } else {
        current_selected
    };

    Ok(new_selected)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SeasonInfo {
    pub id: i64,
    pub title: String,
    pub season_number: Option<i64>,
    pub sort_order: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EpisodeInfo {
    pub id: i64,
    pub title: String,
    pub episode_number: Option<i64>,
    /// Last episode covered by a multi-episode file (e.g. "S01E01-E02" → 2); NULL otherwise.
    pub episode_number_end: Option<i64>,
    pub file_path: String,
    pub sort_order: i64,
    /// Shown inline in the episode list (clamped) — full detail loads on expand.
    pub plot: Option<String>,
    pub runtime: Option<i64>,
    pub release_date: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ShowEpisodeFlat {
    pub episode_id: i64,
    pub season_id: i64,
    pub season_number: Option<i64>,
    pub episode_number: Option<i64>,
    pub title: String,
    pub file_path: String,
}

#[tauri::command]
pub async fn get_show_seasons(
    state: tauri::State<'_, AppState>,
    show_id: i64,
) -> Result<Vec<SeasonInfo>, String> {
    let rows: Vec<(i64, String, Option<i64>, i64)> = sqlx::query_as(
        // Order by the real season number, but force Specials (Season 0) to sort AFTER
        // the numbered seasons (Plex/Jellyfin convention), and any NULL-numbered season
        // last of all. sort_order is the final tiebreaker — it's only meaningfully
        // assigned by the initial scan, so rescan-added shows would otherwise scramble.
        "SELECT id, title, season_number, sort_order FROM season WHERE show_id = ? ORDER BY season_number IS NULL, season_number = 0, season_number, sort_order",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;


    Ok(rows
        .into_iter()
        .map(|(id, title, season_number, sort_order)| SeasonInfo {
            id,
            title,
            season_number,
            sort_order,
        })
        .collect())
}

#[tauri::command]
pub async fn get_season_episodes(
    state: tauri::State<'_, AppState>,
    season_id: i64,
) -> Result<Vec<EpisodeInfo>, String> {
    let rows: Vec<(i64, String, Option<i64>, Option<i64>, String, i64, Option<String>, Option<i64>, Option<String>)> = sqlx::query_as(
        // Order by real episode number (unnumbered episodes last, sort_order tiebreaker) — see get_show_seasons.
        "SELECT id, title, episode_number, episode_number_end, file_path, sort_order, plot, runtime, release_date FROM episode WHERE season_id = ? ORDER BY episode_number IS NULL, episode_number, sort_order",
    )
    .bind(season_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, title, episode_number, episode_number_end, file_path, sort_order, plot, runtime, release_date)| EpisodeInfo {
            id,
            title,
            episode_number,
            episode_number_end,
            file_path,
            sort_order,
            plot,
            runtime,
            release_date,
        })
        .collect())
}

#[tauri::command]
pub async fn get_show_episodes(
    state: tauri::State<'_, AppState>,
    show_id: i64,
) -> Result<Vec<ShowEpisodeFlat>, String> {
    let rows: Vec<(i64, i64, Option<i64>, Option<i64>, String, String)> = sqlx::query_as(
        "SELECT e.id, s.id, s.season_number, e.episode_number, e.title, e.file_path \
         FROM episode e JOIN season s ON e.season_id = s.id \
         WHERE s.show_id = ? \
         ORDER BY s.season_number IS NULL, s.season_number = 0, s.season_number, e.episode_number IS NULL, e.episode_number, e.sort_order",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;


    Ok(rows
        .into_iter()
        .map(|(episode_id, season_id, season_number, episode_number, title, file_path)| ShowEpisodeFlat {
            episode_id,
            season_id,
            season_number,
            episode_number,
            title,
            file_path,
        })
        .collect())
}

// ---------- Sidebar complications: people + custom collections ----------

// Builds the role-works CTE that maps person_id -> distinct (kind, eid) tuples a person contributed to,
// where eid is a movie.id or show.id. The result is suitable as a CTE prefix for both
// get_people_in_library (group by person) and get_entries_for_person (filter by person).
// Validated against a known set so the resulting SQL is safe to splice into a query string.
// The inner UNION query mapping person_id -> distinct (kind, eid) works for a role.
// Split out from role_works_cte so callers can name it themselves (e.g. combine a
// role-specific filter set with the all-roles counting set in one query).
fn role_works_body(role: &str) -> Result<&'static str, String> {
    match role {
        "actor" => Ok(
            "SELECT person_id, 'movie' AS kind, movie_id AS eid FROM movie_cast \
             UNION SELECT person_id, 'show', show_id FROM show_cast \
             UNION SELECT sec.person_id, 'show', ss.show_id \
                     FROM season_cast sec JOIN season ss ON sec.season_id = ss.id \
             UNION SELECT ec.person_id, 'show', ss.show_id \
                     FROM episode_cast ec \
                     JOIN episode e ON ec.episode_id = e.id \
                     JOIN season ss ON e.season_id = ss.id"
        ),
        "director_creator" => Ok(
            "SELECT person_id, 'movie' AS kind, movie_id AS eid FROM movie_director \
             UNION SELECT person_id, 'show', show_id FROM show_creator \
             UNION SELECT ed.person_id, 'show', ss.show_id \
                     FROM episode_director ed \
                     JOIN episode e ON ed.episode_id = e.id \
                     JOIN season ss ON e.season_id = ss.id"
        ),
        "composer" => Ok(
            "SELECT person_id, 'movie' AS kind, movie_id AS eid FROM movie_composer \
             UNION SELECT person_id, 'show', show_id FROM show_composer \
             UNION SELECT ec.person_id, 'show', ss.show_id \
                     FROM episode_composer ec \
                     JOIN episode e ON ec.episode_id = e.id \
                     JOIN season ss ON e.season_id = ss.id"
        ),
        // Union of every role — used by the top-level "People" sidebar node and
        // for person-detail pages (they show all works regardless of role).
        "all" => Ok(
            "SELECT person_id, 'movie' AS kind, movie_id AS eid FROM movie_cast \
             UNION SELECT person_id, 'show', show_id FROM show_cast \
             UNION SELECT sec.person_id, 'show', ss.show_id \
                     FROM season_cast sec JOIN season ss ON sec.season_id = ss.id \
             UNION SELECT ec.person_id, 'show', ss.show_id \
                     FROM episode_cast ec \
                     JOIN episode e ON ec.episode_id = e.id \
                     JOIN season ss ON e.season_id = ss.id \
             UNION SELECT person_id, 'movie', movie_id FROM movie_director \
             UNION SELECT person_id, 'show', show_id FROM show_creator \
             UNION SELECT ed.person_id, 'show', ss.show_id \
                     FROM episode_director ed \
                     JOIN episode e ON ed.episode_id = e.id \
                     JOIN season ss ON e.season_id = ss.id \
             UNION SELECT person_id, 'movie', movie_id FROM movie_composer \
             UNION SELECT person_id, 'show', show_id FROM show_composer \
             UNION SELECT ec.person_id, 'show', ss.show_id \
                     FROM episode_composer ec \
                     JOIN episode e ON ec.episode_id = e.id \
                     JOIN season ss ON e.season_id = ss.id"
        ),
        other => Err(format!("Invalid role: {}", other)),
    }
}

fn role_works_cte(role: &str) -> Result<String, String> {
    Ok(format!("WITH role_works AS ( {} )", role_works_body(role)?))
}

/// One genre used in a library, with how many movies/shows carry it.
#[derive(serde::Serialize)]
pub struct GenreSummary {
    pub name: String,
    pub count: i64,
}

/// Distinct genres across the library's movies and shows, alphabetised, each
/// with a count of works that carry it.
#[tauri::command]
pub async fn get_genres_in_library(
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<Vec<GenreSummary>, String> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT g.name, COUNT(*) AS cnt \
         FROM genre g \
         JOIN ( \
             SELECT genre_id, movie_id AS eid FROM movie_genre \
             UNION ALL \
             SELECT genre_id, show_id AS eid FROM show_genre \
         ) gx ON gx.genre_id = g.id \
         JOIN media_entry me ON me.id = gx.eid AND me.library_id = ? \
         GROUP BY g.id \
         ORDER BY g.name COLLATE NOCASE ASC",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(name, count)| GenreSummary { name, count })
        .collect())
}

/// Flat list of every movie/show in the library carrying `genre`, for the
/// genre drill-down grid. Mirrors the get_entries_for_person shape (alpha sort,
/// season_display so shows read right), minus the credit logic.
#[tauri::command]
pub async fn get_entries_for_genre(
    state: tauri::State<'_, AppState>,
    library_id: String,
    genre: String,
) -> Result<Vec<MediaEntry>, String> {
    let mut covers_map = get_all_cached_covers(&state.app_db, &library_id)
        .await
        .map_err(|e| e.to_string())?;

    let show_episode_years = "\
        SELECT SUBSTR(e.release_date, 1, 4) as yr FROM episode e \
          JOIN season s ON e.season_id = s.id \
          WHERE s.show_id = mef.id AND e.release_date IS NOT NULL";
    let season_display_expr = SEASON_DISPLAY_EXPR;
    let query = format!(
        "SELECT mef.id, mef.title, \
           CASE \
             WHEN mef.entry_type = 'movie' THEN SUBSTR(mef.release_date, 1, 4) \
             WHEN mef.entry_type = 'show' THEN (SELECT MIN(yr) FROM ({show_episode_years})) \
           END AS year, \
           CASE \
             WHEN mef.entry_type = 'show' THEN \
               NULLIF((SELECT MAX(yr) FROM ({show_episode_years})), (SELECT MIN(yr) FROM ({show_episode_years}))) \
           END AS end_year, \
           mef.folder_path, mef.parent_id, mef.entry_type, mef.selected_cover, \
           CASE \
             WHEN mef.entry_type = 'movie' THEN (SELECT tmdb_id FROM movie WHERE id = mef.id) \
             WHEN mef.entry_type = 'show' THEN (SELECT CAST(tmdb_id AS TEXT) FROM show WHERE id = mef.id) \
             ELSE NULL \
           END AS tmdb_id, \
           {season_display_expr} as season_display \
         FROM media_entry_full mef \
         WHERE mef.library_id = ? AND mef.id IN ( \
             SELECT mg.movie_id FROM movie_genre mg JOIN genre g ON mg.genre_id = g.id WHERE g.name = ? \
             UNION \
             SELECT sg.show_id FROM show_genre sg JOIN genre g ON sg.genre_id = g.id WHERE g.name = ? \
         ) \
         ORDER BY mef.sort_title COLLATE NOCASE ASC"
    );

    let rows: Vec<(i64, String, Option<String>, Option<String>, String, Option<i64>, String, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(&query)
            .bind(&library_id)
            .bind(&genre)
            .bind(&genre)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;

    let entries: Vec<MediaEntry> = rows
        .into_iter()
        .map(|(id, title, year, end_year, folder_path, parent_id, entry_type, selected_cover, tmdb_id, season_display)| {
            let covers = covers_map.remove(&folder_path).unwrap_or_default();
            MediaEntry {
                id,
                title,
                year,
                end_year,
                folder_path,
                parent_id,
                entry_type,
                covers,
                selected_cover,
                child_count: 0,
                season_display,
                collection_display: None,
                role_display: None,
                tmdb_id,
                link_id: None,
            }
        })
        .collect();

    Ok(entries)
}

/// Counts shown in parentheses on the sidebar nodes. Movies/shows are
/// library-scoped; the people counts mirror the (global) people views exactly,
/// so the number matches the list you land on when you click the node.
#[derive(serde::Serialize)]
pub struct LibraryCounts {
    pub movies: i64,
    pub shows: i64,
    pub genres: i64,
    pub people: i64,
    pub actors: i64,
    pub directors_creators: i64,
    pub composers: i64,
}

/// Distinct people contributing in `role`, mirroring `get_people_in_library`.
async fn count_people_in_role(db: &SqlitePool, role: &str) -> Result<i64, String> {
    let cte = role_works_cte(role)?;
    let query = format!("{cte} SELECT COUNT(DISTINCT rw.person_id) FROM role_works rw");
    let (n,): (i64,) = sqlx::query_as(&query)
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(n)
}

#[tauri::command]
pub async fn get_library_counts(
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<LibraryCounts, String> {
    let db = &state.app_db;

    let count_entries = "SELECT COUNT(*) FROM media_entry me \
         JOIN media_entry_type met ON me.entry_type_id = met.id \
         WHERE me.library_id = ? AND met.name = ?";
    let (movies,): (i64,) = sqlx::query_as(count_entries)
        .bind(&library_id)
        .bind("movie")
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
    let (shows,): (i64,) = sqlx::query_as(count_entries)
        .bind(&library_id)
        .bind("show")
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;

    // Distinct genres carried by this library's movies/shows — matches the
    // count of rows the Genres view shows.
    let (genres,): (i64,) = sqlx::query_as(
        "SELECT COUNT(DISTINCT gx.genre_id) FROM ( \
             SELECT genre_id, movie_id AS eid FROM movie_genre \
             UNION ALL \
             SELECT genre_id, show_id AS eid FROM show_genre \
         ) gx \
         JOIN media_entry me ON me.id = gx.eid AND me.library_id = ?",
    )
    .bind(&library_id)
    .fetch_one(db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(LibraryCounts {
        movies,
        shows,
        genres,
        people: count_people_in_role(db, "all").await?,
        actors: count_people_in_role(db, "actor").await?,
        directors_creators: count_people_in_role(db, "director_creator").await?,
        composers: count_people_in_role(db, "composer").await?,
    })
}

async fn get_library_meta(
    app_db: &SqlitePool,
    library_id: &str,
) -> Result<(String, Vec<String>, String), String> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT format, default_sort_mode FROM library WHERE id = ?",
    )
    .bind(library_id)
    .fetch_optional(app_db)
    .await
    .map_err(|e| e.to_string())?;
    let (format, sort_mode) = row.ok_or("Library not found")?;
    // paths live in the library_path table now; return the flat list so callers are unchanged.
    let paths = get_library_paths(app_db, library_id).await?;
    Ok((format, paths, sort_mode))
}

/// Per-person film/show split for one role, all people at once — the counting
/// behind "in 23 movies & 4 shows" / "scored 12 movies & 3 shows" on the
/// all-people page (the role pages get the same split from their main query).
async fn title_counts_for_role(
    db: &SqlitePool,
    role: &str,
) -> Result<std::collections::HashMap<i64, TitleCounts>, String> {
    let body = role_works_body(role)?;
    let query = format!(
        "WITH role_works AS ( {body} ) \
         SELECT person_id, \
                SUM(CASE WHEN kind = 'movie' THEN 1 ELSE 0 END) AS films, \
                SUM(CASE WHEN kind = 'show' THEN 1 ELSE 0 END) AS shows \
         FROM role_works \
         GROUP BY person_id"
    );
    let rows: Vec<(i64, i64, i64)> = sqlx::query_as(&query)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(pid, films, shows)| (pid, TitleCounts { films, shows }))
        .collect())
}

/// Per-person D&C subtitle buckets, computed for all people in one pass.
/// Each show lands in exactly one bucket at the person's highest credit:
/// created > fully-directed (episode coverage = every episode of the show in
/// the library, same derived semantics as get_entries_for_person's rollup) >
/// scattered episodes. Directed films are their own bucket.
async fn director_creator_counts(
    db: &SqlitePool,
) -> Result<std::collections::HashMap<i64, DirectorCreatorCounts>, String> {
    let mut map: std::collections::HashMap<i64, DirectorCreatorCounts> =
        std::collections::HashMap::new();

    let films: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT person_id, COUNT(DISTINCT movie_id) FROM movie_director GROUP BY person_id",
    )
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    for (pid, n) in films {
        map.entry(pid).or_default().films = n;
    }

    let created: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT person_id, COUNT(DISTINCT show_id) FROM show_creator GROUP BY person_id",
    )
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    for (pid, n) in created {
        map.entry(pid).or_default().created = n;
    }

    // Creator absorbs same-show episode directing (matches the detail page,
    // where the "creator" label suppresses the lower directing credit).
    let created_pairs: std::collections::HashSet<(i64, i64)> =
        sqlx::query_as::<_, (i64, i64)>("SELECT DISTINCT person_id, show_id FROM show_creator")
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();

    // Per (person, show): episodes they directed vs the show's total episodes.
    let coverage: Vec<(i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT ed.person_id, s.show_id, COUNT(*) AS directed, \
                (SELECT COUNT(*) FROM episode e2 JOIN season s2 ON e2.season_id = s2.id \
                  WHERE s2.show_id = s.show_id) AS total \
         FROM episode_director ed \
         JOIN episode e ON ed.episode_id = e.id \
         JOIN season s ON e.season_id = s.id \
         GROUP BY ed.person_id, s.show_id",
    )
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    for (pid, show_id, directed, total) in coverage {
        if created_pairs.contains(&(pid, show_id)) {
            continue;
        }
        let e = map.entry(pid).or_default();
        if total > 0 && directed >= total {
            e.shows += 1;
        } else {
            e.episodes += directed;
            e.episode_shows += 1;
        }
    }

    Ok(map)
}

#[tauri::command]
pub async fn get_people_in_library(
    state: tauri::State<'_, AppState>,
    library_id: String,
    role: String,
) -> Result<Vec<PersonSummary>, String> {
    let cte = role_works_cte(&role)?;
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;
    if format != "video" {
        return Err("People browsing is only supported for video libraries".to_string());
    }

    // work_count is role-specific: distinct titles credited in THIS role. The
    // role pages don't all show it directly (their cards may render a richer
    // breakdown), but it still drives "Most credited" ranking and search
    // ordering everywhere. film_count carves out the movie share of it.
    let query = format!(
        "{cte} \
         SELECT p.id, p.name, p.image_path, COUNT(*) AS work_count, \
                SUM(CASE WHEN rw.kind = 'movie' THEN 1 ELSE 0 END) AS film_count, \
                EXISTS(SELECT 1 FROM favorite_person fp WHERE fp.person_id = p.id) AS favorite \
         FROM person p \
         JOIN role_works rw ON rw.person_id = p.id \
         GROUP BY p.id \
         ORDER BY p.name COLLATE NOCASE ASC"
    );

    let rows: Vec<(i64, String, Option<String>, i64, i64, i64)> = sqlx::query_as(&query)
        .fetch_all(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    // The all-people page combines every role's breakdown in one subtitle
    // ("in … · directed … · created … · scored …"), so it needs all three
    // maps; role pages need at most the D&C one (actor/composer splits fall
    // out of film_count above).
    let mut dc_map = if role == "director_creator" || role == "all" {
        Some(director_creator_counts(&state.app_db).await?)
    } else {
        None
    };
    let mut acting_map = if role == "all" {
        Some(title_counts_for_role(&state.app_db, "actor").await?)
    } else {
        None
    };
    let mut composing_map = if role == "all" {
        Some(title_counts_for_role(&state.app_db, "composer").await?)
    } else {
        None
    };

    Ok(rows
        .into_iter()
        .map(|(id, name, image_path, work_count, film_count, favorite)| PersonSummary {
            id,
            name,
            image_path,
            work_count,
            favorite: favorite != 0,
            // On the D&C page every person has D&C credits, so default the
            // missing-entry case; on "all" a person may have none — leave None.
            dc: match role.as_str() {
                "director_creator" => {
                    Some(dc_map.as_mut().and_then(|m| m.remove(&id)).unwrap_or_default())
                }
                "all" => dc_map.as_mut().and_then(|m| m.remove(&id)),
                _ => None,
            },
            acting: match role.as_str() {
                "actor" => Some(TitleCounts { films: film_count, shows: work_count - film_count }),
                "all" => acting_map.as_mut().and_then(|m| m.remove(&id)),
                _ => None,
            },
            composing: match role.as_str() {
                "composer" => Some(TitleCounts { films: film_count, shows: work_count - film_count }),
                "all" => composing_map.as_mut().and_then(|m| m.remove(&id)),
                _ => None,
            },
        })
        .collect())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CharacterMatch {
    pub person: PersonSummary,
    pub matched_role: String,
    pub matched_title: String,
    /// Other distinct matching character strings for this person.
    pub extra_matches: i64,
}

/// People-page search by CHARACTER name ("Walter White" -> Bryan Cranston).
/// Searches every cast table (episode guest credits included — that's where
/// most obscure characters live), scoped to the library and the page's role
/// list. Show/movie billing outranks season, then episode credits.
#[tauri::command]
pub async fn search_people_by_character(
    state: tauri::State<'_, AppState>,
    library_id: String,
    role: String,
    query: String,
) -> Result<Vec<CharacterMatch>, String> {
    let q = query.trim();
    if q.len() < 2 {
        return Ok(Vec::new());
    }
    // Escape LIKE wildcards so a literal % or _ can't distort matching.
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let pattern = format!("%{escaped}%");

    let rows: Vec<(i64, String, String, i64)> = sqlx::query_as(
        "SELECT mc.person_id, mc.role, m.title, 0 AS lvl \
           FROM movie_cast mc \
           JOIN movie m ON m.id = mc.movie_id \
           JOIN media_entry me ON me.id = mc.movie_id \
          WHERE me.library_id = ?1 AND mc.role LIKE ?2 ESCAPE '\\' \
         UNION ALL \
         SELECT sc.person_id, sc.role, sh.title, 0 \
           FROM show_cast sc \
           JOIN show sh ON sh.id = sc.show_id \
           JOIN media_entry me ON me.id = sc.show_id \
          WHERE me.library_id = ?1 AND sc.role LIKE ?2 ESCAPE '\\' \
         UNION ALL \
         SELECT sec.person_id, sec.role, sh.title, 1 \
           FROM season_cast sec \
           JOIN season s ON sec.season_id = s.id \
           JOIN show sh ON sh.id = s.show_id \
           JOIN media_entry me ON me.id = sh.id \
          WHERE me.library_id = ?1 AND sec.role LIKE ?2 ESCAPE '\\' \
         UNION ALL \
         SELECT ec.person_id, ec.role, sh.title, 2 \
           FROM episode_cast ec \
           JOIN episode e ON ec.episode_id = e.id \
           JOIN season s ON e.season_id = s.id \
           JOIN show sh ON sh.id = s.show_id \
           JOIN media_entry me ON me.id = sh.id \
          WHERE me.library_id = ?1 AND ec.role LIKE ?2 ESCAPE '\\'",
    )
    .bind(&library_id)
    .bind(&pattern)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    // Best match per person: prefix beats substring (checked per slash-segment
    // — combined credits read "Jessica / Cynthia"), then higher billing level.
    let q_lower = q.to_lowercase();
    let is_prefix =
        |role: &str| role.split('/').any(|seg| seg.trim().to_lowercase().starts_with(&q_lower));

    struct Best {
        role: String,
        title: String,
        lvl: i64,
        prefix: bool,
        distinct: std::collections::HashSet<String>,
    }
    let mut by_person: std::collections::HashMap<i64, Best> = std::collections::HashMap::new();
    for (pid, role, title, lvl) in rows {
        let prefix = is_prefix(&role);
        match by_person.entry(pid) {
            std::collections::hash_map::Entry::Vacant(v) => {
                let mut distinct = std::collections::HashSet::new();
                distinct.insert(role.clone());
                v.insert(Best { role, title, lvl, prefix, distinct });
            }
            std::collections::hash_map::Entry::Occupied(mut o) => {
                let e = o.get_mut();
                e.distinct.insert(role.clone());
                if (prefix && !e.prefix) || (prefix == e.prefix && lvl < e.lvl) {
                    e.role = role;
                    e.title = title;
                    e.lvl = lvl;
                    e.prefix = prefix;
                }
            }
        }
    }

    let mut ranked: Vec<(i64, Best)> = by_person.into_iter().collect();
    ranked.sort_by(|a, b| {
        (!a.1.prefix, a.1.lvl, std::cmp::Reverse(a.1.distinct.len()))
            .cmp(&(!b.1.prefix, b.1.lvl, std::cmp::Reverse(b.1.distinct.len())))
    });
    ranked.truncate(60);

    // Person summaries, restricted to the page's role list.
    let cte = role_works_cte(&role)?;
    let placeholders = ranked.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let pquery = format!(
        "{cte} \
         SELECT p.id, p.name, p.image_path, COUNT(*) AS work_count, \
                EXISTS(SELECT 1 FROM favorite_person fp WHERE fp.person_id = p.id) AS favorite \
         FROM person p \
         JOIN role_works rw ON rw.person_id = p.id \
         WHERE p.id IN ({placeholders}) \
         GROUP BY p.id"
    );
    let mut pq = sqlx::query_as::<_, (i64, String, Option<String>, i64, i64)>(&pquery);
    for (pid, _) in &ranked {
        pq = pq.bind(pid);
    }
    let prows = pq.fetch_all(&state.app_db).await.map_err(|e| e.to_string())?;
    let mut people: std::collections::HashMap<i64, PersonSummary> = prows
        .into_iter()
        .map(|(id, name, image_path, work_count, favorite)| {
            (id, PersonSummary { id, name, image_path, work_count, favorite: favorite != 0, dc: None, acting: None, composing: None })
        })
        .collect();

    Ok(ranked
        .into_iter()
        .filter_map(|(pid, best)| {
            let person = people.remove(&pid)?; // absent = not in this page's role list
            Some(CharacterMatch {
                person,
                matched_role: best.role,
                matched_title: best.title,
                extra_matches: (best.distinct.len() as i64 - 1).max(0),
            })
        })
        .collect())
}

/// Name autocomplete for the cast editors — existing people whose name matches,
/// prefix matches first. Small limit; this fires on every few keystrokes.
#[tauri::command]
pub async fn search_persons(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<PersonInfo>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let substr = format!("%{escaped}%");
    let prefix = format!("{escaped}%");
    let rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id, name, image_path FROM person \
         WHERE name LIKE ?1 ESCAPE '\\' \
         ORDER BY CASE WHEN name LIKE ?2 ESCAPE '\\' THEN 0 ELSE 1 END, name COLLATE NOCASE \
         LIMIT 8",
    )
    .bind(&substr)
    .bind(&prefix)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, name, image_path)| PersonInfo { id, name, image_path })
        .collect())
}

#[tauri::command]
pub async fn set_person_favorite(
    state: tauri::State<'_, AppState>,
    person_id: i64,
    favorite: bool,
) -> Result<(), String> {
    if favorite {
        sqlx::query("INSERT OR IGNORE INTO favorite_person (person_id) VALUES (?)")
            .bind(person_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        sqlx::query("DELETE FROM favorite_person WHERE person_id = ?")
            .bind(person_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// "as X" / "as X & Y" / "as X, Y, & Z" (Oxford comma). Beyond 3 roles, the
/// first two are listed and the rest summarized: "voices X, Y, & 14 more
/// characters". The overflow count is total - 2, so it's always ≥ 2 — a lone
/// "& 1 more character" can't occur (3 roles fit the full list).
fn format_role_list(prefix: &str, roles: &[String]) -> Option<String> {
    if roles.is_empty() {
        return None;
    }
    let joined = match roles.len() {
        1 => roles[0].clone(),
        2 => format!("{} & {}", roles[0], roles[1]),
        3 => format!("{}, {}, & {}", roles[0], roles[1], roles[2]),
        n => format!("{}, {}, & {} more characters", roles[0], roles[1], n - 2),
    };
    Some(format!("{prefix} {joined}"))
}

/// Strips "(voice)" markers and tidies the whitespace left behind.
fn strip_voice_marker(role: &str) -> String {
    let stripped = role.replace("(voice)", "").replace("(Voice)", "");
    let mut out = String::with_capacity(stripped.len());
    let mut prev_space = false;
    for ch in stripped.chars() {
        let is_space = ch == ' ';
        if !(is_space && prev_space) {
            out.push(ch);
        }
        prev_space = is_space;
    }
    out.trim().trim_end_matches('/').trim().to_string()
}

#[tauri::command]
pub async fn get_entries_for_person(
    state: tauri::State<'_, AppState>,
    library_id: String,
    person_id: i64,
    role: String,
) -> Result<Vec<MediaEntry>, String> {
    let cte = role_works_cte(&role)?;
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;
    if format != "video" {
        return Err("People browsing is only supported for video libraries".to_string());
    }

    let mut covers_map = get_all_cached_covers(&state.app_db, &library_id)
        .await
        .map_err(|e| e.to_string())?;

    // Same year/end_year shape as get_entries — these entries become detail-page
    // crumbs and selectedEntry snapshots, so shows need their episode-derived
    // year range here too (a NULL year leaves the detail hero without one).
    let show_episode_years = "\
        SELECT SUBSTR(e.release_date, 1, 4) as yr FROM episode e \
          JOIN season s ON e.season_id = s.id \
          WHERE s.show_id = mef.id AND e.release_date IS NOT NULL";
    let query = format!(
        "{cte} \
         SELECT mef.id, mef.title, \
           CASE \
             WHEN mef.entry_type = 'movie' THEN SUBSTR(mef.release_date, 1, 4) \
             WHEN mef.entry_type = 'show' THEN (SELECT MIN(yr) FROM ({show_episode_years})) \
           END AS year, \
           CASE \
             WHEN mef.entry_type = 'show' THEN \
               NULLIF((SELECT MAX(yr) FROM ({show_episode_years})), (SELECT MIN(yr) FROM ({show_episode_years}))) \
           END AS end_year, \
           mef.folder_path, mef.parent_id, mef.entry_type, mef.selected_cover, \
           CASE \
             WHEN mef.entry_type = 'movie' THEN (SELECT tmdb_id FROM movie WHERE id = mef.id) \
             WHEN mef.entry_type = 'show' THEN (SELECT CAST(tmdb_id AS TEXT) FROM show WHERE id = mef.id) \
             ELSE NULL \
           END AS tmdb_id \
         FROM media_entry_full mef \
         WHERE mef.library_id = ? AND mef.id IN (SELECT eid FROM role_works WHERE person_id = ?) \
         ORDER BY mef.sort_title COLLATE NOCASE ASC"
    );

    let rows: Vec<(i64, String, Option<String>, Option<String>, String, Option<i64>, String, Option<String>, Option<String>)> =
        sqlx::query_as(&query)
            .bind(&library_id)
            .bind(person_id)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;

    // Character names per title, billing order first (show/movie cast, then season,
    // then episode guest roles). Cards show "as Walter White" instead of the year.
    let role_rows: Vec<(i64, Option<String>)> = sqlx::query_as(
        "SELECT mc.movie_id, mc.role FROM movie_cast mc WHERE mc.person_id = ? \
         UNION ALL \
         SELECT sc.show_id, sc.role FROM show_cast sc WHERE sc.person_id = ? \
         UNION ALL \
         SELECT s.show_id, sec.role FROM season_cast sec JOIN season s ON sec.season_id = s.id WHERE sec.person_id = ? \
         UNION ALL \
         SELECT s.show_id, ec.role FROM episode_cast ec JOIN episode e ON ec.episode_id = e.id JOIN season s ON e.season_id = s.id WHERE ec.person_id = ?",
    )
    .bind(person_id)
    .bind(person_id)
    .bind(person_id)
    .bind(person_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let mut roles_by_entry: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    for (eid, role) in role_rows {
        let Some(role) = role.filter(|r| !r.trim().is_empty()) else { continue };
        let list = roles_by_entry.entry(eid).or_default();
        if !list.contains(&role) {
            list.push(role);
        }
    }

    // Director / creator credits, summarized at the highest level that applies:
    // whole movie/show -> "director"/"creator"; every episode of N seasons ->
    // "director of N seasons"; scattered episodes -> "director of N episodes".
    // (There is no season-level director storage — season directors were fanned
    // out to episodes at apply time, so full-season coverage is derived.)
    let movie_dirs: std::collections::HashSet<i64> =
        sqlx::query_as::<_, (i64,)>("SELECT movie_id FROM movie_director WHERE person_id = ?")
            .bind(person_id)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(id,)| id)
            .collect();
    let creators: std::collections::HashSet<i64> =
        sqlx::query_as::<_, (i64,)>("SELECT show_id FROM show_creator WHERE person_id = ?")
            .bind(person_id)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(id,)| id)
            .collect();
    // Per season the person directed in: (show, episodes in season, episodes they directed).
    let season_cov: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT s.show_id, \
                (SELECT COUNT(*) FROM episode e2 WHERE e2.season_id = s.id) AS total, \
                COUNT(*) AS directed \
         FROM season s \
         JOIN episode e ON e.season_id = s.id \
         JOIN episode_director ed ON ed.episode_id = e.id \
         WHERE ed.person_id = ? \
         GROUP BY s.id",
    )
    .bind(person_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let season_totals: std::collections::HashMap<i64, i64> =
        sqlx::query_as::<_, (i64, i64)>("SELECT show_id, COUNT(*) FROM season GROUP BY show_id")
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
    // show -> (fully-directed seasons, directed episodes in partial seasons)
    let mut show_dir: std::collections::HashMap<i64, (i64, i64)> = std::collections::HashMap::new();
    for (show_id, total, directed) in season_cov {
        let e = show_dir.entry(show_id).or_default();
        if total > 0 && directed >= total {
            e.0 += 1;
        } else {
            e.1 += directed;
        }
    }

    let director_credit = |id: i64| -> Option<String> {
        if movie_dirs.contains(&id) {
            return Some("director".to_string());
        }
        // Creator is a show-level credit — it overrides any lower directing credit.
        if creators.contains(&id) {
            return Some("creator".to_string());
        }
        let &(full, partial_eps) = show_dir.get(&id)?;
        let total_seasons = season_totals.get(&id).copied().unwrap_or(0);
        if full > 0 && full == total_seasons {
            Some("director".to_string())
        } else if full > 0 {
            // Higher level wins: full seasons suppress stray episode credits.
            Some(format!("director of {} season{}", full, if full == 1 { "" } else { "s" }))
        } else if partial_eps > 0 {
            Some(format!("director of {} episode{}", partial_eps, if partial_eps == 1 { "" } else { "s" }))
        } else {
            None
        }
    };

    // Composer credits — same shape as directing: whole movie/show ->
    // "composer"; full-season episode coverage -> "composer of N seasons";
    // scattered episodes -> "composer of N episodes".
    let movie_comps: std::collections::HashSet<i64> =
        sqlx::query_as::<_, (i64,)>("SELECT movie_id FROM movie_composer WHERE person_id = ?")
            .bind(person_id)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(id,)| id)
            .collect();
    let show_comps: std::collections::HashSet<i64> =
        sqlx::query_as::<_, (i64,)>("SELECT show_id FROM show_composer WHERE person_id = ?")
            .bind(person_id)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(id,)| id)
            .collect();
    let comp_season_cov: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT s.show_id, \
                (SELECT COUNT(*) FROM episode e2 WHERE e2.season_id = s.id) AS total, \
                COUNT(*) AS composed \
         FROM season s \
         JOIN episode e ON e.season_id = s.id \
         JOIN episode_composer ec ON ec.episode_id = e.id \
         WHERE ec.person_id = ? \
         GROUP BY s.id",
    )
    .bind(person_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let mut show_comp: std::collections::HashMap<i64, (i64, i64)> = std::collections::HashMap::new();
    for (show_id, total, composed) in comp_season_cov {
        let e = show_comp.entry(show_id).or_default();
        if total > 0 && composed >= total {
            e.0 += 1;
        } else {
            e.1 += composed;
        }
    }

    let composer_credit = |id: i64| -> Option<String> {
        if movie_comps.contains(&id) || show_comps.contains(&id) {
            return Some("composer".to_string());
        }
        let &(full, partial_eps) = show_comp.get(&id)?;
        let total_seasons = season_totals.get(&id).copied().unwrap_or(0);
        if full > 0 && full == total_seasons {
            Some("composer".to_string())
        } else if full > 0 {
            Some(format!("composer of {} season{}", full, if full == 1 { "" } else { "s" }))
        } else if partial_eps > 0 {
            Some(format!("composer of {} episode{}", partial_eps, if partial_eps == 1 { "" } else { "s" }))
        } else {
            None
        }
    };

    let entries: Vec<MediaEntry> = rows
        .into_iter()
        .map(|(id, title, year, end_year, folder_path, parent_id, entry_type, selected_cover, tmdb_id)| {
            let covers = covers_map.remove(&folder_path).unwrap_or_default();
            // Voiced characters are their own group ("voices …") separate from
            // played ones ("as …"); director/creator credit comes last:
            // "as Walter White · voices 3 characters · director of 2 episodes".
            let mut acting: Vec<String> = Vec::new();
            let mut voiced: Vec<String> = Vec::new();
            if let Some(roles) = roles_by_entry.get(&id) {
                for r in roles {
                    if r.contains("(voice)") || r.contains("(Voice)") {
                        let cleaned = strip_voice_marker(r);
                        if !cleaned.is_empty() && !voiced.contains(&cleaned) {
                            voiced.push(cleaned);
                        }
                    } else if !acting.contains(r) {
                        acting.push(r.clone());
                    }
                }
            }
            let parts: Vec<String> = [
                format_role_list("as", &acting),
                format_role_list("voices", &voiced),
                director_credit(id),
                composer_credit(id),
            ]
            .into_iter()
            .flatten()
            .collect();
            let role_display = if parts.is_empty() { None } else { Some(parts.join(" · ")) };
            MediaEntry {
                id,
                title,
                year,
                end_year,
                folder_path,
                parent_id,
                entry_type,
                covers,
                selected_cover,
                child_count: 0,
                season_display: None,
                collection_display: None,
                role_display,
                tmdb_id,
                link_id: None,
            }
        })
        .collect();

    Ok(entries)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistSummary {
    pub id: i64,
    pub title: String,
    pub selected_cover: Option<String>,
    pub covers: Vec<String>,
    /// Aggregate movie/show counts + year range across the whole playlist (links
    /// at the root and nested in groupings) for the card subtitle.
    pub movie_count: i64,
    pub show_count: i64,
    pub year: Option<String>,
    pub end_year: Option<String>,
}

/// The playlists-LIST payload: the playlists plus the saved presets / selected preset for the
/// list scope (so the toolbar can render the preset dropdown). Mirrors `EntriesResponse`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistsResponse {
    pub playlists: Vec<PlaylistSummary>,
    pub presets: Vec<SortPresetSummary>,
    pub selected_preset_id: Option<i64>,
}

#[tauri::command]
pub async fn get_playlists(
    state: tauri::State<'_, AppState>,
    library_id: String,
    sort_mode: Option<String>,
) -> Result<PlaylistsResponse, String> {
    // "alpha" sorts by title; anything else ("custom") uses the manual sort_order
    // (title as a stable tiebreaker). The mode itself is persisted by the frontend
    // in the settings table, so no new column / migration is needed.
    let order = if sort_mode.as_deref() == Some("alpha") {
        "title COLLATE NOCASE ASC"
    } else {
        "sort_order ASC, title COLLATE NOCASE ASC"
    };
    let rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(&format!(
        "SELECT id, title, selected_cover FROM media_playlist WHERE library_id = ? ORDER BY {order}"
    ))
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    // All links in a playlist live either directly under it (parent_playlist_id)
    // or inside one of its groupings (recursively). Aggregate movie/show counts and
    // the year range across all of them for the card subtitle.
    let counts_sql = "WITH RECURSIVE pcs(id) AS ( \
            SELECT id FROM media_playlist_collection WHERE parent_playlist_id = ? \
            UNION ALL \
            SELECT mpc.id FROM media_playlist_collection mpc JOIN pcs ON mpc.parent_collection_id = pcs.id \
        ) \
        SELECT \
            COALESCE(SUM(CASE WHEN met.name = 'movie' THEN 1 ELSE 0 END), 0), \
            COALESCE(SUM(CASE WHEN met.name = 'show' THEN 1 ELSE 0 END), 0) \
        FROM media_link ml \
        JOIN media_entry me ON me.id = ml.target_entry_id \
        JOIN media_entry_type met ON me.entry_type_id = met.id \
        WHERE ml.parent_playlist_id = ? OR ml.parent_collection_id IN (SELECT id FROM pcs)";
    let range_sql = "WITH RECURSIVE pcs(id) AS ( \
            SELECT id FROM media_playlist_collection WHERE parent_playlist_id = ? \
            UNION ALL \
            SELECT mpc.id FROM media_playlist_collection mpc JOIN pcs ON mpc.parent_collection_id = pcs.id \
        ), \
        targets AS ( \
            SELECT ml.target_entry_id AS tid FROM media_link ml \
            WHERE ml.parent_playlist_id = ? OR ml.parent_collection_id IN (SELECT id FROM pcs) \
        ) \
        SELECT MIN(yr), MAX(yr) FROM ( \
            SELECT SUBSTR(m.release_date, 1, 4) AS yr FROM movie m \
              WHERE m.id IN (SELECT tid FROM targets) AND m.release_date IS NOT NULL \
            UNION ALL \
            SELECT SUBSTR(e.release_date, 1, 4) AS yr FROM episode e \
              JOIN season s ON e.season_id = s.id \
              WHERE s.show_id IN (SELECT tid FROM targets) AND e.release_date IS NOT NULL \
        )";

    let mut playlists = Vec::with_capacity(rows.len());
    for (id, title, selected_cover) in rows {
        let dir = playlist_covers_dir(&state.app_data_dir, "playlist", id);
        let covers = list_playlist_covers(&dir);
        let (movie_count, show_count): (i64, i64) = sqlx::query_as(counts_sql)
            .bind(id)
            .bind(id)
            .fetch_one(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        let (min_year, max_year): (Option<String>, Option<String>) = sqlx::query_as(range_sql)
            .bind(id)
            .bind(id)
            .fetch_one(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        let end_year = match (&min_year, &max_year) {
            (Some(a), Some(b)) if a != b => Some(b.clone()),
            _ => None,
        };
        playlists.push(PlaylistSummary {
            id, title, selected_cover, covers,
            movie_count, show_count, year: min_year, end_year,
        });
    }

    // Saved presets + selected preset for the playlists-LIST scope. The selected id lives in the
    // settings table (the list has no owning row/column), keyed by library id. Custom sort with a
    // selected preset overrides the manual sort_order with the preset's saved sequence.
    let scope_key = format!("playlists:{library_id}");
    let presets: Vec<SortPresetSummary> = {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, name FROM sort_preset WHERE scope_key = ? ORDER BY created_at ASC, id ASC",
        )
        .bind(&scope_key)
        .fetch_all(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
        rows.into_iter().map(|(id, name)| SortPresetSummary { id, name }).collect()
    };
    let selected_preset_id: Option<i64> = sqlx::query_scalar::<_, String>(
        "SELECT value FROM settings WHERE key = ?",
    )
    .bind(format!("playlists_selected_preset:{library_id}"))
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?
    .and_then(|s| s.parse::<i64>().ok());

    if sort_mode.as_deref() != Some("alpha") {
        if let Some(pid) = selected_preset_id {
            playlists = apply_playlists_list_preset_ordering(&state.app_db, pid, playlists).await?;
        }
    }

    Ok(PlaylistsResponse { playlists, presets, selected_preset_id })
}

/// Reorder the playlists themselves (the playlists-list custom order): write each
/// playlist's `sort_order` to its index in `ids`. Clears any selected list-preset
/// since the manual order now diverges from it (preset id for the list lives in
/// settings, written by the frontend).
#[tauri::command]
pub async fn reorder_playlists(
    state: tauri::State<'_, AppState>,
    library_id: String,
    ids: Vec<i64>,
) -> Result<(), String> {
    for (i, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE media_playlist SET sort_order = ? WHERE id = ? AND library_id = ?")
            .bind(i as i64)
            .bind(id)
            .bind(&library_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }
    // Manual reorder diverges from any selected list-preset, so drop the selection
    // (mirrors update_sort_order clearing selected_preset_id for the media grid).
    sqlx::query("DELETE FROM settings WHERE key = ?")
        .bind(format!("playlists_selected_preset:{library_id}"))
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Playlists-LIST-scope preset ordering. Preset items are `{kind:"playlist",id:N}` referencing
/// media_playlist.id. Stale ids are dropped; remaining playlists trail in their current order.
/// Prunes stale ids from the preset row opportunistically so the JSON doesn't grow unbounded.
async fn apply_playlists_list_preset_ordering(
    pool: &sqlx::SqlitePool,
    preset_id: i64,
    playlists: Vec<PlaylistSummary>,
) -> Result<Vec<PlaylistSummary>, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT items FROM sort_preset WHERE id = ?")
        .bind(preset_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let Some((items_json,)) = row else { return Ok(playlists); };

    #[derive(serde::Deserialize)]
    struct ListPresetItem { id: i64 }
    let preset_items: Vec<ListPresetItem> = serde_json::from_str(&items_json).unwrap_or_default();

    let mut by_id: std::collections::HashMap<i64, PlaylistSummary> = std::collections::HashMap::new();
    let mut order: Vec<i64> = Vec::new();
    for p in playlists {
        order.push(p.id);
        by_id.insert(p.id, p);
    }

    let before = preset_items.len();
    let mut out: Vec<PlaylistSummary> = Vec::new();
    let mut kept_ids: Vec<i64> = Vec::new();
    for pi in preset_items {
        if let Some(p) = by_id.remove(&pi.id) {
            out.push(p);
            kept_ids.push(pi.id);
        }
    }
    for id in order {
        if let Some(p) = by_id.remove(&id) {
            out.push(p);
        }
    }

    if kept_ids.len() != before {
        let pruned: Vec<serde_json::Value> = kept_ids
            .into_iter()
            .map(|id| serde_json::json!({"kind":"playlist","id":id}))
            .collect();
        if let Ok(new_json) = serde_json::to_string(&pruned) {
            let _ = sqlx::query("UPDATE sort_preset SET items = ? WHERE id = ?")
                .bind(&new_json).bind(preset_id)
                .execute(pool).await;
        }
    }

    Ok(out)
}

#[tauri::command]
pub async fn create_playlist(
    state: tauri::State<'_, AppState>,
    library_id: String,
    title: String,
) -> Result<i64, String> {
    let sort_title = title.to_lowercase();
    let max_order: (i64,) = sqlx::query_as("SELECT COALESCE(MAX(sort_order), 0) FROM media_playlist WHERE library_id = ?")
        .bind(&library_id)
        .fetch_one(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    let result = sqlx::query(
        "INSERT INTO media_playlist (library_id, title, sort_title, sort_order) VALUES (?, ?, ?, ?)",
    )
    .bind(&library_id)
    .bind(&title)
    .bind(&sort_title)
    .bind(max_order.0 + 1)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let id = result.last_insert_rowid();
    Ok(id)
}

#[tauri::command]
pub async fn delete_playlist(
    state: tauri::State<'_, AppState>,
    playlist_id: i64,
) -> Result<(), String> {
    // Collect every nested collection id before the cascade delete removes them, so we
    // can also wipe their on-disk cover directories (the DB cascade doesn't touch disk).
    let descendant_ids: Vec<(i64,)> = sqlx::query_as(
        "WITH RECURSIVE descendants(id) AS ( \
           SELECT id FROM media_playlist_collection WHERE parent_playlist_id = ? \
           UNION ALL \
           SELECT c.id FROM media_playlist_collection c JOIN descendants d ON c.parent_collection_id = d.id \
         ) SELECT id FROM descendants",
    )
    .bind(playlist_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    // Purge presets scoped to this playlist and its nested collections before the cascade.
    let _ = sqlx::query("DELETE FROM sort_preset WHERE scope_key = ?")
        .bind(format!("pl-root:{}", playlist_id))
        .execute(&state.app_db)
        .await;
    for (cid,) in &descendant_ids {
        let _ = sqlx::query("DELETE FROM sort_preset WHERE scope_key = ?")
            .bind(format!("pl-coll:{}", cid))
            .execute(&state.app_db)
            .await;
    }

    sqlx::query("DELETE FROM media_playlist WHERE id = ?")
        .bind(playlist_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    let pl_dir = playlist_covers_dir(&state.app_data_dir, "playlist", playlist_id);
    if pl_dir.exists() { let _ = std::fs::remove_dir_all(&pl_dir); }
    for (cid,) in descendant_ids {
        let cdir = playlist_covers_dir(&state.app_data_dir, "collection", cid);
        if cdir.exists() { let _ = std::fs::remove_dir_all(&cdir); }
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_playlist(
    state: tauri::State<'_, AppState>,
    playlist_id: i64,
    new_title: String,
) -> Result<(), String> {
    sqlx::query("UPDATE media_playlist SET title = ?, sort_title = LOWER(?) WHERE id = ?")
        .bind(&new_title)
        .bind(&new_title)
        .bind(playlist_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn rename_playlist_collection(
    state: tauri::State<'_, AppState>,
    collection_id: i64,
    new_title: String,
) -> Result<(), String> {
    sqlx::query("UPDATE media_playlist_collection SET title = ?, sort_title = LOWER(?) WHERE id = ?")
        .bind(&new_title)
        .bind(&new_title)
        .bind(collection_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_playlist_collection(
    state: tauri::State<'_, AppState>,
    collection_id: i64,
) -> Result<(), String> {
    let descendant_ids: Vec<(i64,)> = sqlx::query_as(
        "WITH RECURSIVE descendants(id) AS ( \
           SELECT id FROM media_playlist_collection WHERE id = ? \
           UNION ALL \
           SELECT c.id FROM media_playlist_collection c JOIN descendants d ON c.parent_collection_id = d.id \
         ) SELECT id FROM descendants",
    )
    .bind(collection_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    // Purge presets scoped to this collection and its descendants before the cascade.
    for (cid,) in &descendant_ids {
        let _ = sqlx::query("DELETE FROM sort_preset WHERE scope_key = ?")
            .bind(format!("pl-coll:{}", cid))
            .execute(&state.app_db)
            .await;
    }
    sqlx::query("DELETE FROM media_playlist_collection WHERE id = ?")
        .bind(collection_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    for (cid,) in descendant_ids {
        let cdir = playlist_covers_dir(&state.app_data_dir, "collection", cid);
        if cdir.exists() { let _ = std::fs::remove_dir_all(&cdir); }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_playlist_collection(
    state: tauri::State<'_, AppState>,
    title: String,
    parent_playlist_id: Option<i64>,
    parent_collection_id: Option<i64>,
) -> Result<i64, String> {
    // Exactly one parent must be set — matches the table's CHECK constraint.
    if parent_playlist_id.is_some() == parent_collection_id.is_some() {
        return Err("Exactly one of parent_playlist_id or parent_collection_id must be set".to_string());
    }
    let sort_title = title.to_lowercase();
    let max_order: (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sort_order), 0) FROM media_playlist_collection \
         WHERE parent_playlist_id IS ? AND parent_collection_id IS ?",
    )
    .bind(parent_playlist_id)
    .bind(parent_collection_id)
    .fetch_one(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let result = sqlx::query(
        "INSERT INTO media_playlist_collection (title, sort_title, sort_order, parent_playlist_id, parent_collection_id) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&title)
    .bind(&sort_title)
    .bind(max_order.0 + 1)
    .bind(parent_playlist_id)
    .bind(parent_collection_id)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(result.last_insert_rowid())
}

#[tauri::command]
pub async fn add_media_link(
    state: tauri::State<'_, AppState>,
    target_entry_id: i64,
    parent_playlist_id: Option<i64>,
    parent_collection_id: Option<i64>,
) -> Result<i64, String> {
    if parent_playlist_id.is_some() == parent_collection_id.is_some() {
        return Err("Exactly one of parent_playlist_id or parent_collection_id must be set".to_string());
    }

    // Cross-library linking is rejected in v1: the target entry must live in the same library
    // as the parent playlist. Resolve the playlist's library_id from whichever parent is set.
    // Collections are also rejected — only leaf media (movie/show) can be linked into playlists.
    let target_row: Option<(String, String)> = sqlx::query_as(
        "SELECT library_id, entry_type FROM media_entry_full WHERE id = ?",
    )
    .bind(target_entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let (target_lib, target_type) = target_row.ok_or("Target media entry not found")?;
    if target_type != "movie" && target_type != "show" {
        return Err(format!("Cannot add {target_type} to a playlist — only movies and shows can be linked"));
    }

    let parent_lib: Option<(String,)> = if let Some(pid) = parent_playlist_id {
        sqlx::query_as("SELECT library_id FROM media_playlist WHERE id = ?")
            .bind(pid)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
    } else if let Some(cid) = parent_collection_id {
        // Walk up the collection chain until we hit a parent playlist, then take its library.
        sqlx::query_as(
            "WITH RECURSIVE up(pl_id, pc_id) AS ( \
               SELECT parent_playlist_id, parent_collection_id FROM media_playlist_collection WHERE id = ? \
               UNION ALL \
               SELECT c.parent_playlist_id, c.parent_collection_id \
                 FROM media_playlist_collection c JOIN up ON c.id = up.pc_id \
             ) \
             SELECT library_id FROM media_playlist WHERE id = (SELECT pl_id FROM up WHERE pl_id IS NOT NULL LIMIT 1)",
        )
        .bind(cid)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
    } else {
        None
    };
    let parent_lib = parent_lib.ok_or("Parent playlist not found")?.0;

    if target_lib != parent_lib {
        return Err("Cross-library linking is not supported in this version".to_string());
    }

    let max_order: (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sort_order), 0) FROM media_link \
         WHERE parent_playlist_id IS ? AND parent_collection_id IS ?",
    )
    .bind(parent_playlist_id)
    .bind(parent_collection_id)
    .fetch_one(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    // Seed the link's own selected_cover from the target entry's current cover so the
    // initial render matches the library. After this the two covers are independent —
    // cover changes in the library never touch `media_link.selected_cover`, and vice versa.
    let target_cover: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT selected_cover FROM media_entry_full WHERE id = ?",
    )
    .bind(target_entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let initial_cover = target_cover.and_then(|(c,)| c);

    let result = sqlx::query(
        "INSERT INTO media_link (target_entry_id, sort_order, selected_cover, parent_playlist_id, parent_collection_id) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(target_entry_id)
    .bind(max_order.0 + 1)
    .bind(&initial_cover)
    .bind(parent_playlist_id)
    .bind(parent_collection_id)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(result.last_insert_rowid())
}

/// Update the per-link cover override. Only applies to playlist links — the target
/// entry's own `selected_cover` in the library is untouched.
#[tauri::command]
pub async fn set_link_cover(
    state: tauri::State<'_, AppState>,
    link_id: i64,
    cover_path: Option<String>,
) -> Result<(), String> {
    sqlx::query("UPDATE media_link SET selected_cover = ? WHERE id = ?")
        .bind(&cover_path)
        .bind(link_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_media_link(
    state: tauri::State<'_, AppState>,
    link_id: i64,
) -> Result<(), String> {
    sqlx::query("DELETE FROM media_link WHERE id = ?")
        .bind(link_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Walk the playlist's full tree (root + every nested playlist_collection) and return
/// true if any `media_link` anywhere inside it already targets `target_entry_id`.
/// Used by the "Add to playlist" flow to decide whether to prompt for duplicate confirmation.
#[tauri::command]
pub async fn playlist_contains_target(
    state: tauri::State<'_, AppState>,
    playlist_id: i64,
    target_entry_id: i64,
) -> Result<bool, String> {
    let row: Option<(i64,)> = sqlx::query_as(
        "WITH RECURSIVE descendants(id) AS ( \
            SELECT id FROM media_playlist_collection WHERE parent_playlist_id = ? \
            UNION ALL \
            SELECT c.id FROM media_playlist_collection c \
              JOIN descendants d ON c.parent_collection_id = d.id \
         ) \
         SELECT 1 FROM media_link \
          WHERE target_entry_id = ? \
            AND (parent_playlist_id = ? OR parent_collection_id IN (SELECT id FROM descendants)) \
          LIMIT 1",
    )
    .bind(playlist_id)
    .bind(target_entry_id)
    .bind(playlist_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.is_some())
}

/// Re-parent an existing media_link inside the same playlist. Exactly one of the two
/// parent IDs must be set (mirrors the table's CHECK constraint). The link's sort_order
/// is reset to (max + 1) in the new parent — equivalent to "move to the end".
#[tauri::command]
pub async fn move_media_link(
    state: tauri::State<'_, AppState>,
    link_id: i64,
    parent_playlist_id: Option<i64>,
    parent_collection_id: Option<i64>,
) -> Result<(), String> {
    if parent_playlist_id.is_some() == parent_collection_id.is_some() {
        return Err("Exactly one of parent_playlist_id or parent_collection_id must be set".to_string());
    }
    let max_order: (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sort_order), 0) FROM media_link \
         WHERE parent_playlist_id IS ? AND parent_collection_id IS ?",
    )
    .bind(parent_playlist_id)
    .bind(parent_collection_id)
    .fetch_one(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "UPDATE media_link \
         SET parent_playlist_id = ?, parent_collection_id = ?, sort_order = ? \
         WHERE id = ?",
    )
    .bind(parent_playlist_id)
    .bind(parent_collection_id)
    .bind(max_order.0 + 1)
    .bind(link_id)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Re-parent a nested media_playlist_collection inside the same playlist. Same
/// exactly-one-parent rule as creation/move for media_link. The collection's children
/// (further nested collections and links) ride along via the unchanged FK cascade —
/// only this row's parent_* columns are updated.
#[tauri::command]
pub async fn move_playlist_collection(
    state: tauri::State<'_, AppState>,
    collection_id: i64,
    parent_playlist_id: Option<i64>,
    parent_collection_id: Option<i64>,
) -> Result<(), String> {
    if parent_playlist_id.is_some() == parent_collection_id.is_some() {
        return Err("Exactly one of parent_playlist_id or parent_collection_id must be set".to_string());
    }
    // Guard against the obvious self-loop (moving a collection into itself). Deeper
    // cycle detection (moving into a descendant) would require walking the chain;
    // skipped for v1 — UI drops don't let the user target a descendant since they
    // can only see siblings and descendants aren't rendered at the current level.
    if parent_collection_id == Some(collection_id) {
        return Err("Cannot move a collection into itself".to_string());
    }
    let max_order: (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sort_order), 0) FROM media_playlist_collection \
         WHERE parent_playlist_id IS ? AND parent_collection_id IS ?",
    )
    .bind(parent_playlist_id)
    .bind(parent_collection_id)
    .fetch_one(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "UPDATE media_playlist_collection \
         SET parent_playlist_id = ?, parent_collection_id = ?, sort_order = ? \
         WHERE id = ?",
    )
    .bind(parent_playlist_id)
    .bind(parent_collection_id)
    .bind(max_order.0 + 1)
    .bind(collection_id)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_playlist_sort_mode(
    state: tauri::State<'_, AppState>,
    playlist_id: i64,
    mode: String,
) -> Result<(), String> {
    if !matches!(mode.as_str(), "custom" | "alpha") {
        return Err(format!("Invalid playlist sort mode: {mode}"));
    }
    sqlx::query("UPDATE media_playlist SET sort_mode = ?, selected_preset_id = NULL WHERE id = ?")
        .bind(&mode)
        .bind(playlist_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_playlist_collection_sort_mode(
    state: tauri::State<'_, AppState>,
    collection_id: i64,
    mode: String,
) -> Result<(), String> {
    if !matches!(mode.as_str(), "custom" | "alpha") {
        return Err(format!("Invalid playlist-collection sort mode: {mode}"));
    }
    sqlx::query("UPDATE media_playlist_collection SET sort_mode = ?, selected_preset_id = NULL WHERE id = ?")
        .bind(&mode)
        .bind(collection_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Playlist / playlist_collection custom covers ──────────────────────────────

#[tauri::command]
pub async fn add_playlist_cover(
    state: tauri::State<'_, AppState>,
    playlist_id: i64,
    source_path: String,
) -> Result<String, String> {
    let dir = playlist_covers_dir(&state.app_data_dir, "playlist", playlist_id);
    let added = copy_cover_into_dir(&source_path, &dir)?;
    // Auto-select the first cover added so the UI updates immediately.
    let current: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT selected_cover FROM media_playlist WHERE id = ?",
    )
    .bind(playlist_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    if current.and_then(|(c,)| c).is_none() {
        sqlx::query("UPDATE media_playlist SET selected_cover = ? WHERE id = ?")
            .bind(&added).bind(playlist_id)
            .execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }
    Ok(added)
}

#[tauri::command]
pub async fn add_playlist_collection_cover(
    state: tauri::State<'_, AppState>,
    collection_id: i64,
    source_path: String,
) -> Result<String, String> {
    let dir = playlist_covers_dir(&state.app_data_dir, "collection", collection_id);
    let added = copy_cover_into_dir(&source_path, &dir)?;
    let current: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT selected_cover FROM media_playlist_collection WHERE id = ?",
    )
    .bind(collection_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    if current.and_then(|(c,)| c).is_none() {
        sqlx::query("UPDATE media_playlist_collection SET selected_cover = ? WHERE id = ?")
            .bind(&added).bind(collection_id)
            .execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }
    Ok(added)
}

#[tauri::command]
pub async fn delete_playlist_cover(
    state: tauri::State<'_, AppState>,
    playlist_id: i64,
    cover_path: String,
) -> Result<Option<String>, String> {
    let p = PathBuf::from(&cover_path);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("Failed to delete cover: {e}"))?;
    }
    let current: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT selected_cover FROM media_playlist WHERE id = ?",
    )
    .bind(playlist_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let current = current.and_then(|(c,)| c);
    let new_selected = if current.as_deref() == Some(cover_path.as_str()) {
        let dir = playlist_covers_dir(&state.app_data_dir, "playlist", playlist_id);
        let new_val = list_playlist_covers(&dir).into_iter().next();
        sqlx::query("UPDATE media_playlist SET selected_cover = ? WHERE id = ?")
            .bind(&new_val).bind(playlist_id)
            .execute(&state.app_db).await.map_err(|e| e.to_string())?;
        new_val
    } else {
        current
    };
    Ok(new_selected)
}

#[tauri::command]
pub async fn delete_playlist_collection_cover(
    state: tauri::State<'_, AppState>,
    collection_id: i64,
    cover_path: String,
) -> Result<Option<String>, String> {
    let p = PathBuf::from(&cover_path);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("Failed to delete cover: {e}"))?;
    }
    let current: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT selected_cover FROM media_playlist_collection WHERE id = ?",
    )
    .bind(collection_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let current = current.and_then(|(c,)| c);
    let new_selected = if current.as_deref() == Some(cover_path.as_str()) {
        let dir = playlist_covers_dir(&state.app_data_dir, "collection", collection_id);
        let new_val = list_playlist_covers(&dir).into_iter().next();
        sqlx::query("UPDATE media_playlist_collection SET selected_cover = ? WHERE id = ?")
            .bind(&new_val).bind(collection_id)
            .execute(&state.app_db).await.map_err(|e| e.to_string())?;
        new_val
    } else {
        current
    };
    Ok(new_selected)
}

#[tauri::command]
pub async fn set_playlist_cover(
    state: tauri::State<'_, AppState>,
    playlist_id: i64,
    cover_path: Option<String>,
) -> Result<(), String> {
    sqlx::query("UPDATE media_playlist SET selected_cover = ? WHERE id = ?")
        .bind(&cover_path).bind(playlist_id)
        .execute(&state.app_db).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_playlist_collection_cover(
    state: tauri::State<'_, AppState>,
    collection_id: i64,
    cover_path: Option<String>,
) -> Result<(), String> {
    sqlx::query("UPDATE media_playlist_collection SET selected_cover = ? WHERE id = ?")
        .bind(&cover_path).bind(collection_id)
        .execute(&state.app_db).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistContents {
    pub entries: Vec<MediaEntry>,
    pub sort_mode: String,
    pub playlist_name: String,
    pub selected_preset_id: Option<i64>,
    pub presets: Vec<SortPresetSummary>,
}

// ── Sort presets ──────────────────────────────────────────────────────
// Saved custom orderings per sortable location. See the sort_preset table in db.rs.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SortPresetSummary {
    pub id: i64,
    pub name: String,
}

/// Route an UPDATE of `selected_preset_id` to the correct table/column given a scope key.
/// The scope-key format is `<prefix>:<id>` where prefix is one of
/// `lib-root` | `lib-coll` | `movies-only` | `shows-only` | `pl-root` | `pl-coll`. Library scopes
/// carry a TEXT library id; all others carry an INTEGER id.
async fn write_selected_preset_for_scope(
    pool: &sqlx::SqlitePool,
    scope_key: &str,
    preset_id: Option<i64>,
) -> Result<(), String> {
    let (prefix, value) = scope_key.split_once(':').ok_or("Invalid scope_key")?;
    match prefix {
        "lib-root" => {
            sqlx::query("UPDATE library SET library_root_selected_preset_id = ? WHERE id = ?")
                .bind(preset_id).bind(value)
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
        "movies-only" => {
            sqlx::query("UPDATE library SET movies_only_selected_preset_id = ? WHERE id = ?")
                .bind(preset_id).bind(value)
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
        "shows-only" => {
            sqlx::query("UPDATE library SET shows_only_selected_preset_id = ? WHERE id = ?")
                .bind(preset_id).bind(value)
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
        "lib-coll" => {
            let id: i64 = value.parse().map_err(|_| "Invalid collection id in scope_key")?;
            sqlx::query("UPDATE media_collection SET selected_preset_id = ? WHERE id = ?")
                .bind(preset_id).bind(id)
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
        "pl-root" => {
            let id: i64 = value.parse().map_err(|_| "Invalid playlist id in scope_key")?;
            sqlx::query("UPDATE media_playlist SET selected_preset_id = ? WHERE id = ?")
                .bind(preset_id).bind(id)
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
        "pl-coll" => {
            let id: i64 = value.parse().map_err(|_| "Invalid playlist-collection id in scope_key")?;
            sqlx::query("UPDATE media_playlist_collection SET selected_preset_id = ? WHERE id = ?")
                .bind(preset_id).bind(id)
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
        "playlists" => {
            // The playlists-LIST has no owning row/column, so its selected preset id lives in the
            // settings table keyed by library id (value carries the TEXT library id here).
            let key = format!("playlists_selected_preset:{value}");
            match preset_id {
                Some(pid) => {
                    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
                        .bind(&key).bind(pid.to_string())
                        .execute(pool).await.map_err(|e| e.to_string())?;
                }
                None => {
                    sqlx::query("DELETE FROM settings WHERE key = ?")
                        .bind(&key)
                        .execute(pool).await.map_err(|e| e.to_string())?;
                }
            }
        }
        other => return Err(format!("Unknown scope_key prefix: {other}")),
    }
    Ok(())
}

/// Force a scope's stored sort_mode to "custom". A saved preset IS a custom ordering, and the
/// per-scope apply logic only honours `selected_preset_id` when sort_mode isn't "alpha" (alpha is
/// a hard SQL sort that overrides everything). So selecting/saving a preset must also flip the
/// scope out of alpha, or the preset is silently ignored. Mirrors the routing in
/// `write_selected_preset_for_scope`; the playlists-LIST scope keeps its sort_mode in settings.
async fn set_scope_sort_mode_custom(
    pool: &sqlx::SqlitePool,
    scope_key: &str,
) -> Result<(), String> {
    let (prefix, value) = scope_key.split_once(':').ok_or("Invalid scope_key")?;
    // Library scopes carry a TEXT id; collection/playlist scopes an INTEGER id; the playlists-LIST
    // keeps its sort_mode in settings. Bind the id with the matching type per scope.
    match prefix {
        "lib-root" => {
            sqlx::query("UPDATE library SET default_sort_mode = 'custom' WHERE id = ?")
                .bind(value).execute(pool).await.map_err(|e| e.to_string())?;
        }
        "movies-only" => {
            sqlx::query("UPDATE library SET movies_sort_mode = 'custom' WHERE id = ?")
                .bind(value).execute(pool).await.map_err(|e| e.to_string())?;
        }
        "shows-only" => {
            sqlx::query("UPDATE library SET shows_sort_mode = 'custom' WHERE id = ?")
                .bind(value).execute(pool).await.map_err(|e| e.to_string())?;
        }
        "lib-coll" => {
            let id: i64 = value.parse().map_err(|_| "Invalid collection id in scope_key")?;
            sqlx::query("UPDATE media_collection SET sort_mode = 'custom' WHERE id = ?")
                .bind(id).execute(pool).await.map_err(|e| e.to_string())?;
        }
        "pl-root" => {
            let id: i64 = value.parse().map_err(|_| "Invalid playlist id in scope_key")?;
            sqlx::query("UPDATE media_playlist SET sort_mode = 'custom' WHERE id = ?")
                .bind(id).execute(pool).await.map_err(|e| e.to_string())?;
        }
        "pl-coll" => {
            let id: i64 = value.parse().map_err(|_| "Invalid playlist-collection id in scope_key")?;
            sqlx::query("UPDATE media_playlist_collection SET sort_mode = 'custom' WHERE id = ?")
                .bind(id).execute(pool).await.map_err(|e| e.to_string())?;
        }
        "playlists" => {
            sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, 'custom')")
                .bind(format!("playlists_sort_mode:{value}"))
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
        other => return Err(format!("Unknown scope_key prefix: {other}")),
    }
    Ok(())
}

/// Upsert a preset scoped to `scope_key`. Returns the preset id. Collisions on
/// `(scope_key, name)` without `overwrite=true` are signalled by the literal error string "exists"
/// so the frontend can swap the save dialog into "Overwrite?" confirm mode and retry.
#[tauri::command]
pub async fn save_sort_preset(
    state: tauri::State<'_, AppState>,
    scope_key: String,
    name: String,
    items: serde_json::Value,
    overwrite: bool,
) -> Result<i64, String> {
    let items_json = serde_json::to_string(&items).map_err(|e| e.to_string())?;
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM sort_preset WHERE scope_key = ? AND name = ?",
    )
    .bind(&scope_key)
    .bind(&name)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let id = match existing {
        Some((id,)) => {
            if !overwrite { return Err("exists".to_string()); }
            sqlx::query("UPDATE sort_preset SET items = ? WHERE id = ?")
                .bind(&items_json).bind(id)
                .execute(&state.app_db).await.map_err(|e| e.to_string())?;
            id
        }
        None => {
            let res = sqlx::query(
                "INSERT INTO sort_preset (scope_key, name, items) VALUES (?, ?, ?)",
            )
            .bind(&scope_key).bind(&name).bind(&items_json)
            .execute(&state.app_db).await.map_err(|e| e.to_string())?;
            res.last_insert_rowid()
        }
    };
    // Saving auto-selects the new preset; ensure the scope is in custom sort so it actually
    // takes effect (alpha would override it).
    set_scope_sort_mode_custom(&state.app_db, &scope_key).await?;
    write_selected_preset_for_scope(&state.app_db, &scope_key, Some(id)).await?;
    Ok(id)
}

#[tauri::command]
pub async fn get_sort_presets(
    state: tauri::State<'_, AppState>,
    scope_key: String,
) -> Result<Vec<SortPresetSummary>, String> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, name FROM sort_preset WHERE scope_key = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(&scope_key)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(id, name)| SortPresetSummary { id, name }).collect())
}

/// Delete a preset by id. Explicitly clears any `selected_preset_id` column that references it —
/// we don't rely on SQLite FK ON DELETE SET NULL because foreign_keys pragma state isn't guaranteed
/// and the selected_preset_id columns were added without the FK clause in some code paths.
#[tauri::command]
pub async fn delete_sort_preset(
    state: tauri::State<'_, AppState>,
    preset_id: i64,
) -> Result<(), String> {
    sqlx::query("DELETE FROM sort_preset WHERE id = ?")
        .bind(preset_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    // Null out any pointers that referenced the deleted preset.
    for sql in [
        "UPDATE library SET library_root_selected_preset_id = NULL WHERE library_root_selected_preset_id = ?",
        "UPDATE library SET movies_only_selected_preset_id = NULL WHERE movies_only_selected_preset_id = ?",
        "UPDATE library SET shows_only_selected_preset_id = NULL WHERE shows_only_selected_preset_id = ?",
        "UPDATE media_collection SET selected_preset_id = NULL WHERE selected_preset_id = ?",
        "UPDATE media_playlist SET selected_preset_id = NULL WHERE selected_preset_id = ?",
        "UPDATE media_playlist_collection SET selected_preset_id = NULL WHERE selected_preset_id = ?",
    ] {
        sqlx::query(sql).bind(preset_id)
            .execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }
    // The playlists-LIST scope stores its selected preset in settings, not a column.
    sqlx::query("DELETE FROM settings WHERE key LIKE 'playlists_selected_preset:%' AND value = ?")
        .bind(preset_id.to_string())
        .execute(&state.app_db).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_selected_preset(
    state: tauri::State<'_, AppState>,
    scope_key: String,
    preset_id: Option<i64>,
) -> Result<(), String> {
    // Validate the preset actually belongs to the given scope when selecting a non-null id —
    // guards against the frontend sending a mismatched id by mistake.
    if let Some(pid) = preset_id {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT scope_key FROM sort_preset WHERE id = ?",
        )
        .bind(pid)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
        match row {
            Some((sk,)) if sk == scope_key => {}
            Some(_) => return Err("preset scope mismatch".to_string()),
            None => return Err("preset not found".to_string()),
        }
        // A preset is a custom ordering — selecting one only takes effect if the scope isn't in
        // "alpha" (which hard-overrides the preset). Flip it to custom so the preset actually applies.
        set_scope_sort_mode_custom(&state.app_db, &scope_key).await?;
    }
    write_selected_preset_for_scope(&state.app_db, &scope_key, preset_id).await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PlaylistSortItem {
    Link { id: i64 },
    Collection { id: i64 },
}

/// Rewrite sort_order across both media_link and media_playlist_collection so the
/// merged display list matches the provided order. Caller supplies every item at
/// the current level (root or nested) in its new position.
#[tauri::command]
pub async fn update_playlist_sort_order(
    state: tauri::State<'_, AppState>,
    // Scope of the reorder — exactly one of these identifies the level that was reordered,
    // so we can clear its selected_preset_id.
    //   parent_collection_id: Some(id) → inside a nested playlist-collection
    //   parent_collection_id: None + playlist_id: Some(id) → at the playlist root
    playlist_id: Option<i64>,
    parent_collection_id: Option<i64>,
    items: Vec<PlaylistSortItem>,
) -> Result<(), String> {
    for (i, item) in items.iter().enumerate() {
        match item {
            PlaylistSortItem::Link { id } => {
                sqlx::query("UPDATE media_link SET sort_order = ? WHERE id = ?")
                    .bind(i as i32)
                    .bind(id)
                    .execute(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            PlaylistSortItem::Collection { id } => {
                sqlx::query("UPDATE media_playlist_collection SET sort_order = ? WHERE id = ?")
                    .bind(i as i32)
                    .bind(id)
                    .execute(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    if let Some(cid) = parent_collection_id {
        sqlx::query("UPDATE media_playlist_collection SET selected_preset_id = NULL WHERE id = ?")
            .bind(cid)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    } else if let Some(pid) = playlist_id {
        sqlx::query("UPDATE media_playlist SET selected_preset_id = NULL WHERE id = ?")
            .bind(pid)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_playlist_contents(
    state: tauri::State<'_, AppState>,
    playlist_id: i64,
    parent_collection_id: Option<i64>,
) -> Result<PlaylistContents, String> {
    // Look up the playlist's name (for breadcrumb labels) and its root sort_mode / selected preset.
    let playlist_row: Option<(String, String, String, Option<i64>)> = sqlx::query_as(
        "SELECT title, sort_mode, library_id, selected_preset_id FROM media_playlist WHERE id = ?",
    )
    .bind(playlist_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let (playlist_name, playlist_sort_mode, library_id, playlist_preset_id) =
        playlist_row.ok_or("Playlist not found")?;

    // The sort mode + selected preset at the current level depend on whether we're at the
    // playlist root or inside a nested playlist-collection.
    let (sort_mode, selected_preset_id, scope_key) = if let Some(cid) = parent_collection_id {
        let row: Option<(String, Option<i64>)> = sqlx::query_as(
            "SELECT sort_mode, selected_preset_id FROM media_playlist_collection WHERE id = ?",
        )
        .bind(cid)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
        let (mode, pid) = row.unwrap_or_else(|| ("custom".to_string(), None));
        (mode, pid, format!("pl-coll:{}", cid))
    } else {
        (playlist_sort_mode, playlist_preset_id, format!("pl-root:{}", playlist_id))
    };

    // Available presets for this scope (shown in the sort dropdown).
    let presets: Vec<SortPresetSummary> = {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, name FROM sort_preset WHERE scope_key = ? ORDER BY created_at ASC, id ASC",
        )
        .bind(&scope_key)
        .fetch_all(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
        rows.into_iter().map(|(id, name)| SortPresetSummary { id, name }).collect()
    };

    // Shared cached-covers lookup — used to populate `covers` on every returned entry.
    // Use `.get().cloned()` (not `.remove()`) so duplicate links to the same media_entry
    // each get their covers hydrated instead of the first consuming them.
    let covers_map = get_all_cached_covers(&state.app_db, &library_id)
        .await
        .map_err(|e| e.to_string())?;

    // ── Links at this level ──
    // Columns mirror `media_entry_full` so we can hydrate a MediaEntry for each
    // target, INCLUDING the same subtitle fields the library grid computes — movie
    // year, show year-range, and the show season summary (so TV shows in playlists
    // show "seasons 1–6" instead of nothing).
    let show_episode_years = "\
        SELECT SUBSTR(e.release_date, 1, 4) as yr FROM episode e \
          JOIN season s ON e.season_id = s.id \
          WHERE s.show_id = mef.id AND e.release_date IS NOT NULL";
    let year_expr = format!("\
        CASE \
          WHEN mef.entry_type = 'movie' THEN SUBSTR(mef.release_date, 1, 4) \
          WHEN mef.entry_type = 'show' THEN (SELECT MIN(yr) FROM ({show_episode_years})) \
        END");
    let end_year_expr = format!("\
        CASE WHEN mef.entry_type = 'show' THEN \
          NULLIF((SELECT MAX(yr) FROM ({show_episode_years})), (SELECT MIN(yr) FROM ({show_episode_years}))) \
        END");
    // COALESCE(link.selected_cover, target.selected_cover) — the link's own override
    // wins; NULL falls back to whatever the target entry currently shows. The `?`
    // placeholders handle "playlist root" vs "nested collection".
    let link_query = format!(
        "SELECT ml.id, ml.sort_order, \
                mef.id, mef.title, \
                {year_expr} as year, \
                {end_year_expr} as end_year, \
                mef.folder_path, mef.parent_id, mef.entry_type, \
                COALESCE(ml.selected_cover, mef.selected_cover) as selected_cover, \
                mef.sort_title, \
                {SEASON_DISPLAY_EXPR} as season_display \
         FROM media_link ml \
         JOIN media_entry_full mef ON mef.id = ml.target_entry_id \
         WHERE (ml.parent_playlist_id IS ? AND ml.parent_collection_id IS ?)"
    );
    let link_rows: Vec<(
        i64, i64, i64,
        String, Option<String>, Option<String>, String, Option<i64>, String, Option<String>, Option<String>, Option<String>,
    )> = sqlx::query_as(&link_query)
        .bind(if parent_collection_id.is_none() { Some(playlist_id) } else { None })
        .bind(parent_collection_id)
        .fetch_all(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    // ── Nested playlist-collections at this level ──
    let collection_rows: Vec<(i64, String, Option<String>, i64, String)> = sqlx::query_as(
        "SELECT id, title, selected_cover, sort_order, sort_title FROM media_playlist_collection \
         WHERE (parent_playlist_id IS ? AND parent_collection_id IS ?)",
    )
    .bind(if parent_collection_id.is_none() { Some(playlist_id) } else { None })
    .bind(parent_collection_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    // Build the merged list. Each playlist-collection becomes an entry with entry_type="playlist_collection".
    // Each link is hydrated from its target entry's row. We carry (sort_order, sort_title) alongside
    // each item to apply the current sort mode uniformly after merging.
    let mut items: Vec<(i64, String, MediaEntry)> = Vec::new();

    for (link_id, sort_order, id, title, year, end_year, folder_path, parent_id, entry_type, selected_cover, sort_title, season_display) in link_rows {
        let covers = covers_map.get(&folder_path).cloned().unwrap_or_default();
        let entry = MediaEntry {
            id,
            title,
            year,
            end_year,
            folder_path,
            parent_id,
            entry_type,
            covers,
            selected_cover,
            child_count: 0,
            season_display,
            collection_display: None,
            role_display: None,
            tmdb_id: None,
            link_id: Some(link_id),
        };
        items.push((sort_order, sort_title.unwrap_or_default(), entry));
    }

    for (id, title, selected_cover, sort_order, sort_title) in collection_rows {
        // Count children (links + sub-collections) for display.
        let child_count: (i64,) = sqlx::query_as(
            "SELECT \
                (SELECT COUNT(*) FROM media_link WHERE parent_collection_id = ?) \
              + (SELECT COUNT(*) FROM media_playlist_collection WHERE parent_collection_id = ?)",
        )
        .bind(id)
        .bind(id)
        .fetch_one(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

        // Aggregate movie/show counts + year range over this grouping's links
        // (recursing through nested groupings) for the "N movies and M shows ·
        // 2008–2014" subtitle — mirrors how library collections summarize.
        let (movie_count, show_count): (i64, i64) = sqlx::query_as(
            "WITH RECURSIVE pc_descendants(id) AS ( \
                SELECT ? \
                UNION ALL \
                SELECT mpc.id FROM media_playlist_collection mpc JOIN pc_descendants d ON mpc.parent_collection_id = d.id \
             ) \
             SELECT \
                COALESCE(SUM(CASE WHEN met.name = 'movie' THEN 1 ELSE 0 END), 0), \
                COALESCE(SUM(CASE WHEN met.name = 'show' THEN 1 ELSE 0 END), 0) \
             FROM media_link ml \
             JOIN media_entry me ON me.id = ml.target_entry_id \
             JOIN media_entry_type met ON me.entry_type_id = met.id \
             WHERE ml.parent_collection_id IN (SELECT id FROM pc_descendants)",
        )
        .bind(id)
        .fetch_one(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

        let (min_year, max_year): (Option<String>, Option<String>) = sqlx::query_as(
            "WITH RECURSIVE pc_descendants(id) AS ( \
                SELECT ? \
                UNION ALL \
                SELECT mpc.id FROM media_playlist_collection mpc JOIN pc_descendants d ON mpc.parent_collection_id = d.id \
             ), \
             targets AS ( \
                SELECT ml.target_entry_id AS tid FROM media_link ml \
                  WHERE ml.parent_collection_id IN (SELECT id FROM pc_descendants) \
             ) \
             SELECT MIN(yr), MAX(yr) FROM ( \
                SELECT SUBSTR(m.release_date, 1, 4) AS yr FROM movie m \
                  WHERE m.id IN (SELECT tid FROM targets) AND m.release_date IS NOT NULL \
                UNION ALL \
                SELECT SUBSTR(e.release_date, 1, 4) AS yr FROM episode e \
                  JOIN season s ON e.season_id = s.id \
                  WHERE s.show_id IN (SELECT tid FROM targets) AND e.release_date IS NOT NULL \
             )",
        )
        .bind(id)
        .fetch_one(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

        let collection_display = {
            let mut parts: Vec<String> = Vec::new();
            if movie_count > 0 {
                parts.push(if movie_count == 1 { "1 movie".to_string() } else { format!("{movie_count} movies") });
            }
            if show_count > 0 {
                parts.push(if show_count == 1 { "1 show".to_string() } else { format!("{show_count} shows") });
            }
            // An empty grouping reads "empty" rather than showing no subtitle.
            Some(if parts.is_empty() { "empty".to_string() } else { parts.join(" and ") })
        };
        // Only carry an end_year when it actually differs (avoids "2014–2014").
        let end_year = match (&min_year, &max_year) {
            (Some(a), Some(b)) if a != b => Some(b.clone()),
            _ => None,
        };

        let cover_dir = playlist_covers_dir(&state.app_data_dir, "collection", id);
        let collection_covers = list_playlist_covers(&cover_dir);
        let entry = MediaEntry {
            id,
            title,
            year: min_year,
            end_year,
            folder_path: String::new(),
            parent_id: None,
            entry_type: "playlist_collection".to_string(),
            covers: collection_covers,
            selected_cover,
            child_count: child_count.0,
            season_display: None,
            collection_display,
            role_display: None,
            tmdb_id: None,
            link_id: None,
        };
        items.push((sort_order, sort_title, entry));
    }

    // Apply sort mode. Custom-sort with a selected preset overrides the normal sort_order
    // with the preset's saved order (items not in the preset tail onto the end).
    let entries: Vec<MediaEntry> = if sort_mode == "alpha" {
        items.sort_by(|a, b| a.1.cmp(&b.1));
        items.into_iter().map(|(_, _, e)| e).collect()
    } else if let Some(pid) = selected_preset_id {
        items.sort_by_key(|t| t.0);
        apply_playlist_preset_ordering(&state.app_db, pid, items).await?
    } else {
        items.sort_by_key(|t| t.0);
        items.into_iter().map(|(_, _, e)| e).collect()
    };

    Ok(PlaylistContents {
        entries,
        sort_mode,
        playlist_name,
        selected_preset_id,
        presets,
    })
}

/// Library-scope preset ordering. Preset items are `{kind:"entry",id:N}` referencing media_entry.id.
/// Stale ids are dropped; remaining entries trail in their current sort_order.
async fn apply_library_preset_ordering(
    pool: &sqlx::SqlitePool,
    preset_id: i64,
    entries: Vec<MediaEntry>,
) -> Result<Vec<MediaEntry>, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT items FROM sort_preset WHERE id = ?")
        .bind(preset_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let Some((items_json,)) = row else { return Ok(entries); };

    #[derive(serde::Deserialize)]
    struct LibraryPresetItem {
        #[serde(rename = "kind")]
        _kind: String,
        id: i64,
    }
    let preset_items: Vec<LibraryPresetItem> = serde_json::from_str(&items_json).unwrap_or_default();

    // Preserve the caller's iteration order (sort_order) via a parallel `order` vec so
    // remaining items keep their sort_order sequence after the preset prefix.
    let mut by_id: std::collections::HashMap<i64, MediaEntry> = std::collections::HashMap::new();
    let mut order: Vec<i64> = Vec::new();
    for e in entries {
        order.push(e.id);
        by_id.insert(e.id, e);
    }

    let before = preset_items.len();
    let mut out: Vec<MediaEntry> = Vec::new();
    let mut kept_ids: Vec<i64> = Vec::new();
    for pi in preset_items {
        if let Some(entry) = by_id.remove(&pi.id) {
            out.push(entry);
            kept_ids.push(pi.id);
        }
    }
    for id in order {
        if let Some(entry) = by_id.remove(&id) {
            out.push(entry);
        }
    }

    if kept_ids.len() != before {
        let pruned: Vec<serde_json::Value> = kept_ids
            .into_iter()
            .map(|id| serde_json::json!({"kind":"entry","id":id}))
            .collect();
        if let Ok(new_json) = serde_json::to_string(&pruned) {
            let _ = sqlx::query("UPDATE sort_preset SET items = ? WHERE id = ?")
                .bind(&new_json).bind(preset_id)
                .execute(pool).await;
        }
    }

    Ok(out)
}

/// Reorder playlist items by a preset's saved sequence, dropping stale ids and appending
/// remaining items in their current sort_order. Prunes stale entries from the preset row
/// opportunistically so the JSON doesn't grow unbounded.
async fn apply_playlist_preset_ordering(
    pool: &sqlx::SqlitePool,
    preset_id: i64,
    items: Vec<(i64, String, MediaEntry)>,
) -> Result<Vec<MediaEntry>, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT items FROM sort_preset WHERE id = ?")
        .bind(preset_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let Some((items_json,)) = row else {
        return Ok(items.into_iter().map(|(_, _, e)| e).collect());
    };
    let preset_items: Vec<PlaylistSortItem> = serde_json::from_str(&items_json).unwrap_or_default();

    // Index live entries by (kind, id). Kind "link" → link_id; kind "collection" → id for playlist_collection.
    // `order` preserves the caller's iteration order (already sort_order-ordered).
    let mut by_key: std::collections::HashMap<(String, i64), MediaEntry> =
        std::collections::HashMap::new();
    let mut order: Vec<(String, i64)> = Vec::new();
    for (_, _, e) in items {
        let key = if let Some(lid) = e.link_id {
            ("link".to_string(), lid)
        } else {
            ("collection".to_string(), e.id)
        };
        order.push(key.clone());
        by_key.insert(key, e);
    }

    let before = preset_items.len();
    let mut out: Vec<MediaEntry> = Vec::new();
    let mut kept: Vec<PlaylistSortItem> = Vec::new();
    for pi in preset_items {
        let key = match &pi {
            PlaylistSortItem::Link { id } => ("link".to_string(), *id),
            PlaylistSortItem::Collection { id } => ("collection".to_string(), *id),
        };
        if let Some(entry) = by_key.remove(&key) {
            out.push(entry);
            kept.push(pi);
        }
    }
    for key in order {
        if let Some(entry) = by_key.remove(&key) {
            out.push(entry);
        }
    }

    // Opportunistic prune: if some preset items were stale, rewrite the preset JSON without them.
    if kept.len() != before {
        if let Ok(new_json) = serde_json::to_string(&kept.iter().map(|pi| match pi {
            PlaylistSortItem::Link { id } => serde_json::json!({"kind":"link","id":id}),
            PlaylistSortItem::Collection { id } => serde_json::json!({"kind":"collection","id":id}),
        }).collect::<Vec<_>>()) {
            let _ = sqlx::query("UPDATE sort_preset SET items = ? WHERE id = ?")
                .bind(&new_json).bind(preset_id)
                .execute(pool).await;
        }
    }

    Ok(out)
}

#[tauri::command]
pub async fn get_movie_file_path(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
) -> Result<String, String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;
    let lib_paths = _paths;

    let folder_path: String = match format.as_str() {
        "video" => {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT folder_path FROM media_entry_full WHERE id = ?",
            )
            .bind(entry_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
            row.ok_or("Entry not found")?.0
        }
        _ => {
            return Err(format!("Unsupported library format: {}", format));
        }
    };


    let root = resolve_entry_root(&lib_paths, &folder_path)
        .ok_or("Could not find entry on disk")?;
    let full_folder = PathBuf::from(root).join(&folder_path);

    let video_file = std::fs::read_dir(&full_folder)
        .map_err(|e| format!("Cannot read folder: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS))
        .map(|e| e.path())
        .next()
        .ok_or("No video file found in movie folder")?;

    Ok(video_file.to_string_lossy().into_owned())
}

// ---------- Ratings (RT scraper + optional OMDB) ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RatingInfo {
    /// 'rotten_tomatoes_audience' | 'rotten_tomatoes' | 'imdb' | 'metacritic'
    pub source: String,
    pub value: String,
}

enum OmdbOutcome {
    Found(Vec<(String, String)>),
    /// OMDB has no entry for this id — a normal result, not an error.
    NotFound,
}

/// Classified OMDB fetch: fatal conditions (rejected key, quota, network) are
/// Err with a user-facing message so callers can stop and report instead of
/// mistaking them for "this title has no ratings".
async fn fetch_omdb(
    client: &reqwest::Client,
    key: &str,
    imdb_id: &str,
) -> Result<OmdbOutcome, String> {
    let url = format!("https://www.omdbapi.com/?i={imdb_id}&apikey={key}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|_| "Couldn't reach OMDB — check your connection.".to_string())?;
    // OMDB sends a JSON Error body even on 401s — classify by it, not status.
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| "OMDB returned an unreadable response.".to_string())?;
    if let Some(err) = body.get("Error").and_then(|v| v.as_str()) {
        let lower = err.to_lowercase();
        if lower.contains("limit") {
            return Err("OMDB daily request limit reached — try again tomorrow.".into());
        }
        if lower.contains("api key") {
            return Err("OMDB rejected the API key — check Settings.".into());
        }
        // "Incorrect IMDb ID." / "Movie not found!" and friends.
        return Ok(OmdbOutcome::NotFound);
    }
    let mut out = Vec::new();
    if let Some(r) = body.get("imdbRating").and_then(|v| v.as_str()) {
        if r != "N/A" && !r.is_empty() {
            out.push(("imdb".to_string(), r.to_string()));
        }
    }
    if let Some(ratings) = body.get("Ratings").and_then(|v| v.as_array()) {
        for r in ratings {
            let source = r.get("Source").and_then(|v| v.as_str()).unwrap_or("");
            let value = r.get("Value").and_then(|v| v.as_str()).unwrap_or("");
            if value.is_empty() || value == "N/A" {
                continue;
            }
            match source {
                "Rotten Tomatoes" => out.push(("rotten_tomatoes".to_string(), value.to_string())),
                "Metacritic" => {
                    out.push(("metacritic".to_string(), value.trim_end_matches("/100").to_string()))
                }
                _ => {}
            }
        }
    }
    Ok(OmdbOutcome::Found(out))
}

/// Cached ratings only — never fetches. Fetching is always explicit, via
/// `fetch_ratings` (detail-page context menu or the bulk match dialog).
#[tauri::command]
pub async fn get_ratings(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
) -> Result<Vec<RatingInfo>, String> {
    let cached: Vec<(String, String)> =
        sqlx::query_as("SELECT source, value FROM rating WHERE entry_id = ?")
            .bind(entry_id)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    Ok(cached
        .into_iter()
        .filter(|(s, _)| s != "none")
        .map(|(source, value)| RatingInfo { source, value })
        .collect())
}

/// Fetch ratings for one movie and cache them, replacing whatever was stored.
/// Requires the OMDB setting (IMDb / Metacritic / RT critics); when the RT
/// audience setting is also enabled, the scraper adds the audience score.
/// Per-movie gaps (no IMDb id, no RT page) are not errors — they just yield
/// fewer sources.
#[tauri::command]
pub async fn fetch_ratings(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
) -> Result<Vec<RatingInfo>, String> {
    let setting = |key: &'static str| {
        let db = state.app_db.clone();
        async move {
            sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
                .bind(key)
                .fetch_optional(&db)
                .await
                .ok()
                .flatten()
        }
    };
    let omdb_enabled = setting("omdb_enabled").await.as_deref() == Some("true");
    let omdb_key = setting("omdb_api_key").await.filter(|k| !k.trim().is_empty());
    let rt_enabled = setting("rt_scraper_enabled").await.as_deref() == Some("true");

    if !omdb_enabled {
        return Err("Enable OMDB ratings in Settings first.".into());
    }
    let Some(key) = omdb_key else {
        return Err("No OMDB API key configured. Add one in Settings.".into());
    };

    let movie: Option<(String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT title, SUBSTR(release_date, 1, 4), imdb_id, rotten_tomatoes_id FROM movie WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    // Shows: imdb_id lives on the show row; the start year is derived from the
    // earliest episode air date; the RT slug caches in the rt_slug side table.
    let (title, year, imdb_id, rt_id, is_show) = if let Some((t, y, i, r)) = movie {
        (t, y, i, r, false)
    } else {
        let show: Option<(String, Option<String>)> =
            sqlx::query_as("SELECT title, imdb_id FROM show WHERE id = ?")
                .bind(entry_id)
                .fetch_optional(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        let Some((t, i)) = show else {
            return Err("Ratings are only supported for movies and TV shows.".into());
        };
        let y: Option<String> = sqlx::query_scalar(
            "SELECT MIN(SUBSTR(e.release_date, 1, 4)) FROM episode e \
             JOIN season s ON e.season_id = s.id \
             WHERE s.show_id = ? AND e.release_date IS NOT NULL",
        )
        .bind(entry_id)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
        let slug: Option<String> = sqlx::query_scalar("SELECT slug FROM rt_slug WHERE entry_id = ?")
            .bind(entry_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        (t, y, i, slug, true)
    };

    let client = reqwest::Client::new();
    let mut found: Vec<RatingInfo> = Vec::new();

    // OMDB: IMDb + Metacritic + RT critic score. Fatal problems (bad key,
    // quota, network) return Err BEFORE the cache is touched, so a failed
    // re-fetch never destroys previously stored ratings.
    let has_imdb = imdb_id.as_deref().is_some_and(|i| !i.trim().is_empty());
    let mut omdb_confirmed = false;
    if let Some(imdb) = imdb_id.as_deref().filter(|i| !i.trim().is_empty()) {
        match fetch_omdb(&client, key.trim(), imdb.trim()).await? {
            OmdbOutcome::Found(list) => {
                omdb_confirmed = true;
                for (source, value) in list {
                    if !found.iter().any(|r| r.source == source) {
                        found.push(RatingInfo { source, value });
                    }
                }
            }
            // Confirmed absent — that's an answer, and it's cacheable.
            OmdbOutcome::NotFound => omdb_confirmed = true,
        }
    }

    // Rotten Tomatoes audience score (scraper) — opt-in on top of OMDB.
    if rt_enabled {
        let scores = if is_show {
            crate::rt::fetch_tv_scores(&client, &title, year.as_deref(), rt_id.as_deref()).await
        } else {
            crate::rt::fetch_movie_scores(&client, &title, year.as_deref(), rt_id.as_deref()).await
        };
        if let Some(scores) = scores {
            if let Some(a) = scores.audience {
                found.push(RatingInfo {
                    source: "rotten_tomatoes_audience".into(),
                    value: format!("{a}%"),
                });
            }
            // Self-heal: remember the slug so future fetches skip discovery. The
            // user can overwrite a movie's in Edit mode if the scraper matched wrong.
            if is_show {
                let _ = sqlx::query("INSERT OR IGNORE INTO rt_slug (entry_id, slug) VALUES (?, ?)")
                    .bind(entry_id)
                    .bind(&scores.slug)
                    .execute(&state.app_db)
                    .await;
            } else {
                let _ = sqlx::query(
                    "UPDATE movie SET rotten_tomatoes_id = ? WHERE id = ? AND (rotten_tomatoes_id IS NULL OR rotten_tomatoes_id = '')",
                )
                .bind(&scores.slug)
                .bind(entry_id)
                .execute(&state.app_db)
                .await;
            }
        }
    }

    // No IMDb id means OMDB never ran — unless the RT scrape still found
    // something, the actionable answer is "match the title first", not
    // "no ratings exist". (Erroring also leaves any cached ratings intact.)
    if !omdb_confirmed && found.is_empty() {
        if !has_imdb {
            return Err("No IMDb ID — match to TMDB first.".into());
        }
        return Err("Ratings lookup failed.".into());
    }

    // Replace the cache — only reachable after a confirmed OMDB answer (or an
    // RT-only success). An empty confirmed result stores the 'none' sentinel:
    // "fetch attempted, nothing found", distinguishable from never-fetched.
    sqlx::query("DELETE FROM rating WHERE entry_id = ?")
        .bind(entry_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    if found.is_empty() {
        sqlx::query("INSERT OR REPLACE INTO rating (entry_id, source, value) VALUES (?, 'none', '')")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }
    for r in &found {
        sqlx::query("INSERT OR REPLACE INTO rating (entry_id, source, value) VALUES (?, ?, ?)")
            .bind(entry_id)
            .bind(&r.source)
            .bind(&r.value)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(found)
}

/// Manually set rating values for an entry. Each source with a non-empty value is
/// upserted; an empty value clears that source. Shares the `rating` table with
/// `fetch_ratings` (no origin flag — see TODO), so a later "Get ratings" run will
/// overwrite these for any source it returns.
#[tauri::command]
pub async fn set_manual_ratings(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
    ratings: Vec<RatingInfo>,
) -> Result<(), String> {
    for r in &ratings {
        let value = r.value.trim();
        if value.is_empty() {
            sqlx::query("DELETE FROM rating WHERE entry_id = ? AND source = ?")
                .bind(entry_id)
                .bind(&r.source)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        } else {
            sqlx::query("INSERT OR REPLACE INTO rating (entry_id, source, value) VALUES (?, ?, ?)")
                .bind(entry_id)
                .bind(&r.source)
                .bind(value)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Manually set the IMDb / Rotten Tomatoes ids for an entry. Writes to whichever
/// table owns it: movie columns, or the show row + the `rt_slug` side table
/// (shows have no RT column of their own). Empty/blank clears the id.
#[tauri::command]
pub async fn set_rater_ids(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
    imdb_id: Option<String>,
    rt_id: Option<String>,
) -> Result<(), String> {
    let norm = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let imdb = norm(imdb_id);
    let rt = norm(rt_id);

    let is_movie: Option<(i64,)> = sqlx::query_as("SELECT id FROM movie WHERE id = ?")
        .bind(entry_id)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    if is_movie.is_some() {
        sqlx::query("UPDATE movie SET imdb_id = ?, rotten_tomatoes_id = ? WHERE id = ?")
            .bind(&imdb)
            .bind(&rt)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    sqlx::query("UPDATE show SET imdb_id = ? WHERE id = ?")
        .bind(&imdb)
        .bind(entry_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    match rt {
        Some(slug) => {
            sqlx::query("INSERT OR REPLACE INTO rt_slug (entry_id, slug) VALUES (?, ?)")
                .bind(entry_id)
                .bind(&slug)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
        None => {
            sqlx::query("DELETE FROM rt_slug WHERE entry_id = ?")
                .bind(entry_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------- Extras ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExtraInfo {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub file_path: String,
    pub plot: Option<String>,
    pub release_date: Option<String>,
    pub runtime: Option<i64>,
}

#[tauri::command]
pub async fn get_extras(
    state: tauri::State<'_, AppState>,
    entry_id: i64,
) -> Result<Vec<ExtraInfo>, String> {
    let rows: Vec<(i64, String, String, String, Option<String>, Option<String>, Option<i64>)> =
        sqlx::query_as(
            "SELECT id, kind, title, file_path, plot, release_date, runtime \
             FROM extra WHERE owner_id = ? ORDER BY kind, sort_order",
        )
        .bind(entry_id)
        .fetch_all(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, kind, title, file_path, plot, release_date, runtime)| ExtraInfo {
            id,
            kind,
            title,
            file_path,
            plot,
            release_date,
            runtime,
        })
        .collect())
}

#[tauri::command]
pub async fn get_extra_file_path(
    state: tauri::State<'_, AppState>,
    library_id: String,
    extra_id: i64,
) -> Result<String, String> {
    let lib_paths = get_library_paths(&state.app_db, &library_id).await?;
    let row: Option<(String,)> = sqlx::query_as("SELECT file_path FROM extra WHERE id = ?")
        .bind(extra_id)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    let (file_path,) = row.ok_or("Extra not found")?;

    for p in &lib_paths {
        let full = Path::new(p).join(&file_path);
        if full.exists() {
            return Ok(full.to_string_lossy().into_owned());
        }
    }
    Err("Extra file not found on disk".to_string())
}

/// Normalize a title for fuzzy webisode↔TMDB-episode matching.
fn norm_match_title(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Populate TMDB metadata for a show's webisode extras by matching against the
/// show's TMDB "Specials" season (season 0). `extra_id = None` covers all of the
/// owner's webisodes. Returns the number of extras that found a match. Webisodes
/// are the only extras kind TMDB catalogs — featurettes/trailers have no source.
#[tauri::command]
pub async fn populate_extras_metadata(
    state: tauri::State<'_, AppState>,
    owner_id: i64,
    extra_id: Option<i64>,
) -> Result<i64, String> {
    if let Some(eid) = extra_id {
        let kind: Option<(String,)> = sqlx::query_as("SELECT kind FROM extra WHERE id = ?")
            .bind(eid)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        if kind.map(|(k,)| k) != Some("webisodes".to_string()) {
            return Err("TMDB only catalogs webisodes — there's no metadata source for this type of extra.".into());
        }
    }

    let show_tmdb: Option<(Option<i64>,)> = sqlx::query_as("SELECT tmdb_id FROM show WHERE id = ?")
        .bind(owner_id)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    let tmdb_id = match show_tmdb {
        Some((Some(id),)) => id,
        Some((None,)) => return Err("Match this show to TMDB first.".into()),
        None => return Err("Webisode metadata is only available for TV shows.".into()),
    };

    let extras: Vec<(i64, String)> = if let Some(eid) = extra_id {
        sqlx::query_as("SELECT id, title FROM extra WHERE id = ? AND owner_id = ?")
            .bind(eid)
            .bind(owner_id)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
    } else {
        sqlx::query_as("SELECT id, title FROM extra WHERE owner_id = ? AND kind = 'webisodes'")
            .bind(owner_id)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
    };
    if extras.is_empty() {
        return Ok(0);
    }

    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;

    let client = reqwest::Client::new();
    let specials = crate::tmdb::get_season_detail(&client, &token, tmdb_id, 0)
        .await
        .map_err(|e| format!("This show has no Specials season on TMDB ({e})"))?;

    let mut matched: i64 = 0;
    for (id, title) in &extras {
        // First try an explicit episode number in the filename, then fall back to
        // title containment against TMDB's episode names.
        let (_, file_num) = parse_episode_filename(title);
        let tmdb_ep = if let Some(n) = file_num {
            specials.episodes.iter().find(|e| e.episode_number == n as i64)
        } else {
            let want = norm_match_title(title);
            specials.episodes.iter().find(|e| {
                let name = norm_match_title(&e.name);
                !name.is_empty() && (want.contains(&name) || name.contains(&want))
            })
        };
        let Some(ep) = tmdb_ep else { continue };

        sqlx::query("UPDATE extra SET plot = ?, release_date = ?, runtime = ? WHERE id = ?")
            .bind(&ep.overview)
            .bind(&ep.air_date)
            .bind(ep.runtime)
            .bind(id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        matched += 1;
    }

    Ok(matched)
}

#[tauri::command]
pub async fn get_episode_file_path(
    state: tauri::State<'_, AppState>,
    library_id: String,
    episode_id: i64,
) -> Result<String, String> {
    let lib_paths = get_library_paths(&state.app_db, &library_id).await?;

    let ep_row: Option<(String,)> = sqlx::query_as(
        "SELECT file_path FROM episode WHERE id = ?",
    )
    .bind(episode_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;


    let file_path = ep_row.ok_or("Episode not found")?.0;

    let mut full_path: Option<PathBuf> = None;
    for p in &lib_paths {
        let candidate = PathBuf::from(p).join(&file_path);
        if candidate.exists() {
            full_path = Some(candidate);
            break;
        }
    }
    let full_path = full_path.ok_or("Episode file not found on disk")?;

    Ok(full_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn set_sort_mode(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: Option<i64>,
    // Disambiguates library-root / movies-only / shows-only when entry_id is None.
    // Valid values: "library-root" | "movies-only" | "shows-only". Omit for music libraries.
    scope_kind: Option<String>,
    sort_mode: String,
) -> Result<(), String> {
    if !["alpha", "date", "custom"].contains(&sort_mode.as_str()) {
        return Err("Invalid sort mode".to_string());
    }

    let row: Option<(String,)> = sqlx::query_as(
        "SELECT format FROM library WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (format,) = row.ok_or("Library not found")?;

    match entry_id {
        Some(eid) if format == "video" => {
            // Set sort_mode on a collection entry (video)
            sqlx::query("UPDATE media_collection SET sort_mode = ?, selected_preset_id = NULL WHERE id = ?")
                .bind(&sort_mode)
                .bind(eid)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
        Some(_) if format != "video" && format != "music" => {
            return Err(format!("Unsupported library format: {}", format));
        }
        _ if format == "video" => {
            // Video library: route to the correct per-view column based on scope_kind.
            let kind = scope_kind.as_deref().unwrap_or("library-root");
            let (mode_col, preset_col) = match kind {
                "movies-only" => ("movies_sort_mode", "movies_only_selected_preset_id"),
                "shows-only" => ("shows_sort_mode", "shows_only_selected_preset_id"),
                "library-root" => ("default_sort_mode", "library_root_selected_preset_id"),
                other => return Err(format!("Invalid scope_kind: {other}")),
            };
            let sql = format!(
                "UPDATE library SET {mode_col} = ?, {preset_col} = NULL WHERE id = ?"
            );
            sqlx::query(&sql)
                .bind(&sort_mode)
                .bind(&library_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
        _ => {
            // Music library: single default_sort_mode, no presets yet.
            sqlx::query("UPDATE library SET default_sort_mode = ? WHERE id = ?")
                .bind(&sort_mode)
                .bind(&library_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn update_sort_order(
    state: tauri::State<'_, AppState>,
    library_id: String,
    // Scope of the reorder — tells us which selected_preset_id to clear. Same-transaction semantics
    // make "reorder clears preset" atomic: if the sort_order writes succeed, so does the clear.
    //   entry_id: Some(collection_id) → library-root at that collection → clear media_collection.selected_preset_id
    //   entry_id: None + scope_kind "library-root" → clear library.library_root_selected_preset_id
    //   entry_id: None + scope_kind "movies-only" → clear library.movies_only_selected_preset_id
    //   entry_id: None + scope_kind "shows-only"  → clear library.shows_only_selected_preset_id
    entry_id: Option<i64>,
    scope_kind: Option<String>,
    entry_ids: Vec<i64>,
) -> Result<(), String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;

    match format.as_str() {
        "video" => {
            for (i, id) in entry_ids.iter().enumerate() {
                // Update whichever detail table owns this entry
                sqlx::query("UPDATE movie SET sort_order = ? WHERE id = ?")
                    .bind(i as i32).bind(id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
                sqlx::query("UPDATE show SET sort_order = ? WHERE id = ?")
                    .bind(i as i32).bind(id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
                sqlx::query("UPDATE media_collection SET sort_order = ? WHERE id = ?")
                    .bind(i as i32).bind(id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            }
            match entry_id {
                Some(eid) => {
                    sqlx::query("UPDATE media_collection SET selected_preset_id = NULL WHERE id = ?")
                        .bind(eid)
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                None => {
                    let preset_col = match scope_kind.as_deref() {
                        Some("movies-only") => "movies_only_selected_preset_id",
                        Some("shows-only") => "shows_only_selected_preset_id",
                        _ => "library_root_selected_preset_id",
                    };
                    let sql = format!("UPDATE library SET {preset_col} = NULL WHERE id = ?");
                    sqlx::query(&sql)
                        .bind(&library_id)
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        "music" => {
            for (i, id) in entry_ids.iter().enumerate() {
                sqlx::query("UPDATE artist SET sort_order = ? WHERE id = ?")
                    .bind(i as i32)
                    .bind(id)
                    .execute(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        _ => {
            return Err(format!("Unsupported library format: {}", format));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn rename_entry(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    new_title: String,
) -> Result<(), String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;

    // Rename is DB-only: waverunner never writes inside the media folders, so the
    // title changes while folder_path keeps pointing at the unchanged disk location.
    let sort_title = generate_sort_title(&new_title, "en");

    match format.as_str() {
        "video" => {
            // Update whichever detail table owns this entry
            sqlx::query("UPDATE movie SET title = ?, sort_title = ? WHERE id = ?")
                .bind(&new_title).bind(&sort_title).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            sqlx::query("UPDATE show SET title = ?, sort_title = ? WHERE id = ?")
                .bind(&new_title).bind(&sort_title).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            sqlx::query("UPDATE media_collection SET title = ?, sort_title = ? WHERE id = ?")
                .bind(&new_title).bind(&sort_title).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
        "music" => {
            sqlx::query("UPDATE artist SET name = ?, sort_name = ? WHERE id = ?")
                .bind(&new_title)
                .bind(&sort_title)
                .bind(entry_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
        _ => {
            return Err(format!("Unsupported library format: {}", format));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn move_entry(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    new_parent_id: Option<i64>,
    insert_before_id: Option<i64>,
) -> Result<(), String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;

    match format.as_str() {
        "video" => {
            // Get the entry being moved
            let entry_row: (Option<i64>,) = sqlx::query_as(
                "SELECT parent_id FROM media_entry_full WHERE id = ?",
            )
            .bind(entry_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Entry not found")?;

            let (old_parent_id,) = entry_row;

            // No-op if already in the target parent
            if old_parent_id == new_parent_id {
                return Ok(());
            }

            // Prevent moving into self or a descendant
            if let Some(target_id) = new_parent_id {
                if target_id == entry_id {
                    return Err("Cannot move entry into itself".to_string());
                }
                // Walk up from target to root, ensure we don't hit entry_id
                let mut check_id = Some(target_id);
                while let Some(cid) = check_id {
                    let parent: Option<(Option<i64>,)> = sqlx::query_as(
                        "SELECT parent_id FROM media_entry WHERE id = ?",
                    )
                    .bind(cid)
                    .fetch_optional(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;
                    match parent {
                        Some((Some(pid),)) => {
                            if pid == entry_id {
                                return Err("Cannot move entry into its own descendant".to_string());
                            }
                            check_id = Some(pid);
                        }
                        _ => { check_id = None; }
                    }
                }
            }

            // Moves are purely virtual: parent_id and sort_order change; folder_path
            // (the disk location) and the image cache never do.
            let db_result: Result<(), String> = async {
                let mut tx = state.app_db.begin().await.map_err(|e| e.to_string())?;

                // Determine sort_order for the moved entry
                // Note: sort_order is on detail tables but we can't use the view inside a transaction easily,
                // so we query all three and take the first result
                let new_sort_order: i64 = if let Some(before_id) = insert_before_id {
                    // Get sort_order from whichever detail table owns this entry
                    let before_order: i64 = {
                        let r: Option<(i64,)> = sqlx::query_as("SELECT sort_order FROM movie WHERE id = ?")
                            .bind(before_id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
                        if let Some((v,)) = r { v } else {
                            let r: Option<(i64,)> = sqlx::query_as("SELECT sort_order FROM show WHERE id = ?")
                                .bind(before_id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
                            if let Some((v,)) = r { v } else {
                                let r: Option<(i64,)> = sqlx::query_as("SELECT sort_order FROM media_collection WHERE id = ?")
                                    .bind(before_id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
                                r.ok_or("insert_before entry not found")?.0
                            }
                        }
                    };

                    // Increment sort_order for entries at/after insert position across all detail tables
                    for tbl in &["movie", "show", "media_collection"] {
                        sqlx::query(&format!(
                            "UPDATE {} SET sort_order = sort_order + 1 WHERE id IN (SELECT id FROM media_entry WHERE parent_id IS ? AND id != ?) AND sort_order >= ?", tbl
                        ))
                        .bind(new_parent_id)
                        .bind(entry_id)
                        .bind(before_order)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                    }

                    before_order
                } else {
                    // Get max sort_order from view-equivalent query
                    let max_val: Option<(Option<i64>,)> = sqlx::query_as(
                        "SELECT MAX(COALESCE(m.sort_order, s.sort_order, c.sort_order)) \
                         FROM media_entry me \
                         LEFT JOIN movie m ON me.id = m.id \
                         LEFT JOIN show s ON me.id = s.id \
                         LEFT JOIN media_collection c ON me.id = c.id \
                         WHERE me.parent_id IS ?",
                    )
                    .bind(new_parent_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    max_val.and_then(|r| r.0).map(|v| v + 1).unwrap_or(0)
                };

                // Update parent_id on media_entry (structural data stays here)
                sqlx::query("UPDATE media_entry SET parent_id = ? WHERE id = ?")
                    .bind(new_parent_id)
                    .bind(entry_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                // Update sort_order on the correct detail table
                for tbl in &["movie", "show", "media_collection"] {
                    sqlx::query(&format!("UPDATE {} SET sort_order = ? WHERE id = ?", tbl))
                        .bind(new_sort_order)
                        .bind(entry_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }

                tx.commit().await.map_err(|e| e.to_string())?;
                Ok(())
            }
            .await;

            db_result?;
        }
        _ => {
            return Err("Move is only supported for video format libraries".to_string());
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn create_collection(
    state: tauri::State<'_, AppState>,
    library_id: String,
    name: String,
    parent_id: Option<i64>,
) -> Result<i64, String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;
    if format != "video" {
        return Err("Collections are only supported for video libraries".to_string());
    }
    if name.trim().is_empty() {
        return Err("Invalid collection name".to_string());
    }

    // Get the collection entry type id
    let collection_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'collection'")
            .fetch_one(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;

    // Determine sort_order (append at end)
    let max_order: (i64,) = if parent_id.is_some() {
        sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM media_entry_full WHERE parent_id = ?")
            .bind(parent_id)
            .fetch_one(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
    } else {
        sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM media_entry_full WHERE parent_id IS NULL")
            .fetch_one(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
    };

    let sort_title = generate_sort_title(&name, "en");

    let result = sqlx::query(
        "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
    )
    .bind(&library_id)
    .bind(parent_id)
    .bind(collection_type_id.0)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let entry_id = result.last_insert_rowid();
    // Collections are virtual — no disk folder. The synthetic '@collection-{id}'
    // key keeps folder_path-keyed machinery (image cache, covers map) working
    // without ever colliding with a real disk path.
    sqlx::query("INSERT INTO media_collection (id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?)")
        .bind(entry_id)
        .bind(&name)
        .bind(format!("@collection-{}", entry_id))
        .bind(&sort_title)
        .bind(max_order.0 + 1)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(entry_id)
}

#[tauri::command]
pub async fn set_cover(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    cover_path: Option<String>,
) -> Result<(), String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;

    match format.as_str() {
        "video" => {
            // Update whichever detail table owns this entry
            sqlx::query("UPDATE movie SET selected_cover = ? WHERE id = ?")
                .bind(&cover_path).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            sqlx::query("UPDATE show SET selected_cover = ? WHERE id = ?")
                .bind(&cover_path).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            sqlx::query("UPDATE media_collection SET selected_cover = ? WHERE id = ?")
                .bind(&cover_path).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
        "music" => {
            sqlx::query("UPDATE artist SET selected_cover = ? WHERE id = ?")
                .bind(&cover_path)
                .bind(entry_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
        _ => {
            return Err(format!("Unsupported library format: {}", format));
        }
    }

    Ok(())
}

/// Delete a virtual collection. Movies and shows cannot be deleted from within
/// waverunner — the filesystem is the source of truth and rescan reconciles it.
/// Children of the deleted collection are reparented to the collection's parent.
#[tauri::command]
pub async fn delete_entry(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
) -> Result<(), String> {
    let entry_row: Option<(String, String, Option<i64>)> = sqlx::query_as(
        "SELECT folder_path, entry_type, parent_id FROM media_entry_full WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path, entry_type, parent_id) = entry_row.ok_or("Entry not found")?;

    if entry_type != "collection" {
        return Err("Only collections can be deleted. Media entries mirror the filesystem — remove the files and rescan.".into());
    }

    // Reparent children to the collection's parent before the row goes away
    // (the FK cascade would otherwise delete them).
    sqlx::query("UPDATE media_entry SET parent_id = ? WHERE parent_id = ?")
        .bind(parent_id)
        .bind(entry_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    // Clean up cached images (DB rows, cache dir, and app-data originals)
    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    delete_cached_images_for_entry(&state.app_db, &library_id, &cache_base, &folder_path).await?;
    let app_entry_dir = app_images_base(&state.app_data_dir, &library_id).join(&folder_path);
    if app_entry_dir.exists() {
        let _ = std::fs::remove_dir_all(&app_entry_dir);
    }

    // Purge presets scoped to this collection
    let _ = sqlx::query("DELETE FROM sort_preset WHERE scope_key = ?")
        .bind(format!("lib-coll:{}", entry_id))
        .execute(&state.app_db)
        .await;

    sqlx::query("DELETE FROM media_entry WHERE id = ?")
        .bind(entry_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn rescan_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<Vec<String>, String> {
    let (format, lib_paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;

    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    std::fs::create_dir_all(&cache_base).map_err(|e| e.to_string())?;

    // Returns per-item warnings (skipped episodes/seasons/shows). A bad item no
    // longer aborts the whole rescan — it's logged here and surfaced to the user.
    let warnings = match format.as_str() {
        "video" => {
            // Video rescan classifies by each folder's movie/show tag, so pull the typed paths.
            let typed = get_library_typed_paths(&state.app_db, &library_id).await?;
            let typed_bases: Vec<(PathBuf, ScanKind)> = typed
                .iter()
                .map(|lp| (PathBuf::from(&lp.path), if lp.kind == "show" { ScanKind::Show } else { ScanKind::Movie }))
                .collect();
            rescan_video_library(&app, &state.app_db, &library_id, &typed_bases, &cache_base).await?
        }
        "music" => {
            let base_paths: Vec<PathBuf> = lib_paths.iter().map(PathBuf::from).collect();
            rescan_music_library(&app, &state.app_db, &library_id, &base_paths, &cache_base).await?
        }
        _ => return Err(format!("Unsupported library format: {}", format)),
    };

    Ok(warnings)
}

async fn rescan_video_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    library_id: &str,
    base_paths: &[(PathBuf, ScanKind)],
    cache_base: &Path,
) -> Result<Vec<String>, String> {
    use std::collections::{HashSet, HashMap};

    // Collected per-item failures (skipped episodes/seasons/shows). Isolating
    // failures here means one bad file (e.g. a duplicate episode number) no
    // longer aborts the entire rescan.
    let mut warnings: Vec<String> = Vec::new();

    // Get entry_type_id mappings
    let movie_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'movie'")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let show_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'show'")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    // Collect classified disk entries (movie/show) from ALL bases. Container
    // folders are recursed through and produce nothing; collections are virtual
    // and never come from disk.
    let mut disk_kinds: HashMap<String, bool> = HashMap::new(); // rel_path -> is_show
    let mut path_to_base: HashMap<String, PathBuf> = HashMap::new();
    for (base_path, kind) in base_paths {
        let mut kinds_for_base: HashMap<String, bool> = HashMap::new();
        collect_video_entries(base_path, base_path, *kind, &mut kinds_for_base)
            .map_err(|e| e.to_string())?;
        for p in kinds_for_base.keys() {
            path_to_base.insert(p.clone(), base_path.clone());
        }
        disk_kinds.extend(kinds_for_base);
    }
    let disk_paths: HashSet<String> = disk_kinds.keys().cloned().collect();

    // Get movie/show DB entries. Collections are virtual — rescan never touches them.
    let db_rows: Vec<(i64, String, Option<i64>, String)> = sqlx::query_as(
        "SELECT id, folder_path, parent_id, entry_type FROM media_entry_full WHERE library_id = ? AND entry_type IN ('movie', 'show')",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Delete entries whose folders vanished from disk, OR whose folder's tag no longer matches
    // their type (a movie now under a show-tagged folder, or vice versa). A reclassification is a
    // delete here + a re-add as the correct kind below.
    let to_delete: Vec<(i64, String)> = db_rows
        .iter()
        .filter(|(_, p, _, et)| {
            !disk_paths.contains(p)
                || disk_kinds.get(p).copied().unwrap_or(false) != (et.as_str() == "show")
        })
        .map(|(id, p, _, _)| (*id, p.clone()))
        .collect();
    let deleted_paths: HashSet<String> = to_delete.iter().map(|(_, p)| p.clone()).collect();

    for (id, rel_path) in &to_delete {
        delete_cached_images_for_entry(pool, library_id, cache_base, rel_path).await?;
        sqlx::query("DELETE FROM media_entry WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Paths still represented by a surviving DB entry (on disk, correct kind).
    let surviving_paths: HashSet<String> = db_rows
        .iter()
        .filter(|(_, p, _, _)| !deleted_paths.contains(p))
        .map(|(_, p, _, _)| p.clone())
        .collect();

    // Add disk folders not covered by a surviving entry (brand-new or just-reclassified),
    // anchored at the library root (collection membership is virtual and user-assigned only).
    let mut new_paths: Vec<String> = disk_paths
        .iter()
        .filter(|p| !surviving_paths.contains(*p))
        .cloned()
        .collect();
    new_paths.sort();

    for rel_path in &new_paths {
        let base_path = path_to_base.get(rel_path).unwrap();
        let full_path = base_path.join(rel_path);
        let folder_name = full_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let _ = app.emit("scan-progress", &folder_name);

        // Per-entry isolation: a failure adding one new movie/show is recorded
        // and skipped, not propagated up to abort the whole rescan.
        let res: Result<(), String> = async {
            let (title, year) = parse_folder_name(&folder_name);
            let sort_title = generate_sort_title(&title, "en");
            let is_show = disk_kinds.get(rel_path).copied().unwrap_or(false);

            let max_order: Option<(i32,)> = sqlx::query_as(
                "SELECT COALESCE(MAX(sort_order), -1) FROM media_entry_full WHERE parent_id IS NULL AND library_id = ?",
            )
            .bind(library_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

            if is_show {
                let result = sqlx::query(
                    "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
                )
                .bind(library_id)
                .bind(show_type_id.0)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

                let entry_id = result.last_insert_rowid();
                sqlx::query("INSERT INTO show (id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?)")
                    .bind(entry_id)
                    .bind(&title)
                    .bind(rel_path)
                    .bind(&sort_title)
                    .bind(sort_order)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;

                cache_entry_images(pool, library_id, cache_base, base_path, rel_path)
                    .await
                    .map_err(|e| e.to_string())?;
                sync_extras_for_entry(pool, entry_id, base_path, rel_path)
                    .await
                    .map_err(|e| e.to_string())?;

                // Don't recurse into seasons here — they'll be handled in the season rescan below
            } else {
                let result = sqlx::query(
                    "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
                )
                .bind(library_id)
                .bind(movie_type_id.0)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

                let entry_id = result.last_insert_rowid();
                sqlx::query("INSERT INTO movie (id, title, folder_path, sort_title, sort_order, release_date) VALUES (?, ?, ?, ?, ?, ?)")
                    .bind(entry_id)
                    .bind(&title)
                    .bind(rel_path)
                    .bind(&sort_title)
                    .bind(sort_order)
                    .bind(&year)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;

                cache_entry_images(pool, library_id, cache_base, base_path, rel_path)
                    .await
                    .map_err(|e| e.to_string())?;
                sync_extras_for_entry(pool, entry_id, base_path, rel_path)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        .await;
        if let Err(e) = res {
            warnings.push(format!("Skipped new entry '{}': {}", rel_path, e));
        }
    }

    // Sync cached images + extras for existing entries
    let existing_entries: Vec<(i64, String)> = db_rows
        .iter()
        .filter(|(_, p, _, _)| surviving_paths.contains(p))
        .map(|(id, p, _, _)| (*id, p.clone()))
        .collect();
    for (entry_id, rel_path) in &existing_entries {
        if let Some(base) = path_to_base.get(rel_path) {
            let res: Result<(), String> = async {
                sync_entry_images(pool, library_id, cache_base, base, rel_path).await?;
                sync_extras_for_entry(pool, *entry_id, base, rel_path)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            .await;
            if let Err(e) = res {
                warnings.push(format!("Image/extras sync failed for '{}': {}", rel_path, e));
            }
        }
    }

    // Rescan seasons/episodes for all shows
    let all_shows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT s.id, s.folder_path FROM show s JOIN media_entry me ON s.id = me.id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for (show_id, show_rel) in &all_shows {
        // Each show's season/episode sync is isolated: structural failures (can't
        // resolve/read the show folder, can't query its seasons) skip just this
        // show; a bad season skips that season; a bad episode file (e.g. a
        // duplicate (season,episode_number)) skips that one file. Everything else
        // still syncs. Warnings bubble up to the user.
        let show_res: Result<Vec<String>, String> = async {
            let mut w: Vec<String> = Vec::new();

            // Resolve which base this show belongs to
            let show_base = path_to_base.get(show_rel)
                .or_else(|| {
                    // For existing entries not in path_to_base, find which base contains it
                    base_paths.iter().find(|(b, _)| b.join(show_rel).exists()).map(|(b, _)| b)
                })
                .ok_or_else(|| format!("cannot resolve base path"))?;
            let show_path = show_base.join(show_rel);

            // Season subdirs that parse as a season (covers/extras already excluded by
            // is_scannable_dir; a non-season folder like "Bonus" is ignored).
            let season_dirs: Vec<(String, i32, String)> = std::fs::read_dir(&show_path)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .filter(|e| is_scannable_dir(e))
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let (title, num) = parse_season_folder_name(&name);
                    num.map(|n| {
                        let rel = e.path().strip_prefix(show_base).unwrap_or(&e.path()).to_string_lossy().to_string();
                        (rel, n, title)
                    })
                })
                .collect();

            // Loose episode files directly in the show folder (flat show, no season subfolders).
            let loose_files: Vec<String> = std::fs::read_dir(&show_path)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .filter(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS))
                .map(|e| e.path().strip_prefix(show_base).unwrap_or(&e.path()).to_string_lossy().to_string())
                .collect();

            // Flat iff no season folders but there ARE loose episodes — mirrors the create-time
            // scanner. Otherwise reconcile by season folder (this branch also handles empty shows).
            let is_flat = season_dirs.is_empty() && !loose_files.is_empty();

            let db_seasons: Vec<(i64, String, Option<i64>)> =
                sqlx::query_as("SELECT id, folder_path, season_number FROM season WHERE show_id = ?")
                    .bind(show_id)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| e.to_string())?;

            if is_flat {
                // Synthesized seasons (folder_path == the show folder), one per filename season number.
                use std::collections::BTreeMap;
                let mut groups: BTreeMap<i32, ()> = BTreeMap::new();
                for f in &loose_files {
                    let fname = std::path::Path::new(f.as_str()).file_name().unwrap_or_default().to_string_lossy().to_string();
                    groups.insert(parse_season_number(&fname).unwrap_or(1), ());
                }
                // Drop db seasons that aren't a valid flat season (wrong folder, or a number with no
                // loose files anymore — e.g. a show that switched from season folders to flat).
                for (id, fp, num) in &db_seasons {
                    let keep = fp == show_rel && (*num).map_or(false, |n| groups.contains_key(&(n as i32)));
                    if !keep {
                        if let Err(e) = sqlx::query("DELETE FROM season WHERE id = ?").bind(id).execute(pool).await {
                            w.push(format!("Failed to remove season: {}", e));
                        }
                    }
                }
                let existing_nums: HashSet<i32> = db_seasons.iter()
                    .filter(|(_, fp, _)| fp == show_rel)
                    .filter_map(|(_, _, num)| num.map(|n| n as i32))
                    .collect();
                let mut next_order = db_seasons.len() as i32;
                for num in groups.keys() {
                    if existing_nums.contains(num) { continue; }
                    let title = if *num == 0 { "Specials".to_string() } else { format!("Season {}", num) };
                    if let Err(e) = sqlx::query(
                        "INSERT INTO season (show_id, title, season_number, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(show_id).bind(&title).bind(num).bind(show_rel).bind(next_order)
                    .execute(pool).await {
                        w.push(format!("Skipped season {}: {}", num, e));
                    }
                    next_order += 1;
                }
            } else {
                // Foldered show (or empty): reconcile seasons by folder_path. A stale flat season
                // (folder_path == show folder) isn't among season_dirs, so it's correctly removed.
                let disk_season_paths: HashSet<String> = season_dirs.iter().map(|(rel, _, _)| rel.clone()).collect();
                for (id, path, _) in &db_seasons {
                    if !disk_season_paths.contains(path) {
                        if let Err(e) = sqlx::query("DELETE FROM season WHERE id = ?").bind(id).execute(pool).await {
                            w.push(format!("Failed to remove deleted season '{}': {}", path, e));
                        }
                    }
                }
                let existing_season_paths: HashSet<String> = db_seasons.iter().map(|(_, p, _)| p.clone()).collect();
                for (rel, num, title) in &season_dirs {
                    if existing_season_paths.contains(rel) {
                        // Reconcile number/title in case the folder was renamed (e.g. NULL → Specials).
                        if let Err(e) = sqlx::query(
                            "UPDATE season SET season_number = ?, title = ? WHERE show_id = ? AND folder_path = ? AND (season_number IS NOT ? OR title IS NOT ?)",
                        )
                        .bind(num).bind(title).bind(show_id).bind(rel).bind(num).bind(title)
                        .execute(pool).await {
                            w.push(format!("Failed to reconcile season '{}': {}", rel, e));
                        }
                        continue;
                    }
                    let max_order: Option<(i32,)> =
                        sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM season WHERE show_id = ?")
                            .bind(show_id).fetch_optional(pool).await.map_err(|e| e.to_string())?;
                    let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);
                    if let Err(e) = sqlx::query(
                        "INSERT INTO season (show_id, title, season_number, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(show_id).bind(title).bind(num).bind(rel).bind(sort_order)
                    .execute(pool).await {
                        w.push(format!("Skipped season '{}': {}", rel, e));
                    }
                }
            }

            // Episodes for each season
            let all_seasons: Vec<(i64, String, Option<i64>)> =
                sqlx::query_as("SELECT id, folder_path, season_number FROM season WHERE show_id = ?")
                    .bind(show_id)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| e.to_string())?;

            for (season_id, season_rel, season_num) in &all_seasons {
                // A flat season's folder IS the show folder; its episodes are the loose files whose
                // filename season matches. A foldered season reads its own folder.
                let disk_episodes: HashSet<String> = if season_rel == show_rel {
                    let want = (*season_num).unwrap_or(1) as i32;
                    loose_files.iter().filter(|f| {
                        let fname = std::path::Path::new(f.as_str()).file_name().unwrap_or_default().to_string_lossy().to_string();
                        parse_season_number(&fname).unwrap_or(1) == want
                    }).cloned().collect()
                } else {
                    let season_path = show_base.join(season_rel);
                    match std::fs::read_dir(&season_path) {
                        Ok(rd) => rd
                            .filter_map(|e| e.ok())
                            .filter(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS))
                            .map(|e| {
                                e.path()
                                    .strip_prefix(show_base)
                                    .unwrap_or(&e.path())
                                    .to_string_lossy()
                                    .to_string()
                            })
                            .collect(),
                        Err(e) => {
                            w.push(format!("Skipped season '{}': {}", season_rel, e));
                            continue;
                        }
                    }
                };

                let db_episodes: Vec<(i64, String)> =
                    match sqlx::query_as("SELECT id, file_path FROM episode WHERE season_id = ?")
                        .bind(season_id)
                        .fetch_all(pool)
                        .await
                    {
                        Ok(r) => r,
                        Err(e) => {
                            w.push(format!("Skipped season '{}': {}", season_rel, e));
                            continue;
                        }
                    };

                for (id, path) in &db_episodes {
                    if !disk_episodes.contains(path) {
                        if let Err(e) = sqlx::query("DELETE FROM episode WHERE id = ?")
                            .bind(id)
                            .execute(pool)
                            .await
                        {
                            w.push(format!("Failed to remove deleted episode: {}", e));
                        }
                    }
                }

                let existing_ep_paths: HashSet<String> = db_episodes.iter().map(|(_, p)| p.clone()).collect();

                for rel_path in &disk_episodes {
                    if existing_ep_paths.contains(rel_path) {
                        continue;
                    }
                    let file_name = std::path::Path::new(rel_path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let (ep_title, ep_number, ep_number_end) = parse_episode_range(&file_name);

                    let max_order: Option<(i32,)> =
                        sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM episode WHERE season_id = ?")
                            .bind(season_id)
                            .fetch_optional(pool)
                            .await
                            .map_err(|e| e.to_string())?;
                    let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

                    // THE fix: a duplicate (season_id, episode_number) — or any
                    // other insert failure — skips just this file with a warning
                    // instead of `?`-aborting the entire rescan.
                    if let Err(e) = sqlx::query(
                        "INSERT INTO episode (season_id, title, episode_number, episode_number_end, file_path, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
                    )
                    .bind(season_id)
                    .bind(&ep_title)
                    .bind(ep_number)
                    .bind(ep_number_end)
                    .bind(rel_path)
                    .bind(sort_order)
                    .execute(pool)
                    .await
                    {
                        w.push(format!("Skipped episode file '{}': {}", file_name, e));
                    }
                }
            }
            Ok(w)
        }
        .await;

        match show_res {
            Ok(w) => warnings.extend(w),
            Err(e) => warnings.push(format!("Skipped show '{}': {}", show_rel, e)),
        }
    }

    Ok(warnings)
}

async fn rescan_music_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    library_id: &str,
    base_paths: &[PathBuf],
    cache_base: &Path,
) -> Result<Vec<String>, String> {
    use std::collections::{HashSet, HashMap};

    let artist_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'artist'")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let album_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'album'")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let track_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'track'")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;

    // Collect all disk paths from all bases
    // For music: artist dirs, album dirs, and track files
    let mut disk_artist_paths: HashSet<String> = HashSet::new();
    let mut disk_album_paths: HashSet<String> = HashSet::new();
    let mut disk_track_paths: HashSet<String> = HashSet::new();
    let mut path_to_base: HashMap<String, PathBuf> = HashMap::new();

    for base_path in base_paths {
        let artist_dirs = std::fs::read_dir(base_path)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| is_scannable_dir(e));

        for artist_entry in artist_dirs {
            let artist_path = artist_entry.path();
            let artist_rel = artist_path
                .strip_prefix(base_path)
                .unwrap_or(&artist_path)
                .to_string_lossy()
                .to_string();
            disk_artist_paths.insert(artist_rel.clone());
            path_to_base.insert(artist_rel, base_path.clone());

            let album_dirs = std::fs::read_dir(&artist_path)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .filter(|e| is_scannable_dir(e));

            for album_entry in album_dirs {
                let album_path = album_entry.path();
                let album_rel = album_path
                    .strip_prefix(base_path)
                    .unwrap_or(&album_path)
                    .to_string_lossy()
                    .to_string();
                disk_album_paths.insert(album_rel.clone());
                path_to_base.insert(album_rel, base_path.clone());

                let track_files = std::fs::read_dir(&album_path)
                    .map_err(|e| e.to_string())?
                    .filter_map(|e| e.ok())
                    .filter(|e| is_media_file(&e.path(), AUDIO_EXTENSIONS));

                for track_entry in track_files {
                    let track_rel = track_entry
                        .path()
                        .strip_prefix(base_path)
                        .unwrap_or(&track_entry.path())
                        .to_string_lossy()
                        .to_string();
                    disk_track_paths.insert(track_rel.clone());
                    path_to_base.insert(track_rel, base_path.clone());
                }
            }
        }
    }

    // Get all DB entries for this library
    let db_rows: Vec<(i64, String, String, Option<i64>)> = sqlx::query_as(
        "SELECT mef.id, COALESCE(mef.folder_path, ''), mef.entry_type, mef.parent_id FROM media_entry_full mef WHERE mef.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Also get track file_paths
    let db_tracks: Vec<(i64, String)> = sqlx::query_as(
        "SELECT me.id, t.file_path FROM media_entry me JOIN track t ON me.id = t.id WHERE me.library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let db_track_paths: HashMap<String, i64> = db_tracks.into_iter().map(|(id, p)| (p, id)).collect();

    // Separate DB entries by type
    let mut db_artist_map: HashMap<String, i64> = HashMap::new();
    let mut db_album_map: HashMap<String, i64> = HashMap::new();
    for (id, folder_path, entry_type, _parent_id) in &db_rows {
        match entry_type.as_str() {
            "artist" => { db_artist_map.insert(folder_path.clone(), *id); }
            "album" => { db_album_map.insert(folder_path.clone(), *id); }
            _ => {}
        }
    }

    // Delete removed tracks
    for (path, id) in &db_track_paths {
        if !disk_track_paths.contains(path) {
            sqlx::query("DELETE FROM media_entry WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Delete removed albums
    for (path, id) in &db_album_map {
        if !disk_album_paths.contains(path) {
            delete_cached_images_for_entry(pool, library_id, cache_base, path).await?;
            sqlx::query("DELETE FROM media_entry WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Delete removed artists
    for (path, id) in &db_artist_map {
        if !disk_artist_paths.contains(path) {
            delete_cached_images_for_entry(pool, library_id, cache_base, path).await?;
            sqlx::query("DELETE FROM media_entry WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Add new artists
    for artist_rel in &disk_artist_paths {
        if db_artist_map.contains_key(artist_rel) {
            continue;
        }
        let base_path = path_to_base.get(artist_rel).unwrap();
        let full_path = base_path.join(artist_rel);
        let artist_name = full_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let sort_title = generate_sort_title(&artist_name, "en");

        let _ = app.emit("scan-progress", &artist_name);

        let max_order: (i32,) = sqlx::query_as(
            "SELECT COALESCE(MAX(mef.sort_order), -1) FROM media_entry_full mef WHERE mef.library_id = ? AND mef.entry_type = 'artist'",
        )
        .bind(library_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;

        let result = sqlx::query(
            "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
        )
        .bind(library_id)
        .bind(artist_type_id.0)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        let entry_id = result.last_insert_rowid();
        sqlx::query(
            "INSERT INTO artist (id, title, sort_title, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(entry_id)
        .bind(&artist_name)
        .bind(&sort_title)
        .bind(artist_rel)
        .bind(max_order.0 + 1)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        cache_entry_images(pool, library_id, cache_base, base_path, artist_rel)
            .await
            .map_err(|e| e.to_string())?;

        db_artist_map.insert(artist_rel.clone(), entry_id);
    }

    // Add new albums
    for album_rel in &disk_album_paths {
        if db_album_map.contains_key(album_rel) {
            continue;
        }
        let base_path = path_to_base.get(album_rel).unwrap();
        let full_path = base_path.join(album_rel);
        let album_name = full_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let (album_title, album_year) = parse_folder_name(&album_name);
        let album_sort_title = generate_sort_title(&album_title, "en");

        // Find parent artist
        let parent_rel = full_path
            .parent()
            .and_then(|p| p.strip_prefix(base_path).ok())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let parent_id = db_artist_map.get(&parent_rel).copied();

        let max_order: (i32,) = if let Some(pid) = parent_id {
            sqlx::query_as(
                "SELECT COALESCE(MAX(mef.sort_order), -1) FROM media_entry_full mef WHERE mef.parent_id = ?",
            )
            .bind(pid)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?
        } else {
            (-1,)
        };

        let result = sqlx::query(
            "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
        )
        .bind(library_id)
        .bind(parent_id)
        .bind(album_type_id.0)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        let entry_id = result.last_insert_rowid();
        sqlx::query(
            "INSERT INTO album (id, title, sort_title, folder_path, sort_order, release_date) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(entry_id)
        .bind(&album_title)
        .bind(&album_sort_title)
        .bind(album_rel)
        .bind(max_order.0 + 1)
        .bind(&album_year)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        cache_entry_images(pool, library_id, cache_base, base_path, album_rel)
            .await
            .map_err(|e| e.to_string())?;

        db_album_map.insert(album_rel.clone(), entry_id);
    }

    // Add new tracks
    for track_rel in &disk_track_paths {
        if db_track_paths.contains_key(track_rel) {
            continue;
        }
        let base_path = path_to_base.get(track_rel).unwrap();
        let full_path = base_path.join(track_rel);
        let track_name = full_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let (track_title, track_number) = parse_song_filename(&track_name);
        let track_sort_title = generate_sort_title(&track_title, "en");

        // Find parent album
        let parent_rel = full_path
            .parent()
            .and_then(|p| p.strip_prefix(base_path).ok())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let parent_id = db_album_map.get(&parent_rel).copied();

        let max_order: (i32,) = if let Some(pid) = parent_id {
            sqlx::query_as(
                "SELECT COALESCE(MAX(t.sort_order), -1) FROM track t JOIN media_entry me ON t.id = me.id WHERE me.parent_id = ?",
            )
            .bind(pid)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?
        } else {
            (-1,)
        };

        let result = sqlx::query(
            "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
        )
        .bind(library_id)
        .bind(parent_id)
        .bind(track_type_id.0)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        let entry_id = result.last_insert_rowid();
        sqlx::query(
            "INSERT INTO track (id, title, sort_title, file_path, sort_order, track_number) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(entry_id)
        .bind(&track_title)
        .bind(&track_sort_title)
        .bind(track_rel)
        .bind(max_order.0 + 1)
        .bind(track_number)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(Vec::new())
}

/// Walk a library root collecting entry folders, classified with the same rules as
/// the initial scan: season-pattern subdirs → show, video files → movie, anything
/// else is a container to recurse through. Show and movie folders are not descended
/// into (their interiors — seasons, extras — are not entries).
/// Walk a base folder of a known `kind`, recording each entry's rel_path -> is_show. Classification
/// follows the folder's tag, not structure: under a Movie base a folder with video is a movie; under
/// a Show base a folder with season subdirs OR loose episode files is a show (flat shows included).
/// Folders that are neither are containers and get recursed through.
fn collect_video_entries(
    base: &PathBuf,
    dir: &PathBuf,
    kind: ScanKind,
    out: &mut std::collections::HashMap<String, bool>, // rel_path -> is_show
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !is_scannable_dir(&entry) {
            continue;
        }
        let path = entry.path();
        let subdirs: Vec<_> = std::fs::read_dir(&path)?
            .filter_map(|e| e.ok())
            .filter(|e| is_scannable_dir(e))
            .collect();
        let has_season = subdirs.iter().any(|e| {
            let (_, num) = parse_season_folder_name(&e.file_name().to_string_lossy());
            num.is_some()
        });
        let has_video = std::fs::read_dir(&path)?
            .filter_map(|e| e.ok())
            .any(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS));
        let rel = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        match kind {
            ScanKind::Show => {
                if has_season || has_video {
                    out.insert(rel, true); // foldered or flat show
                } else {
                    collect_video_entries(base, &path, kind, out)?; // container of shows
                }
            }
            ScanKind::Movie => {
                if has_video {
                    out.insert(rel, false); // movie
                } else {
                    collect_video_entries(base, &path, kind, out)?; // container of movies
                }
            }
        }
    }
    Ok(())
}


const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "avif", "webp"];

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Playlists and nested playlist_collections don't live in a media-library folder, so
/// their custom covers are stored under `<app_data_dir>/playlist_covers/{kind}-{id}/`.
/// `kind` is either "playlist" or "collection".
fn playlist_covers_dir(app_data_dir: &Path, kind: &str, id: i64) -> PathBuf {
    app_data_dir.join("playlist_covers").join(format!("{kind}-{id}"))
}

fn list_playlist_covers(dir: &Path) -> Vec<String> {
    if !dir.exists() { return Vec::new(); }
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new(); };
    let mut out: Vec<String> = read
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_image_file(p))
        .filter_map(|p| p.to_str().map(|s| s.to_string()))
        .collect();
    out.sort();
    out
}

/// Copy a user-picked image into `target_dir`, deduplicating the filename. Returns the
/// absolute path of the new file.
fn copy_cover_into_dir(source_path: &str, target_dir: &Path) -> Result<String, String> {
    let src = PathBuf::from(source_path);
    if !src.exists() { return Err("Source file does not exist".into()); }
    if !is_image_file(&src) { return Err("File is not a supported image".into()); }
    std::fs::create_dir_all(target_dir).map_err(|e| format!("Failed to create covers dir: {e}"))?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "cover".into());
    let ext = src.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "jpg".into());
    let mut name = format!("{stem}.{ext}");
    let mut target = target_dir.join(&name);
    let mut n = 1;
    while target.exists() {
        name = format!("{stem}_{n}.{ext}");
        target = target_dir.join(&name);
        n += 1;
    }
    std::fs::copy(&src, &target).map_err(|e| format!("Failed to copy cover: {e}"))?;
    target.to_str().map(|s| s.to_string()).ok_or_else(|| "Invalid target path".into())
}

/// Copy images from source_dir/{image_type_dir}/ to cache_base/{entry_rel_path}/{image_type_dir}/
/// Returns Vec<(source_filename, cached_absolute_path)>
fn cache_images_for_entry(
    cache_base: &Path,
    library_base: &Path,
    entry_rel_path: &str,
    image_type_dir: &str, // "covers" or "backdrops"
) -> Vec<(String, String)> {
    let source_dir = library_base.join(entry_rel_path).join(image_type_dir);
    let cache_dir = cache_base.join(entry_rel_path).join(image_type_dir);
    let thumb_dir = cache_base.join(entry_rel_path).join(format!("{}_thumb", image_type_dir));
    let mut results = Vec::new();

    if !source_dir.exists() {
        return results;
    }

    let entries = match std::fs::read_dir(&source_dir) {
        Ok(e) => e,
        Err(_) => return results,
    };

    let _ = std::fs::create_dir_all(&cache_dir);
    let _ = std::fs::create_dir_all(&thumb_dir);

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_image_file(&path) {
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        let cached_path = cache_dir.join(&filename);
        if std::fs::copy(&path, &cached_path).is_ok() {
            // Generate thumbnail
            if let Ok(img) = image::open(&cached_path) {
                let thumb = img.thumbnail(600, 900);
                let _ = thumb.save(thumb_dir.join(&filename));
            }
            results.push((filename, cached_path.to_string_lossy().to_string()));
        }
    }

    results
}

async fn insert_cached_images(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    entry_folder_path: &str,
    image_type: &str, // "cover" or "backdrop"
    origin: &str,     // "library" (found in media folders) or "app" (added via waverunner)
    images: &[(String, String)], // (source_filename, cached_path)
) -> Result<(), sqlx::Error> {
    for (filename, cached_path) in images {
        sqlx::query(
            "INSERT OR REPLACE INTO cached_images (library_id, entry_folder_path, image_type, source_filename, cached_path, origin) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(library_id)
        .bind(entry_folder_path)
        .bind(image_type)
        .bind(filename)
        .bind(cached_path)
        .bind(origin)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn get_all_cached_covers(pool: &sqlx::SqlitePool, library_id: &str) -> Result<HashMap<String, Vec<String>>, sqlx::Error> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT entry_folder_path, cached_path FROM cached_images WHERE library_id = ? AND image_type = 'cover' ORDER BY entry_folder_path, source_filename",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await?;

    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for (folder_path, cached_path) in rows {
        map.entry(folder_path).or_default().push(cached_path);
    }
    Ok(map)
}

fn delete_cache_for_library(app_data_dir: &Path, library_id: &str) {
    let cache_dir = app_data_dir.join("cache").join(library_id);
    if cache_dir.exists() {
        let _ = std::fs::remove_dir_all(&cache_dir);
    }
}

/// App-added artwork originals live in app-data, never in the media folders.
/// Layout mirrors the media tree: <base>/{entry_folder_path}/covers/...
fn app_images_base(app_data_dir: &Path, library_id: &str) -> PathBuf {
    app_data_dir.join("added_images").join(library_id)
}

/// Cache both covers and backdrops found inside the media folders for an entry
async fn cache_entry_images(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    cache_base: &Path,
    library_base: &Path,
    entry_rel_path: &str,
) -> Result<(), sqlx::Error> {
    let covers = cache_images_for_entry(cache_base, library_base, entry_rel_path, "covers");
    insert_cached_images(pool, library_id, entry_rel_path, "cover", "library", &covers).await?;
    let backdrops = cache_images_for_entry(cache_base, library_base, entry_rel_path, "backdrops");
    insert_cached_images(pool, library_id, entry_rel_path, "backdrop", "library", &backdrops).await?;
    Ok(())
}

/// Diff-aware sync: add new images, remove deleted ones, skip unchanged.
/// Scoped to one origin ('library' = media folders, 'app' = app-data originals) so
/// syncing one source never deletes cache rows belonging to the other.
async fn sync_cached_images_for_entry(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    cache_base: &Path,
    source_base: &Path,
    entry_rel_path: &str,
    image_type_dir: &str, // "covers" or "backdrops"
    image_type_db: &str,  // "cover" or "backdrop"
    origin: &str,         // "library" or "app"
) -> Result<(), String> {
    let source_dir = source_base.join(entry_rel_path).join(image_type_dir);
    let cache_dir = cache_base.join(entry_rel_path).join(image_type_dir);
    let thumb_dir = cache_base.join(entry_rel_path).join(format!("{}_thumb", image_type_dir));

    // Get current files on disk
    let mut disk_files: std::collections::HashSet<String> = std::collections::HashSet::new();
    if source_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&source_dir) {
            for entry in entries.flatten() {
                if is_image_file(&entry.path()) {
                    disk_files.insert(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
    }

    // Get cached files from DB
    let db_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT source_filename, cached_path FROM cached_images WHERE library_id = ? AND entry_folder_path = ? AND image_type = ? AND origin = ?",
    )
    .bind(library_id)
    .bind(entry_rel_path)
    .bind(image_type_db)
    .bind(origin)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let db_files: std::collections::HashSet<String> = db_rows.iter().map(|(f, _)| f.clone()).collect();

    // Delete removed files
    for (filename, cached_path) in &db_rows {
        if !disk_files.contains(filename) {
            let _ = std::fs::remove_file(cached_path);
            let _ = std::fs::remove_file(thumb_dir.join(filename));
            sqlx::query(
                "DELETE FROM cached_images WHERE library_id = ? AND entry_folder_path = ? AND image_type = ? AND source_filename = ? AND origin = ?",
            )
            .bind(library_id)
            .bind(entry_rel_path)
            .bind(image_type_db)
            .bind(filename)
            .bind(origin)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    // Copy new files
    let _ = std::fs::create_dir_all(&cache_dir);
    let _ = std::fs::create_dir_all(&thumb_dir);
    for filename in &disk_files {
        if !db_files.contains(filename) {
            let source = source_dir.join(filename);
            let cached = cache_dir.join(filename);
            if std::fs::copy(&source, &cached).is_ok() {
                // Thumbnail too — the grid loads covers_thumb/<file> directly,
                // so a cover without one renders broken until something
                // re-caches it (this was the scan path's job only, leaving
                // app-added covers thumb-less).
                if let Ok(img) = image::open(&cached) {
                    let thumb = img.thumbnail(600, 900);
                    let _ = thumb.save(thumb_dir.join(filename));
                }
                sqlx::query(
                    "INSERT OR REPLACE INTO cached_images (library_id, entry_folder_path, image_type, source_filename, cached_path, origin) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(library_id)
                .bind(entry_rel_path)
                .bind(image_type_db)
                .bind(filename)
                .bind(cached.to_string_lossy().to_string())
                .bind(origin)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

/// Sync both covers and backdrops from the media folders for an entry during rescan
async fn sync_entry_images(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    cache_base: &Path,
    library_base: &Path,
    entry_rel_path: &str,
) -> Result<(), String> {
    sync_cached_images_for_entry(pool, library_id, cache_base, library_base, entry_rel_path, "covers", "cover", "library").await?;
    sync_cached_images_for_entry(pool, library_id, cache_base, library_base, entry_rel_path, "backdrops", "backdrop", "library").await?;
    Ok(())
}

/// Delete cached images for a specific entry
async fn delete_cached_images_for_entry(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    cache_base: &Path,
    entry_rel_path: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM cached_images WHERE library_id = ? AND entry_folder_path = ?")
        .bind(library_id)
        .bind(entry_rel_path)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    let entry_cache_dir = cache_base.join(entry_rel_path);
    if entry_cache_dir.exists() {
        let _ = std::fs::remove_dir_all(&entry_cache_dir);
    }
    Ok(())
}

async fn scan_music_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    library_id: &str,
    base_path: &PathBuf,
    cache_base: &Path,
    cancel: &AtomicBool,
) -> Result<(), sqlx::Error> {
    let artist_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'artist'")
            .fetch_one(pool)
            .await?;
    let album_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'album'")
            .fetch_one(pool)
            .await?;
    let track_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'track'")
            .fetch_one(pool)
            .await?;

    let mut artist_dirs: Vec<_> = std::fs::read_dir(base_path)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        .filter_map(|e| e.ok())
        .filter(|e| is_scannable_dir(e))
        .collect();
    artist_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for (i, artist_entry) in artist_dirs.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(sqlx::Error::Protocol("Library creation cancelled".to_string()));
        }
        let artist_path = artist_entry.path();
        let artist_name = artist_entry.file_name().to_string_lossy().to_string();
        let _ = app.emit("scan-progress", &artist_name);

        let sort_title = generate_sort_title(&artist_name, "en");
        let rel_path = artist_path
            .strip_prefix(base_path)
            .unwrap_or(&artist_path)
            .to_string_lossy()
            .to_string();

        // Insert media_entry for artist
        let result = sqlx::query(
            "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
        )
        .bind(library_id)
        .bind(artist_type_id.0)
        .execute(pool)
        .await?;

        let artist_entry_id = result.last_insert_rowid();

        // Insert artist detail
        sqlx::query(
            "INSERT INTO artist (id, title, sort_title, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(artist_entry_id)
        .bind(&artist_name)
        .bind(&sort_title)
        .bind(&rel_path)
        .bind(i as i32)
        .execute(pool)
        .await?;

        cache_entry_images(pool, library_id, cache_base, base_path, &rel_path).await?;

        // Level 2: Albums
        let mut album_dirs: Vec<_> = std::fs::read_dir(&artist_path)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
            .filter_map(|e| e.ok())
            .filter(|e| is_scannable_dir(e))
            .collect();
        album_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

        for (j, album_entry) in album_dirs.iter().enumerate() {
            let album_path = album_entry.path();
            let album_name = album_entry.file_name().to_string_lossy().to_string();
            let (album_title, album_year) = parse_folder_name(&album_name);
            let album_sort_title = generate_sort_title(&album_title, "en");
            let album_rel = album_path
                .strip_prefix(base_path)
                .unwrap_or(&album_path)
                .to_string_lossy()
                .to_string();

            // Insert media_entry for album (parent = artist)
            let result = sqlx::query(
                "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
            )
            .bind(library_id)
            .bind(artist_entry_id)
            .bind(album_type_id.0)
            .execute(pool)
            .await?;

            let album_entry_id = result.last_insert_rowid();

            // Insert album detail
            sqlx::query(
                "INSERT INTO album (id, title, sort_title, folder_path, sort_order, release_date) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(album_entry_id)
            .bind(&album_title)
            .bind(&album_sort_title)
            .bind(&album_rel)
            .bind(j as i32)
            .bind(&album_year)
            .execute(pool)
            .await?;

            cache_entry_images(pool, library_id, cache_base, base_path, &album_rel).await?;

            // Level 3: Tracks
            let mut track_files: Vec<_> = std::fs::read_dir(&album_path)
                .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
                .filter_map(|e| e.ok())
                .filter(|e| is_media_file(&e.path(), AUDIO_EXTENSIONS))
                .collect();

            track_files.sort_by(|a, b| {
                let (_, a_num) = parse_song_filename(&a.file_name().to_string_lossy());
                let (_, b_num) = parse_song_filename(&b.file_name().to_string_lossy());
                match (a_num, b_num) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    _ => a.file_name().cmp(&b.file_name()),
                }
            });

            for (k, track_entry) in track_files.iter().enumerate() {
                let track_name = track_entry.file_name().to_string_lossy().to_string();
                let (track_title, track_number) = parse_song_filename(&track_name);
                let track_sort_title = generate_sort_title(&track_title, "en");
                let track_rel = track_entry
                    .path()
                    .strip_prefix(base_path)
                    .unwrap_or(&track_entry.path())
                    .to_string_lossy()
                    .to_string();

                // Insert media_entry for track (parent = album)
                let result = sqlx::query(
                    "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
                )
                .bind(library_id)
                .bind(album_entry_id)
                .bind(track_type_id.0)
                .execute(pool)
                .await?;

                let track_entry_id = result.last_insert_rowid();

                // Insert track detail
                sqlx::query(
                    "INSERT INTO track (id, title, sort_title, file_path, sort_order, track_number) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(track_entry_id)
                .bind(&track_title)
                .bind(&track_sort_title)
                .bind(&track_rel)
                .bind(k as i32)
                .bind(track_number)
                .execute(pool)
                .await?;
            }
        }
    }

    Ok(())
}

/// Whether a video source folder holds movies or shows. The user tags each folder at
/// library creation (library_path.kind); the scanner classifies by the tag instead of guessing.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanKind {
    Movie,
    Show,
}

async fn scan_video_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    library_id: &str,
    base_path: &PathBuf,
    cache_base: &Path,
    kind: ScanKind,
    cancel: &AtomicBool,
) -> Result<(), sqlx::Error> {
    // Get entry_type_id mappings
    let movie_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'movie'")
            .fetch_one(pool)
            .await?;
    let show_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'show'")
            .fetch_one(pool)
            .await?;

    let mut top_dirs: Vec<_> = std::fs::read_dir(base_path)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        .filter_map(|e| e.ok())
        .filter(|e| is_scannable_dir(e))
        .collect();
    top_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    let mut next_order: i32 = 0;
    for dir_entry in top_dirs.iter() {
        scan_video_dir(
            app,
            pool,
            library_id,
            base_path,
            &dir_entry.path(),
            cache_base,
            &mut next_order,
            movie_type_id.0,
            show_type_id.0,
            kind,
            cancel,
        )
        .await?;
    }

    Ok(())
}

/// Recursively scan a directory tree under a folder of a known `kind`. In a Movie folder a
/// directory with video files is a movie; in a Show folder a directory with season subdirs OR
/// loose episode files is a show (seasons derived from filenames when there's no season folder).
/// Anything else is a container that's recursed through without producing an entry — collections
/// are virtual (DB-only) and never come from disk. All entries anchor at the library root.
#[async_recursion::async_recursion]
async fn scan_video_dir(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    library_id: &str,
    base_path: &PathBuf,
    dir: &PathBuf,
    cache_base: &Path,
    next_order: &mut i32,
    movie_type_id: i64,
    show_type_id: i64,
    kind: ScanKind,
    cancel: &AtomicBool,
) -> Result<(), sqlx::Error> {
    if cancel.load(Ordering::SeqCst) {
        return Err(sqlx::Error::Protocol("Library creation cancelled".to_string()));
    }
    let name = dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let _ = app.emit("scan-progress", &name);

    let subdirs: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        .filter_map(|e| e.ok())
        .filter(|e| is_scannable_dir(e))
        .collect();

    let (title, year) = parse_folder_name(&name);
    let sort_title = generate_sort_title(&title, "en");
    let rel_path = dir
        .strip_prefix(base_path)
        .unwrap_or(dir)
        .to_string_lossy()
        .to_string();

    let has_season = subdirs.iter().any(|e| {
        let (_, num) = parse_season_folder_name(&e.file_name().to_string_lossy());
        num.is_some()
    });
    let has_video_files = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).any(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS)))
        .unwrap_or(false);

    if kind == ScanKind::Show && has_season {
        // TV show
        let result = sqlx::query(
            "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
        )
        .bind(library_id)
        .bind(show_type_id)
        .execute(pool)
        .await?;

        let entry_id = result.last_insert_rowid();
        sqlx::query("INSERT INTO show (id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?)")
            .bind(entry_id)
            .bind(&title)
            .bind(&rel_path)
            .bind(&sort_title)
            .bind(*next_order)
            .execute(pool)
            .await?;
        *next_order += 1;

        cache_entry_images(pool, library_id, cache_base, base_path, &rel_path).await?;

        // Scan seasons
        let mut season_dirs = subdirs;
        season_dirs.sort_by(|a, b| {
            let (_, a_num) = parse_season_folder_name(&a.file_name().to_string_lossy());
            let (_, b_num) = parse_season_folder_name(&b.file_name().to_string_lossy());
            match (a_num, b_num) {
                (Some(a), Some(b)) => a.cmp(&b),
                _ => a.file_name().cmp(&b.file_name()),
            }
        });

        for (j, season_entry) in season_dirs.iter().enumerate() {
            let season_path = season_entry.path();
            let season_name = season_entry.file_name().to_string_lossy().to_string();
            let (season_title, season_number) = parse_season_folder_name(&season_name);
            let season_rel = season_path
                .strip_prefix(base_path)
                .unwrap_or(&season_path)
                .to_string_lossy()
                .to_string();

            let result = sqlx::query(
                "INSERT INTO season (show_id, title, season_number, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(entry_id)
            .bind(&season_title)
            .bind(season_number)
            .bind(&season_rel)
            .bind(j as i32)
            .execute(pool)
            .await?;

            let season_id = result.last_insert_rowid();

            // Episodes
            let mut episode_files: Vec<_> = std::fs::read_dir(&season_path)
                .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
                .filter_map(|e| e.ok())
                .filter(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS))
                .collect();

            episode_files.sort_by(|a, b| {
                let (_, a_num) = parse_episode_filename(&a.file_name().to_string_lossy());
                let (_, b_num) = parse_episode_filename(&b.file_name().to_string_lossy());
                match (a_num, b_num) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    _ => a.file_name().cmp(&b.file_name()),
                }
            });

            for (k, ep_entry) in episode_files.iter().enumerate() {
                let ep_name = ep_entry.file_name().to_string_lossy().to_string();
                let (ep_title, ep_number, ep_number_end) = parse_episode_range(&ep_name);
                let ep_rel = ep_entry
                    .path()
                    .strip_prefix(base_path)
                    .unwrap_or(&ep_entry.path())
                    .to_string_lossy()
                    .to_string();

                // Non-fatal: a duplicate (season_id, episode_number) — e.g. two
                // files that parse to the same SxxExx — skips just that file and
                // logs it, instead of aborting the whole library creation.
                if let Err(e) = sqlx::query(
                    "INSERT INTO episode (season_id, title, episode_number, episode_number_end, file_path, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(season_id)
                .bind(&ep_title)
                .bind(ep_number)
                .bind(ep_number_end)
                .bind(&ep_rel)
                .bind(k as i32)
                .execute(pool)
                .await
                {
                    eprintln!("scan: skipped episode file '{}': {}", ep_name, e);
                }
            }
        }

        sync_extras_for_entry(pool, entry_id, base_path, &rel_path).await?;
        return Ok(());
    }

    if kind == ScanKind::Show && has_video_files {
        // Flat show: episodes live directly in the show folder (no season subfolders).
        // The show is this folder; seasons are derived from each filename's SxxEyy season
        // number (no season token → Season 1). Episodes anchor at synthesized seasons whose
        // folder_path is the show folder itself.
        let result = sqlx::query(
            "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
        )
        .bind(library_id)
        .bind(show_type_id)
        .execute(pool)
        .await?;
        let entry_id = result.last_insert_rowid();
        sqlx::query("INSERT INTO show (id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?)")
            .bind(entry_id)
            .bind(&title)
            .bind(&rel_path)
            .bind(&sort_title)
            .bind(*next_order)
            .execute(pool)
            .await?;
        *next_order += 1;
        cache_entry_images(pool, library_id, cache_base, base_path, &rel_path).await?;

        // Bucket the loose video files by derived season number.
        let mut ep_files: Vec<_> = std::fs::read_dir(dir)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
            .filter_map(|e| e.ok())
            .filter(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS))
            .collect();
        ep_files.sort_by(|a, b| {
            let an = a.file_name().to_string_lossy().to_string();
            let bn = b.file_name().to_string_lossy().to_string();
            let (a_s, a_e) = (parse_season_number(&an).unwrap_or(1), parse_episode_range(&an).1);
            let (b_s, b_e) = (parse_season_number(&bn).unwrap_or(1), parse_episode_range(&bn).1);
            a_s.cmp(&b_s).then(a_e.cmp(&b_e)).then(an.cmp(&bn))
        });

        // season_number -> season_id (created on first episode that needs it)
        let mut season_ids: std::collections::HashMap<i32, i64> = std::collections::HashMap::new();
        let mut ep_orders: std::collections::HashMap<i32, i32> = std::collections::HashMap::new();
        for ep_entry in &ep_files {
            let ep_name = ep_entry.file_name().to_string_lossy().to_string();
            let season_num = parse_season_number(&ep_name).unwrap_or(1);
            let (ep_title, ep_number, ep_number_end) = parse_episode_range(&ep_name);

            // Lazily create the season for this number (folder_path = the show folder).
            let season_id = if let Some(sid) = season_ids.get(&season_num) {
                *sid
            } else {
                let season_title = if season_num == 0 { "Specials".to_string() } else { format!("Season {}", season_num) };
                let sort_order = season_ids.len() as i32;
                let res = sqlx::query(
                    "INSERT INTO season (show_id, title, season_number, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(entry_id)
                .bind(&season_title)
                .bind(season_num)
                .bind(&rel_path)
                .bind(sort_order)
                .execute(pool)
                .await?;
                let sid = res.last_insert_rowid();
                season_ids.insert(season_num, sid);
                sid
            };
            let ep_rel = ep_entry
                .path()
                .strip_prefix(base_path)
                .unwrap_or(&ep_entry.path())
                .to_string_lossy()
                .to_string();
            let order = ep_orders.entry(season_num).or_insert(0);
            if let Err(e) = sqlx::query(
                "INSERT INTO episode (season_id, title, episode_number, episode_number_end, file_path, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(season_id)
            .bind(&ep_title)
            .bind(ep_number)
            .bind(ep_number_end)
            .bind(&ep_rel)
            .bind(*order)
            .execute(pool)
            .await
            {
                eprintln!("scan: skipped episode file '{}': {}", ep_name, e);
            }
            *order += 1;
        }

        sync_extras_for_entry(pool, entry_id, base_path, &rel_path).await?;
        return Ok(());
    }

    if kind == ScanKind::Movie && has_video_files {
        // Movie
        let result = sqlx::query(
            "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
        )
        .bind(library_id)
        .bind(movie_type_id)
        .execute(pool)
        .await?;

        let entry_id = result.last_insert_rowid();
        sqlx::query("INSERT INTO movie (id, title, folder_path, sort_title, sort_order, release_date) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(entry_id)
            .bind(&title)
            .bind(&rel_path)
            .bind(&sort_title)
            .bind(*next_order)
            .bind(&year)
            .execute(pool)
            .await?;
        *next_order += 1;

        cache_entry_images(pool, library_id, cache_base, base_path, &rel_path).await?;
        sync_extras_for_entry(pool, entry_id, base_path, &rel_path).await?;
        return Ok(());
    }

    // Container (or empty) folder — recurse with the same kind; produces no entry itself.
    let mut child_dirs: Vec<_> = subdirs;
    child_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for child_entry in child_dirs.iter() {
        scan_video_dir(
            app,
            pool,
            library_id,
            base_path,
            &child_entry.path(),
            cache_base,
            next_order,
            movie_type_id,
            show_type_id,
            kind,
            cancel,
        )
        .await?;
    }

    Ok(())
}

const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "avi", "m4v", "mov", "wmv", "flv", "webm", "ts", "mpg", "mpeg",
];

const AUDIO_EXTENSIONS: &[&str] = &[
    "flac", "mp3", "m4a", "wav", "aac", "ogg", "opus", "wma", "aiff", "ape",
];

fn is_media_file(path: &std::path::Path, extensions: &[&str]) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| extensions.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
}

fn parse_season_folder_name(name: &str) -> (String, Option<i32>) {
    let lower = name.to_lowercase();
    // "Specials" is the Plex/Jellyfin convention for Season 0. ("season 0"/"s0"/
    // "s00" already fall through to Some(0) via the numeric paths below.)
    if lower.trim() == "specials" {
        return (name.to_string(), Some(0));
    }
    if let Some(rest) = lower.strip_prefix("season ") {
        if let Ok(n) = rest.trim().parse::<i32>() {
            return (name.to_string(), Some(n));
        }
    }
    if let Some(rest) = lower.strip_prefix('s') {
        if rest.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty() {
            if let Ok(n) = rest.parse::<i32>() {
                return (name.to_string(), Some(n));
            }
        }
    }
    // Match `S\d+` as a token anywhere in the name (scene-release style, e.g. "Game.of.Thrones.S01.1080p...")
    // Token boundary: preceded by start/`.`/`_`/`-`/space, and not followed by `E\d` (which would be SxxExx = episode).
    let bytes = lower.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] != b's' { continue; }
        let left_ok = i == 0 || matches!(bytes[i - 1], b'.' | b'_' | b'-' | b' ');
        if !left_ok { continue; }
        let digits: String = lower[i + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() { continue; }
        let after = i + 1 + digits.len();
        if after < bytes.len() && bytes[after] == b'e' {
            let e_digits: String = lower[after + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
            if !e_digits.is_empty() { continue; } // SxxExx — treat as episode, not season
        }
        if let Ok(n) = digits.parse::<i32>() {
            return (name.to_string(), Some(n));
        }
    }
    (name.to_string(), None)
}

/// Read a run of ASCII digits at `pos`, returning (value, index_just_past_them).
fn read_episode_digits(lower: &str, pos: usize) -> Option<(i32, usize)> {
    let digits: String = lower[pos..].chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i32>().ok().map(|n| (n, pos + digits.len()))
}

/// Parse an episode filename into (title_stem, first_ep, last_ep).
///
/// `last_ep` is Some(n) only for genuine multi-episode files where n > first — e.g.
/// "S01E01-E02", "S01E01E02", "S01E01-02", "1x01-1x02", "1x01-02", and triple+ ranges
/// like "S01E01-E03". Everything between first and last is treated as covered. Ordinary
/// single episodes return None. Cross-season ranges ("S01E13-S02E01") keep the start
/// episode and don't try to span seasons.
fn parse_episode_range(name: &str) -> (String, Option<i32>, Option<i32>) {
    let stem = std::path::Path::new(name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let lower = stem.to_lowercase();
    let bytes = lower.as_bytes();

    // First episode: prefer SxxExx, fall back to NxMM ("1x03"). Record the episode number
    // and the index right after its digits (where a range continuation would begin).
    let mut first: Option<(i32, usize)> = None;
    for i in 0..bytes.len() {
        if bytes[i] != b's' { continue; }
        let Some((_, after_s)) = read_episode_digits(&lower, i + 1) else { continue; };
        if after_s >= bytes.len() || bytes[after_s] != b'e' { continue; }
        if let Some((ep, after_e)) = read_episode_digits(&lower, after_s + 1) {
            first = Some((ep, after_e));
            break;
        }
    }
    if first.is_none() {
        for i in 0..bytes.len() {
            if !bytes[i].is_ascii_digit() || (i > 0 && bytes[i - 1].is_ascii_digit()) { continue; }
            let Some((season_num, after_season)) = read_episode_digits(&lower, i) else { continue; };
            // A real season number is small; this guard avoids matching resolutions like "1920x1080".
            if season_num > 99 { continue; }
            if after_season >= bytes.len() || bytes[after_season] != b'x' { continue; }
            if let Some((ep, after_e)) = read_episode_digits(&lower, after_season + 1) {
                first = Some((ep, after_e));
                break;
            }
        }
    }

    let (first_ep, start_pos) = match first {
        Some(v) => v,
        None => return (stem, None, None),
    };

    // Walk range continuations: a separator/marker followed by another episode number.
    //   "-E02" | "-02" | "E02" | "x02" | "-1x02"  (repeated for triples+).
    let mut last = first_ep;
    let mut pos = start_pos;
    loop {
        let next = if pos < bytes.len() && bytes[pos] == b'-' {
            let p = pos + 1;
            if p < bytes.len() && bytes[p] == b'e' {
                read_episode_digits(&lower, p + 1)
            } else if let Some((n1, after1)) = read_episode_digits(&lower, p) {
                // "-1x02" → episode is after the 'x'; "-02" → the bare number.
                if after1 < bytes.len() && bytes[after1] == b'x' {
                    read_episode_digits(&lower, after1 + 1)
                } else {
                    Some((n1, after1))
                }
            } else {
                None
            }
        } else if pos < bytes.len() && matches!(bytes[pos], b'e' | b'x') {
            // Adjacent, no separator: "E02" / "x02".
            read_episode_digits(&lower, pos + 1)
        } else {
            None
        };
        // Guard: a real range steps up by a small amount. Rejecting anything more than
        // ~50 above the current number keeps resolution/quality tags ("-1080p", "-720p",
        // "-480") and years from being misread as an episode end.
        match next {
            Some((n, after)) if n > last && n <= last + 50 => {
                last = n;
                pos = after;
            }
            _ => break,
        }
    }

    let end = if last > first_ep { Some(last) } else { None };
    (stem, Some(first_ep), end)
}

fn parse_episode_filename(name: &str) -> (String, Option<i32>) {
    let (stem, start, _end) = parse_episode_range(name);
    (stem, start)
}

/// Season number from an episode filename's `SxxEyy` / `NxMM` marker (the "xx" / "N").
/// `None` when there's no recognizable marker — callers default flat-show episodes to Season 1.
fn parse_season_number(name: &str) -> Option<i32> {
    let stem = std::path::Path::new(name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let lower = stem.to_lowercase();
    let bytes = lower.as_bytes();
    // SxxEyy → season xx (only counts if an episode number follows, matching parse_episode_range).
    for i in 0..bytes.len() {
        if bytes[i] != b's' { continue; }
        let Some((season, after_s)) = read_episode_digits(&lower, i + 1) else { continue; };
        if after_s < bytes.len() && bytes[after_s] == b'e' && read_episode_digits(&lower, after_s + 1).is_some() {
            return Some(season);
        }
    }
    // NxMM → season N (guard against resolutions like "1920x1080").
    for i in 0..bytes.len() {
        if !bytes[i].is_ascii_digit() || (i > 0 && bytes[i - 1].is_ascii_digit()) { continue; }
        let Some((season, after_season)) = read_episode_digits(&lower, i) else { continue; };
        if season > 99 { continue; }
        if after_season < bytes.len() && bytes[after_season] == b'x' && read_episode_digits(&lower, after_season + 1).is_some() {
            return Some(season);
        }
    }
    None
}

#[cfg(test)]
mod episode_range_tests {
    use super::parse_episode_range;

    fn nums(name: &str) -> (Option<i32>, Option<i32>) {
        let (_, start, end) = parse_episode_range(name);
        (start, end)
    }

    #[test]
    fn single_episodes() {
        assert_eq!(nums("Show - S01E01 - Pilot.mkv"), (Some(1), None));
        assert_eq!(nums("Show.S02E14.1080p.mkv"), (Some(14), None));
        assert_eq!(nums("Show 1x05.mkv"), (Some(5), None));
    }

    #[test]
    fn multi_episode_forms() {
        assert_eq!(nums("Show - S01E01-E02 - Two.mkv"), (Some(1), Some(2)));
        assert_eq!(nums("Show.S01E01E02.1080p.mkv"), (Some(1), Some(2)));
        assert_eq!(nums("Show S01E01-02.mkv"), (Some(1), Some(2)));
        assert_eq!(nums("Show 1x01-1x02.mkv"), (Some(1), Some(2)));
        assert_eq!(nums("Show 1x01-02.mkv"), (Some(1), Some(2)));
        assert_eq!(nums("Show S01E01-E03.mkv"), (Some(1), Some(3)));
        assert_eq!(nums("Show S01E01-E02-E03.mkv"), (Some(1), Some(3)));
    }

    #[test]
    fn resolution_and_quality_are_not_ranges() {
        assert_eq!(nums("Show S01E05-1080p.mkv"), (Some(5), None));
        assert_eq!(nums("Show.S01E05-720p.x264.mkv"), (Some(5), None));
        assert_eq!(nums("Show S01E05 1920x1080.mkv"), (Some(5), None));
        assert_eq!(nums("Movie (2020) 1920x1080.mkv"), (None, None));
    }

    #[test]
    fn season_numbers() {
        use super::parse_season_number;
        assert_eq!(parse_season_number("Show - S01E01.mkv"), Some(1));
        assert_eq!(parse_season_number("Show.S02E05.1080p.mkv"), Some(2));
        assert_eq!(parse_season_number("Show 1x03.mkv"), Some(1));
        assert_eq!(parse_season_number("Show - Episode 1.mkv"), None);
        assert_eq!(parse_season_number("Show 1920x1080.mkv"), None);
    }
}

fn parse_song_filename(name: &str) -> (String, Option<i32>) {
    let stem = std::path::Path::new(name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Try leading digits: "01 - Title", "01. Title"
    let digits: String = stem.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        if let Ok(n) = digits.parse::<i32>() {
            let title = stem[digits.len()..]
                .trim_start_matches(|c: char| c == ' ' || c == '-' || c == '.')
                .to_string();
            let title = if title.is_empty() { stem.clone() } else { title };
            return (title, Some(n));
        }
    }

    (stem, None)
}

/// Folder names that never scan as entries or seasons. Mirrors the Plex/Jellyfin
/// extras conventions (plus our own covers/backdrops) so media that ships with
/// featurettes, trailers, webisodes, etc. doesn't produce bogus entries.
/// Case-insensitive. Not yet surfaced as playable extras — see TODO.
const RESERVED_DIRS: &[&str] = &[
    "covers",
    "backdrops",
    "extras",
    "featurettes",
    "behind the scenes",
    "deleted scenes",
    "interviews",
    "scenes",
    "samples",
    "shorts",
    "clips",
    "trailers",
    "other",
    "webisodes",
];

fn is_scannable_dir(entry: &std::fs::DirEntry) -> bool {
    let raw = entry.file_name().to_string_lossy().to_lowercase();
    // Releases often prefix extras folders to control sort order ("~featurettes",
    // "_extras", "- trailers"); strip that junk before the reserved-name check.
    let name = raw.trim_start_matches(['~', '-', '_', ' ', '.']);
    entry.path().is_dir()
        && !raw.starts_with('.')
        && !RESERVED_DIRS.contains(&name)
}

/// Reserved dirs whose videos surface as playable extras ("samples" is junk and
/// covers/backdrops are artwork — those stay invisible).
const EXTRA_DIRS: &[&str] = &[
    "extras",
    "featurettes",
    "behind the scenes",
    "deleted scenes",
    "interviews",
    "scenes",
    "shorts",
    "clips",
    "trailers",
    "other",
    "webisodes",
];

/// Normalized extras kind for a folder name ("~Featurettes" → "featurettes"),
/// or None if the folder isn't an extras dir.
fn extra_kind_for_dir(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let stripped = lower.trim_start_matches(['~', '-', '_', ' ', '.']);
    if EXTRA_DIRS.contains(&stripped) {
        Some(stripped.to_string())
    } else {
        None
    }
}

fn collect_extra_files(
    kind: &str,
    dir: &Path,
    base_path: &Path,
    out: &mut Vec<(String, String, String)>, // (kind, title, rel_file_path)
) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for f in entries {
        let p = f.path();
        if p.is_dir() {
            // Extras often nest ("webisodes\1. The Accountants\<file>",
            // "featurettes\Season 2\Deleted Scenes\<file>"). Recurse, and when a
            // nested folder is itself an extras kind, re-categorize its subtree.
            let name = f.file_name().to_string_lossy().to_string();
            let sub_kind = extra_kind_for_dir(&name).unwrap_or_else(|| kind.to_string());
            collect_extra_files(&sub_kind, &p, base_path, out);
        } else if is_media_file(&p, VIDEO_EXTENSIONS) {
            let title = p
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let rel = p
                .strip_prefix(base_path)
                .unwrap_or(&p)
                .to_string_lossy()
                .to_string();
            out.push((kind.to_string(), title, rel));
        }
    }
}

/// Rebuild the extras for one movie/show entry from disk: extras dirs directly
/// inside the entry folder, plus one level deeper (season folders). Diff-aware so
/// already-populated TMDB metadata survives rescans.
async fn sync_extras_for_entry(
    pool: &sqlx::SqlitePool,
    owner_id: i64,
    base_path: &Path,
    entry_rel_path: &str,
) -> Result<(), sqlx::Error> {
    let entry_dir = base_path.join(entry_rel_path);
    let mut found: Vec<(String, String, String)> = Vec::new();

    if let Ok(rd) = std::fs::read_dir(&entry_dir) {
        for e in rd.filter_map(|e| e.ok()) {
            if !e.path().is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(kind) = extra_kind_for_dir(&name) {
                collect_extra_files(&kind, &e.path(), base_path, &mut found);
            } else {
                let lower = name.to_lowercase();
                let stripped = lower.trim_start_matches(['~', '-', '_', ' ', '.']);
                if lower.starts_with('.') || RESERVED_DIRS.contains(&stripped) {
                    continue; // covers/backdrops/samples — not extras, not containers
                }
                // Season (or container) folder — check one level deeper
                if let Ok(rd2) = std::fs::read_dir(e.path()) {
                    for e2 in rd2.filter_map(|x| x.ok()) {
                        if !e2.path().is_dir() {
                            continue;
                        }
                        if let Some(kind) =
                            extra_kind_for_dir(&e2.file_name().to_string_lossy())
                        {
                            collect_extra_files(&kind, &e2.path(), base_path, &mut found);
                        }
                    }
                }
            }
        }
    }

    // Remove rows whose files vanished
    let existing: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, file_path FROM extra WHERE owner_id = ?")
            .bind(owner_id)
            .fetch_all(pool)
            .await?;
    let found_paths: std::collections::HashSet<&str> =
        found.iter().map(|(_, _, p)| p.as_str()).collect();
    for (id, fp) in &existing {
        if !found_paths.contains(fp.as_str()) {
            sqlx::query("DELETE FROM extra WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await?;
        }
    }

    // Upsert current files; keeps metadata on rows that already exist
    for (i, (kind, title, rel)) in found.iter().enumerate() {
        sqlx::query(
            "INSERT INTO extra (owner_id, kind, title, file_path, sort_order) VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(owner_id, file_path) DO UPDATE SET kind = excluded.kind, sort_order = excluded.sort_order",
        )
        .bind(owner_id)
        .bind(kind)
        .bind(title)
        .bind(rel)
        .bind(i as i64)
        .execute(pool)
        .await?;
    }

    Ok(())
}

fn parse_folder_name(name: &str) -> (String, Option<String>) {
    if let Some(paren_start) = name.rfind('(') {
        if let Some(paren_end) = name.rfind(')') {
            if paren_end > paren_start {
                let potential_year = &name[paren_start + 1..paren_end];
                if potential_year.len() == 4 && potential_year.chars().all(|c| c.is_ascii_digit()) {
                    let title = name[..paren_start].trim().to_string();
                    return (title, Some(potential_year.to_string()));
                }
            }
        }
    }
    (name.to_string(), None)
}

// ---------- Show Detail ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ShowDetail {
    pub id: i64,
    pub tmdb_id: Option<String>,
    pub imdb_id: Option<String>,
    /// RT slug for the show, mirrored from the `rt_slug` side table (the show
    /// row predates ratings and has no column of its own).
    pub rotten_tomatoes_id: Option<String>,
    pub plot: Option<String>,
    pub tagline: Option<String>,
    pub maturity_rating: Option<String>,
    pub genres: Vec<String>,
    pub creators: Vec<PersonInfo>,
    pub cast: Vec<CastInfo>,
    pub composers: Vec<PersonInfo>,
    pub studios: Vec<String>,
    pub keywords: Vec<String>,
    /// Sum of every episode's runtime — None unless ALL episodes have one,
    /// so a partial sum is never presented as the show's total.
    pub total_runtime: Option<i64>,
    /// Backdrop for the detail-page hero (selected, or first cached).
    pub backdrop: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SeasonDetailLocal {
    pub id: i64,
    pub title: String,
    pub season_number: Option<i64>,
    pub plot: Option<String>,
    pub cast: Vec<CastInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EpisodeDetailLocal {
    pub id: i64,
    pub title: String,
    pub episode_number: Option<i64>,
    pub episode_number_end: Option<i64>,
    pub release_date: Option<String>,
    pub plot: Option<String>,
    pub runtime: Option<i64>,
    pub cast: Vec<CastInfo>,
    pub directors: Vec<PersonInfo>,
    pub composers: Vec<PersonInfo>,
}


#[tauri::command]
pub async fn get_show_detail(
    state: tauri::State<'_, AppState>,
    show_id: i64,
) -> Result<ShowDetail, String> {
    // Uses shared app_db pool

    let show_row: Option<(Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>)> =
        sqlx::query_as(
            "SELECT tmdb_id, imdb_id, plot, tagline, maturity_rating_id FROM show WHERE id = ?",
        )
        .bind(show_id)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    let (tmdb_id, imdb_id, plot, tagline, mr_id) = show_row.ok_or("Show not found")?;

    let maturity_rating: Option<String> = if let Some(mid) = mr_id {
        sqlx::query_scalar("SELECT name FROM maturity_rating WHERE id = ?")
            .bind(mid)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
    } else {
        None
    };

    // Genres
    let genre_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT g.name FROM show_genre sg JOIN genre g ON sg.genre_id = g.id WHERE sg.show_id = ? ORDER BY g.name",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let genres: Vec<String> = genre_rows.into_iter().map(|(n,)| n).collect();

    // Creators
    let creator_rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path FROM show_creator sc JOIN person p ON sc.person_id = p.id WHERE sc.show_id = ? ORDER BY p.name",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let creators: Vec<PersonInfo> = creator_rows.into_iter().map(|(id, name, image_path)| PersonInfo { id, name, image_path }).collect();

    // Cast — show-level billing first, then anyone billed only on individual
    // seasons. Season casts aren't shown per-season in the UI (who appears in
    // which season spoils exits), so they fold into the one show-wide list.
    let cast_rows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path, sc.role FROM show_cast sc JOIN person p ON sc.person_id = p.id WHERE sc.show_id = ? ORDER BY sc.sort_order",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let season_cast_rows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path, sec.role \
         FROM season_cast sec \
         JOIN season s ON sec.season_id = s.id \
         JOIN person p ON sec.person_id = p.id \
         WHERE s.show_id = ? \
         ORDER BY s.season_number, sec.sort_order",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let mut seen_cast = std::collections::HashSet::new();
    let cast: Vec<CastInfo> = cast_rows
        .into_iter()
        .chain(season_cast_rows)
        .filter(|(id, _, _, _)| seen_cast.insert(*id))
        .map(|(id, name, image_path, role)| CastInfo { id, name, image_path, role })
        .collect();

    // Composers
    let composer_rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path FROM show_composer sc JOIN person p ON sc.person_id = p.id WHERE sc.show_id = ? ORDER BY p.name",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let composers: Vec<PersonInfo> = composer_rows.into_iter().map(|(id, name, image_path)| PersonInfo { id, name, image_path }).collect();

    // Studios
    let studio_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT s.name FROM show_studio ss JOIN studio s ON ss.studio_id = s.id WHERE ss.show_id = ? ORDER BY s.name",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let studios: Vec<String> = studio_rows.into_iter().map(|(n,)| n).collect();

    // Keywords
    let keyword_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT k.name FROM show_keyword sk JOIN keyword k ON sk.keyword_id = k.id WHERE sk.show_id = ? ORDER BY k.name",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let keywords: Vec<String> = keyword_rows.into_iter().map(|(n,)| n).collect();

    // Total runtime, only when every episode has one
    let (ep_count, runtime_count, runtime_sum): (i64, i64, Option<i64>) = sqlx::query_as(
        "SELECT COUNT(*), COUNT(e.runtime), SUM(e.runtime) FROM episode e JOIN season s ON e.season_id = s.id WHERE s.show_id = ?",
    )
    .bind(show_id)
    .fetch_one(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let total_runtime = if ep_count > 0 && ep_count == runtime_count { runtime_sum } else { None };

    let backdrop = entry_backdrop(&state.app_db, show_id).await?;

    let rotten_tomatoes_id: Option<String> =
        sqlx::query_scalar("SELECT slug FROM rt_slug WHERE entry_id = ?")
            .bind(show_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;

    Ok(ShowDetail {
        id: show_id,
        tmdb_id,
        imdb_id,
        rotten_tomatoes_id,
        plot,
        tagline,
        maturity_rating,
        genres,
        creators,
        cast,
        composers,
        studios,
        keywords,
        total_runtime,
        backdrop,
    })
}

#[tauri::command]
pub async fn get_season_detail_local(
    state: tauri::State<'_, AppState>,
    season_id: i64,
) -> Result<SeasonDetailLocal, String> {
    // Uses shared app_db pool

    let row: Option<(String, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT title, season_number, plot FROM season WHERE id = ?",
    )
    .bind(season_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (title, season_number, plot) = row.ok_or("Season not found")?;

    let cast_rows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path, sc.role FROM season_cast sc JOIN person p ON sc.person_id = p.id WHERE sc.season_id = ? ORDER BY sc.sort_order",
    )
    .bind(season_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let cast: Vec<CastInfo> = cast_rows.into_iter().map(|(id, name, image_path, role)| CastInfo { id, name, image_path, role }).collect();

    Ok(SeasonDetailLocal {
        id: season_id,
        title,
        season_number,
        plot,
        cast,
    })
}

#[tauri::command]
pub async fn get_episode_detail_local(
    state: tauri::State<'_, AppState>,
    episode_id: i64,
) -> Result<EpisodeDetailLocal, String> {
    // Uses shared app_db pool

    let row: Option<(String, Option<i64>, Option<i64>, Option<String>, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT title, episode_number, episode_number_end, release_date, plot, runtime FROM episode WHERE id = ?",
    )
    .bind(episode_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (title, episode_number, episode_number_end, release_date, plot, runtime) = row.ok_or("Episode not found")?;

    let cast_rows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path, ec.role FROM episode_cast ec JOIN person p ON ec.person_id = p.id WHERE ec.episode_id = ? ORDER BY ec.sort_order",
    )
    .bind(episode_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let cast: Vec<CastInfo> = cast_rows.into_iter().map(|(id, name, image_path, role)| CastInfo { id, name, image_path, role }).collect();

    let director_rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path FROM episode_director ed JOIN person p ON ed.person_id = p.id WHERE ed.episode_id = ? ORDER BY p.name",
    )
    .bind(episode_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let directors: Vec<PersonInfo> = director_rows.into_iter().map(|(id, name, image_path)| PersonInfo { id, name, image_path }).collect();

    let composer_rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path FROM episode_composer ec JOIN person p ON ec.person_id = p.id WHERE ec.episode_id = ? ORDER BY p.name",
    )
    .bind(episode_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let composers: Vec<PersonInfo> = composer_rows.into_iter().map(|(id, name, image_path)| PersonInfo { id, name, image_path }).collect();

    Ok(EpisodeDetailLocal {
        id: episode_id,
        title,
        episode_number,
        episode_number_end,
        release_date,
        plot,
        runtime,
        cast,
        directors,
        composers,
    })
}

// ---------- Show TMDB Commands ----------

#[tauri::command]
pub async fn search_tmdb_show(
    state: tauri::State<'_, AppState>,
    query: String,
    year: Option<String>,
) -> Result<Vec<crate::tmdb::TmdbTvSearchResult>, String> {
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;

    let client = reqwest::Client::new();
    let resp = crate::tmdb::search_tv(&client, &token, &query, year.as_deref()).await?;
    Ok(resp.results)
}

#[tauri::command]
pub async fn get_tmdb_show_detail(
    state: tauri::State<'_, AppState>,
    tmdb_id: i64,
) -> Result<crate::tmdb::TmdbTvDetail, String> {
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;

    let client = reqwest::Client::new();
    crate::tmdb::get_tv_detail(&client, &token, tmdb_id).await
}

#[tauri::command]
pub async fn get_tmdb_season_detail(
    state: tauri::State<'_, AppState>,
    tmdb_id: i64,
    season_number: i64,
) -> Result<crate::tmdb::TmdbSeasonDetail, String> {
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;

    let client = reqwest::Client::new();
    crate::tmdb::get_season_detail(&client, &token, tmdb_id, season_number).await
}

#[tauri::command]
pub async fn get_tmdb_episode_detail(
    state: tauri::State<'_, AppState>,
    tmdb_id: i64,
    season_number: i64,
    episode_number: i64,
) -> Result<crate::tmdb::TmdbEpisodeDetail, String> {
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;

    let client = reqwest::Client::new();
    crate::tmdb::get_episode_detail(&client, &token, tmdb_id, season_number, episode_number).await
}

// ---------- Bulk TMDB matching targets ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BulkMovieTarget {
    pub id: i64,
    pub title: String,
    pub year: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BulkShowTarget {
    pub id: i64,
    pub title: String,
    /// Earliest episode year — used to disambiguate the TMDB search the same way
    /// movie year does (e.g. "The Office" US vs UK).
    pub year: Option<String>,
    /// Already-matched shows carry their tmdb_id so season/episode passes can
    /// cover them even when the "shows" checkbox is off.
    pub tmdb_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BulkSeasonTarget {
    pub id: i64,
    pub show_id: i64,
    pub season_number: i64,
    pub episode_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BulkWebisodeTarget {
    pub show_id: i64,
    pub extra_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbBulkTargets {
    pub movies: Vec<BulkMovieTarget>,
    pub shows: Vec<BulkShowTarget>,
    pub seasons: Vec<BulkSeasonTarget>,
    /// Shows that have webisode extras (matchable against TMDB season 0).
    pub webisodes: Vec<BulkWebisodeTarget>,
    /// Every movie in the library — the ratings pass targets all of them.
    pub all_movies: Vec<BulkMovieTarget>,
    /// Every show in the library — the ratings pass covers these too (year is
    /// the earliest episode air year, used for RT slug discovery).
    pub all_shows: Vec<BulkMovieTarget>,
}

/// Everything the bulk-match dialog needs to show counts and drive the run:
/// movies/shows still missing a TMDB match, plus all numbered seasons (with
/// episode counts) so season/episode passes can be estimated and executed.
#[tauri::command]
pub async fn get_tmdb_bulk_targets(
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<TmdbBulkTargets, String> {
    let movies: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT m.id, m.title, SUBSTR(m.release_date, 1, 4) \
         FROM movie m JOIN media_entry me ON me.id = m.id \
         WHERE me.library_id = ? AND (m.tmdb_id IS NULL OR m.tmdb_id = '') \
         ORDER BY m.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let shows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT s.id, s.title, \
                (SELECT MIN(SUBSTR(e.release_date, 1, 4)) FROM episode e \
                 JOIN season se ON e.season_id = se.id \
                 WHERE se.show_id = s.id AND e.release_date IS NOT NULL), \
                CAST(s.tmdb_id AS TEXT) \
         FROM show s JOIN media_entry me ON me.id = s.id \
         WHERE me.library_id = ? \
         ORDER BY s.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let seasons: Vec<(i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT se.id, se.show_id, se.season_number, \
           (SELECT COUNT(*) FROM episode e WHERE e.season_id = se.id) \
         FROM season se JOIN media_entry me ON me.id = se.show_id \
         WHERE me.library_id = ? AND se.season_number IS NOT NULL \
         ORDER BY se.show_id, se.season_number",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let webisodes: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT e.owner_id, COUNT(*) FROM extra e \
         JOIN media_entry me ON me.id = e.owner_id \
         WHERE me.library_id = ? AND e.kind = 'webisodes' \
         GROUP BY e.owner_id",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let all_movies: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT m.id, m.title, SUBSTR(m.release_date, 1, 4) \
         FROM movie m JOIN media_entry me ON me.id = m.id \
         WHERE me.library_id = ? \
         ORDER BY m.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let all_shows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT sh.id, sh.title, \
                (SELECT MIN(SUBSTR(e.release_date, 1, 4)) FROM episode e \
                 JOIN season s ON e.season_id = s.id \
                 WHERE s.show_id = sh.id AND e.release_date IS NOT NULL) \
         FROM show sh JOIN media_entry me ON me.id = sh.id \
         WHERE me.library_id = ? \
         ORDER BY sh.sort_title COLLATE NOCASE",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(TmdbBulkTargets {
        movies: movies
            .into_iter()
            .map(|(id, title, year)| BulkMovieTarget {
                id,
                title,
                year: year.filter(|y| !y.is_empty()),
            })
            .collect(),
        shows: shows
            .into_iter()
            .map(|(id, title, year, tmdb_id)| BulkShowTarget {
                id,
                title,
                year: year.filter(|y| !y.is_empty()),
                tmdb_id: tmdb_id.filter(|t| !t.is_empty()),
            })
            .collect(),
        seasons: seasons
            .into_iter()
            .map(|(id, show_id, season_number, episode_count)| BulkSeasonTarget {
                id,
                show_id,
                season_number,
                episode_count,
            })
            .collect(),
        webisodes: webisodes
            .into_iter()
            .map(|(show_id, extra_count)| BulkWebisodeTarget { show_id, extra_count })
            .collect(),
        all_movies: all_movies
            .into_iter()
            .map(|(id, title, year)| BulkMovieTarget {
                id,
                title,
                year: year.filter(|y| !y.is_empty()),
            })
            .collect(),
        all_shows: all_shows
            .into_iter()
            .map(|(id, title, year)| BulkMovieTarget {
                id,
                title,
                year: year.filter(|y| !y.is_empty()),
            })
            .collect(),
    })
}

// ---------- Apply TMDB Show Metadata ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbShowFieldSelection {
    pub tmdb_id: Option<String>,
    pub imdb_id: Option<String>,
    pub plot: Option<String>,
    pub tagline: Option<String>,
    pub maturity_rating: Option<String>,
    pub genres: Option<Vec<String>>,
    pub creators: Option<Vec<PersonUpdateInfo>>,
    pub cast: Option<Vec<CastUpdateInfo>>,
    pub composers: Option<Vec<PersonUpdateInfo>>,
    pub studios: Option<Vec<String>>,
    pub keywords: Option<Vec<String>>,
}

#[tauri::command]
pub async fn apply_tmdb_show_metadata(
    state: tauri::State<'_, AppState>,
    show_id: i64,
    fields: TmdbShowFieldSelection,
) -> Result<(), String> {
    let mut new_people: Vec<(i64, i64, Option<String>)> = Vec::new();

    // Scalar fields on show table
    if let Some(ref tmdb_id) = fields.tmdb_id {
        sqlx::query("UPDATE show SET tmdb_id = ? WHERE id = ?")
            .bind(tmdb_id).bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }
    if let Some(ref imdb_id) = fields.imdb_id {
        sqlx::query("UPDATE show SET imdb_id = ? WHERE id = ?")
            .bind(imdb_id).bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }
    if let Some(ref plot) = fields.plot {
        sqlx::query("UPDATE show SET plot = ? WHERE id = ?")
            .bind(plot).bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }
    if let Some(ref tagline) = fields.tagline {
        sqlx::query("UPDATE show SET tagline = ? WHERE id = ?")
            .bind(tagline).bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }

    // Maturity rating
    if let Some(ref mr_name) = fields.maturity_rating {
        if mr_name.is_empty() {
            sqlx::query("UPDATE show SET maturity_rating_id = NULL WHERE id = ?")
                .bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        } else {
            sqlx::query("INSERT OR IGNORE INTO maturity_rating (name) VALUES (?)")
                .bind(mr_name).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            sqlx::query("UPDATE show SET maturity_rating_id = (SELECT id FROM maturity_rating WHERE name = ?) WHERE id = ?")
                .bind(mr_name).bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    // Junction tables
    if let Some(ref genres) = fields.genres {
        sqlx::query("DELETE FROM show_genre WHERE show_id = ?").bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for name in genres {
            sqlx::query("INSERT OR IGNORE INTO genre (name) VALUES (?)").bind(name).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO show_genre (show_id, genre_id) VALUES (?, (SELECT id FROM genre WHERE name = ?))")
                .bind(show_id).bind(name).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref creators) = fields.creators {
        sqlx::query("DELETE FROM show_creator WHERE show_id = ?").bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for c in creators {
            let person_id = ensure_person(&state.app_db, &c.name, c.tmdb_id).await?;
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT INTO show_creator (show_id, person_id) VALUES (?, ?)")
                .bind(show_id).bind(person_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref cast) = fields.cast {
        sqlx::query("DELETE FROM show_cast WHERE show_id = ?").bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for (i, c) in cast.iter().enumerate() {
            let person_id = ensure_person(&state.app_db, &c.name, c.tmdb_id).await?;
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT INTO show_cast (show_id, person_id, role, sort_order) VALUES (?, ?, ?, ?)")
                .bind(show_id).bind(person_id).bind(&c.role).bind(i as i64).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref composers) = fields.composers {
        sqlx::query("DELETE FROM show_composer WHERE show_id = ?").bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for c in composers {
            let person_id = ensure_person(&state.app_db, &c.name, c.tmdb_id).await?;
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT OR IGNORE INTO show_composer (show_id, person_id) VALUES (?, ?)")
                .bind(show_id).bind(person_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref studios) = fields.studios {
        sqlx::query("DELETE FROM show_studio WHERE show_id = ?").bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for name in studios {
            sqlx::query("INSERT OR IGNORE INTO studio (name) VALUES (?)").bind(name).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO show_studio (show_id, studio_id) VALUES (?, (SELECT id FROM studio WHERE name = ?))")
                .bind(show_id).bind(name).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref keywords) = fields.keywords {
        sqlx::query("DELETE FROM show_keyword WHERE show_id = ?").bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for name in keywords {
            sqlx::query("INSERT OR IGNORE INTO keyword (name) VALUES (?)").bind(name).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO show_keyword (show_id, keyword_id) VALUES (?, (SELECT id FROM keyword WHERE name = ?))")
                .bind(show_id).bind(name).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    process_person_images(&state.app_db, &state.app_data_dir, new_people).await;
    Ok(())
}

// ---------- Apply TMDB Season Metadata ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbSeasonFieldSelection {
    pub plot: Option<String>,
    pub cast: Option<Vec<CastUpdateInfo>>,
    /// Director(s) of every episode in this season — fanned out to one episode_director row per episode on apply.
    pub season_director: Option<Vec<PersonUpdateInfo>>,
}

#[tauri::command]
pub async fn apply_tmdb_season_metadata(
    state: tauri::State<'_, AppState>,
    season_id: i64,
    fields: TmdbSeasonFieldSelection,
) -> Result<(), String> {
    let mut new_people: Vec<(i64, i64, Option<String>)> = Vec::new();

    if let Some(ref plot) = fields.plot {
        sqlx::query("UPDATE season SET plot = ? WHERE id = ?")
            .bind(plot).bind(season_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }

    if let Some(ref cast) = fields.cast {
        sqlx::query("DELETE FROM season_cast WHERE season_id = ?").bind(season_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for (i, c) in cast.iter().enumerate() {
            let person_id = ensure_person(&state.app_db, &c.name, c.tmdb_id).await?;
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT INTO season_cast (season_id, person_id, role, sort_order) VALUES (?, ?, ?, ?)")
                .bind(season_id).bind(person_id).bind(&c.role).bind(i as i64).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    // Season-wide director fans out to every episode in this season.
    // Idempotent: INSERT OR IGNORE + composite PK on episode_director.
    if let Some(ref directors) = fields.season_director {
        let episode_ids: Vec<(i64,)> = sqlx::query_as("SELECT id FROM episode WHERE season_id = ?")
            .bind(season_id)
            .fetch_all(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for d in directors {
            let person_id = ensure_person(&state.app_db, &d.name, d.tmdb_id).await?;
            if let Some(tid) = d.tmdb_id { new_people.push((person_id, tid, d.profile_path.clone())); }
            for (ep_id,) in &episode_ids {
                sqlx::query("INSERT OR IGNORE INTO episode_director (episode_id, person_id) VALUES (?, ?)")
                    .bind(ep_id)
                    .bind(person_id)
                    .execute(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    process_person_images(&state.app_db, &state.app_data_dir, new_people).await;
    Ok(())
}

// ---------- Apply TMDB Episode Metadata ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbEpisodeFieldSelection {
    pub title: Option<String>,
    pub plot: Option<String>,
    pub runtime: Option<i64>,
    pub release_date: Option<String>,
    pub cast: Option<Vec<CastUpdateInfo>>,
    pub director: Option<Vec<PersonUpdateInfo>>,
    pub composer: Option<Vec<PersonUpdateInfo>>,
}

#[tauri::command]
pub async fn apply_tmdb_episode_metadata(
    state: tauri::State<'_, AppState>,
    episode_id: i64,
    fields: TmdbEpisodeFieldSelection,
) -> Result<(), String> {
    let mut new_people: Vec<(i64, i64, Option<String>)> = Vec::new();

    if let Some(ref title) = fields.title {
        if !title.trim().is_empty() {
            sqlx::query("UPDATE episode SET title = ? WHERE id = ?")
                .bind(title.trim()).bind(episode_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }
    if let Some(ref plot) = fields.plot {
        sqlx::query("UPDATE episode SET plot = ? WHERE id = ?")
            .bind(plot).bind(episode_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }
    if let Some(runtime) = fields.runtime {
        sqlx::query("UPDATE episode SET runtime = ? WHERE id = ?")
            .bind(runtime).bind(episode_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }
    if let Some(ref release_date) = fields.release_date {
        sqlx::query("UPDATE episode SET release_date = ? WHERE id = ?")
            .bind(release_date).bind(episode_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }

    if let Some(ref cast) = fields.cast {
        sqlx::query("DELETE FROM episode_cast WHERE episode_id = ?").bind(episode_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for (i, c) in cast.iter().enumerate() {
            let person_id = ensure_person(&state.app_db, &c.name, c.tmdb_id).await?;
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT INTO episode_cast (episode_id, person_id, role, sort_order) VALUES (?, ?, ?, ?)")
                .bind(episode_id).bind(person_id).bind(&c.role).bind(i as i64).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref directors) = fields.director {
        sqlx::query("DELETE FROM episode_director WHERE episode_id = ?").bind(episode_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for d in directors {
            let person_id = ensure_person(&state.app_db, &d.name, d.tmdb_id).await?;
            if let Some(tid) = d.tmdb_id { new_people.push((person_id, tid, d.profile_path.clone())); }
            sqlx::query("INSERT OR IGNORE INTO episode_director (episode_id, person_id) VALUES (?, ?)")
                .bind(episode_id).bind(person_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref composers) = fields.composer {
        sqlx::query("DELETE FROM episode_composer WHERE episode_id = ?").bind(episode_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for c in composers {
            let person_id = ensure_person(&state.app_db, &c.name, c.tmdb_id).await?;
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT OR IGNORE INTO episode_composer (episode_id, person_id) VALUES (?, ?)")
                .bind(episode_id).bind(person_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    process_person_images(&state.app_db, &state.app_data_dir, new_people).await;
    Ok(())
}

// ---------- Bulk Apply TMDB Episode Details for a Season ----------

#[tauri::command]
pub async fn apply_tmdb_season_episodes(
    state: tauri::State<'_, AppState>,
    season_id: i64,
    tmdb_id: i64,
    season_number: i64,
) -> Result<i64, String> {
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;

    let mut new_people: Vec<(i64, i64, Option<String>)> = Vec::new();

    // Get local episodes for this season (with the end of any multi-episode range)
    let local_episodes: Vec<(i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT id, episode_number, episode_number_end FROM episode WHERE season_id = ? ORDER BY episode_number",
    )
    .bind(season_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    // Fetch TMDB season detail (includes episode summaries with guest_stars and crew)
    let client = reqwest::Client::new();
    let season_detail = crate::tmdb::get_season_detail(&client, &token, tmdb_id, season_number).await?;

    let mut applied_count: i64 = 0;

    // Match by episode number
    for (local_id, local_ep_num, local_ep_end) in &local_episodes {
        let local_num = match local_ep_num {
            Some(n) => *n,
            None => continue,
        };
        // A multi-episode file (e.g. "S01E01-E02") covers a range; merge all of them.
        let end_num = local_ep_end.unwrap_or(local_num).max(local_num);
        let covered: Vec<&_> = (local_num..=end_num)
            .filter_map(|n| season_detail.episodes.iter().find(|e| e.episode_number == n))
            .collect();
        // Guest stars / crew below still come from the first covered episode.
        let tmdb_ep = match covered.first() {
            Some(e) => *e,
            None => continue,
        };

        // Title: join the covered episodes' names with " / " (TMDB is authoritative → overwrite).
        let merged_title = covered.iter()
            .map(|e| e.name.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" / ");
        if !merged_title.is_empty() {
            sqlx::query("UPDATE episode SET title = ? WHERE id = ?")
                .bind(&merged_title).bind(local_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }

        // Plot: join covered overviews with " / " (fill-if-empty, preserving manual edits).
        let merged_plot = covered.iter()
            .filter_map(|e| e.overview.as_deref())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" / ");
        if !merged_plot.is_empty() {
            sqlx::query("UPDATE episode SET plot = COALESCE(plot, ?) WHERE id = ? AND plot IS NULL")
                .bind(&merged_plot).bind(local_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }

        // Runtime: sum the covered episodes (a double-episode file is the length of both).
        let merged_runtime: i64 = covered.iter().filter_map(|e| e.runtime).sum();
        if merged_runtime > 0 {
            sqlx::query("UPDATE episode SET runtime = COALESCE(runtime, ?) WHERE id = ? AND runtime IS NULL")
                .bind(merged_runtime).bind(local_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }

        // Air date: the first covered episode's date.
        if let Some(air_date) = covered.iter().filter_map(|e| e.air_date.as_deref()).find(|s| !s.is_empty()) {
            sqlx::query("UPDATE episode SET release_date = COALESCE(release_date, ?) WHERE id = ? AND release_date IS NULL")
                .bind(air_date).bind(local_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }

        // Guest stars
        if !tmdb_ep.guest_stars.is_empty() {
            // Only populate if episode has no cast yet
            let existing: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM episode_cast WHERE episode_id = ?")
                .bind(local_id).fetch_one(&state.app_db).await.map_err(|e| e.to_string())?;
            if existing.0 == 0 {
                for (i, gs) in tmdb_ep.guest_stars.iter().enumerate() {
                    let person_id = ensure_person(&state.app_db, &gs.name, Some(gs.id)).await?;
                    new_people.push((person_id, gs.id, gs.profile_path.clone()));
                    sqlx::query("INSERT INTO episode_cast (episode_id, person_id, role, sort_order) VALUES (?, ?, ?, ?)")
                        .bind(local_id).bind(person_id).bind(&gs.character).bind(i as i64)
                        .execute(&state.app_db).await.map_err(|e| e.to_string())?;
                }
            }
        }

        // Extract directors + composers from episode crew and write to dedicated tables.
        // Idempotent (INSERT OR IGNORE on composite PK) so re-running the bulk apply doesn't duplicate.
        for c in &tmdb_ep.crew {
            let is_director = c.job.as_deref() == Some("Director");
            let is_composer = matches!(c.job.as_deref(), Some("Composer") | Some("Original Music Composer"));
            if !is_director && !is_composer { continue; }

            let person_id = ensure_person(&state.app_db, &c.name, Some(c.id)).await?;
            new_people.push((person_id, c.id, c.profile_path.clone()));

            if is_director {
                sqlx::query("INSERT OR IGNORE INTO episode_director (episode_id, person_id) VALUES (?, ?)")
                    .bind(local_id).bind(person_id)
                    .execute(&state.app_db).await.map_err(|e| e.to_string())?;
            }
            if is_composer {
                sqlx::query("INSERT OR IGNORE INTO episode_composer (episode_id, person_id) VALUES (?, ?)")
                    .bind(local_id).bind(person_id)
                    .execute(&state.app_db).await.map_err(|e| e.to_string())?;
            }
        }

        applied_count += 1;
    }

    process_person_images(&state.app_db, &state.app_data_dir, new_people).await;
    Ok(applied_count)
}
