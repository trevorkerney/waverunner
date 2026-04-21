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

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Rename a file or directory. On Windows, if `std::fs::rename` fails (commonly with
/// error 5 ACCESS_DENIED when an SMB share's client holds descendant oplocks from a
/// recent transfer — a state that blocks `MoveFileEx`), fall back to the Windows
/// Shell COM rename path that File Explorer uses, which handles locked descendants.
fn rename_path(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(e) => {
            eprintln!(
                "std::fs::rename({:?} -> {:?}) failed: {} (os error {:?}); trying shell rename",
                from, to, e, e.raw_os_error()
            );
            shell_rename_windows(from, to)
        }
        #[cfg(not(windows))]
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
fn shell_rename_windows(from: &Path, to: &Path) -> std::io::Result<()> {
    let parent = from
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent dir"))?;
    let old_name = from
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no source name"))?
        .to_string_lossy();
    let new_name = to
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no dest name"))?
        .to_string_lossy();

    // PowerShell single-quote escapes apostrophes by doubling them.
    let parent_esc = parent.to_string_lossy().replace('\'', "''");
    let old_esc = old_name.replace('\'', "''");
    let new_esc = new_name.replace('\'', "''");
    let dest_esc = to.to_string_lossy().replace('\'', "''");

    let script = format!(
        "$shell = New-Object -ComObject Shell.Application; \
         $f = $shell.NameSpace('{}'); \
         $i = $f.ParseName('{}'); \
         if ($null -eq $i) {{ exit 1 }}; \
         $i.Name = '{}'; \
         if (Test-Path '{}') {{ exit 0 }} else {{ exit 1 }}",
        parent_esc, old_esc, new_esc, dest_esc
    );

    let output = std::process::Command::new("powershell")
        .args(["-ExecutionPolicy", "Bypass", "-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to launch PowerShell: {}", e),
            )
        })?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("Shell rename failed: {}", stderr.trim()),
        ))
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Library {
    pub id: String,
    pub name: String,
    pub paths: Vec<String>,
    pub format: String,
    pub portable: bool,
    pub default_sort_mode: String,
    pub managed: bool,
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
    /// Number of distinct movies this person has a credit on for the requested role.
    pub movie_count: i64,
    /// Number of distinct shows this person has a credit on for the requested role.
    /// A show counts once regardless of how many seasons/episodes the person is in.
    pub show_count: i64,
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
    pub directors: Option<Vec<PersonUpdateInfo>>,
    pub cast: Option<Vec<CastUpdateInfo>>,
    pub composers: Option<Vec<PersonUpdateInfo>>,
    pub studios: Option<Vec<String>>,
    pub keywords: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CastUpdateInfo {
    /// Set when the picker resolved to an existing person record. Apply commands use
    /// this directly and skip `ensure_person` — preserving identity across renames and
    /// avoiding near-duplicate rows from minor spelling drift. Missing/null means
    /// "create or match by (tmdb_id, name)" via `ensure_person` (existing behavior).
    #[serde(default)]
    pub person_id: Option<i64>,
    pub name: String,
    pub role: Option<String>,
    pub tmdb_id: Option<i64>,
    pub profile_path: Option<String>,
}


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersonUpdateInfo {
    /// See [CastUpdateInfo::person_id].
    #[serde(default)]
    pub person_id: Option<i64>,
    pub name: String,
    pub tmdb_id: Option<i64>,
    pub profile_path: Option<String>,
}

/// Full person record returned to the frontend for the person-detail page's header +
/// biography panel and for the "Match to TMDB" / "Refresh" / "Clear" flows.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersonDetail {
    pub id: i64,
    pub name: String,
    pub image_path: Option<String>,
    pub tmdb_id: Option<i64>,
    pub bio: Option<String>,
}

/// A local-DB hit in the picker. Same shape as PersonInfo but includes tmdb_id so
/// the caller can show a "matched" badge without a second call.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalPersonSearchResult {
    pub id: i64,
    pub name: String,
    pub image_path: Option<String>,
    pub tmdb_id: Option<i64>,
}

/// TMDB-person search result (flattened from `/search/person` into what the picker
/// actually needs for display).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbPersonSearchResult {
    pub id: i64,
    pub name: String,
    pub profile_path: Option<String>,
    pub known_for_department: Option<String>,
    /// Short description of top works (up to 3 titles joined by ", "). Null when TMDB
    /// didn't include any known_for entries.
    pub known_for_summary: Option<String>,
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
    paths: Vec<String>,
    format: String,
    portable: bool,
    managed: bool,
) -> Result<Library, String> {
    if !matches!(format.as_str(), "video" | "music") {
        return Err(format!("Unsupported library format: {}", format));
    }
    if paths.is_empty() {
        return Err("At least one path is required".to_string());
    }
    for p in &paths {
        if !PathBuf::from(p).exists() {
            return Err(format!("Path does not exist: {}", p));
        }
    }

    let id = uuid_simple();

    let cache_base = state.app_data_dir.join("cache").join(&id);
    std::fs::create_dir_all(&cache_base).map_err(|e| e.to_string())?;

    let paths_json = serde_json::to_string(&paths).map_err(|e| e.to_string())?;

    let library = Library {
        id: id.clone(),
        name: name.clone(),
        paths: paths.clone(),
        format: format.clone(),
        portable,
        default_sort_mode: "alpha".to_string(),
        managed,
    };

    sqlx::query(
        "INSERT INTO library (id, name, paths, format, portable, default_sort_mode, managed, creating) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
    )
    .bind(&library.id)
    .bind(&library.name)
    .bind(&paths_json)
    .bind(&library.format)
    .bind(library.portable as i32)
    .bind(&library.default_sort_mode)
    .bind(library.managed as i32)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

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
                for p in &paths {
                    let lib_path = PathBuf::from(p);
                    scan_video_library(&app, pool, &id, &lib_path, &cache_base, cancel).await.map_err(|e| e.to_string())?;
                }
            }
            "music" => {
                sqlx::query("DELETE FROM media_entry WHERE library_id = ?")
                    .bind(&id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                for p in &paths {
                    let lib_path = PathBuf::from(p);
                    scan_music_library(&app, pool, &id, &lib_path, &cache_base, cancel).await.map_err(|e| e.to_string())?;
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
    let rows: Vec<(String, String, String, String, i32, String, i32)> = sqlx::query_as(
        "SELECT id, name, paths, format, portable, default_sort_mode, managed FROM library WHERE creating = 0 ORDER BY name",
    )
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, name, paths_json, format, portable, default_sort_mode, managed)| Library {
            id,
            name,
            paths: serde_json::from_str(&paths_json).unwrap_or_default(),
            format,
            portable: portable != 0,
            default_sort_mode,
            managed: managed != 0,
        })
        .collect())
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
                 CASE WHEN mef.entry_type = 'show' THEN \
                   (SELECT CASE \
                     WHEN COUNT(*) = 0 THEN NULL \
                     WHEN COUNT(*) = 1 AND MIN(s.season_number) IS NOT NULL THEN 'season ' || MIN(s.season_number) \
                     WHEN COUNT(*) = 1 THEN '1 season' \
                     WHEN COUNT(s.season_number) = COUNT(*) \
                       AND COUNT(*) = (MAX(s.season_number) - MIN(s.season_number) + 1) \
                       THEN 'seasons ' || MIN(s.season_number) || '\u{2013}' || MAX(s.season_number) \
                     ELSE COUNT(*) || ' seasons' \
                   END FROM season s WHERE s.show_id = mef.id) \
                 END as season_display \
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
                        if !parts.is_empty() {
                            entry.collection_display = Some(parts.join(" and "));
                        }
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
            let season_display_expr = "\
                CASE WHEN mef.entry_type = 'show' THEN \
                  (SELECT CASE \
                    WHEN COUNT(*) = 0 THEN NULL \
                    WHEN COUNT(*) = 1 AND MIN(s.season_number) IS NOT NULL THEN 'season ' || MIN(s.season_number) \
                    WHEN COUNT(*) = 1 THEN '1 season' \
                    WHEN COUNT(s.season_number) = COUNT(*) \
                      AND COUNT(*) = (MAX(s.season_number) - MIN(s.season_number) + 1) \
                      THEN 'seasons ' || MIN(s.season_number) || '\u{2013}' || MAX(s.season_number) \
                    ELSE COUNT(*) || ' seasons' \
                  END FROM season s WHERE s.show_id = mef.id) \
                END";
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
                    MediaEntry { id, title, year, end_year, folder_path, parent_id, entry_type, covers, selected_cover, child_count: 0, season_display, collection_display: None, tmdb_id, link_id: None }
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
                        if !parts.is_empty() {
                            entry.collection_display = Some(parts.join(" and "));
                        }
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
                    MediaEntry { id, title, year: None, end_year: None, folder_path, parent_id: None, entry_type: "artist".to_string(), covers, selected_cover, child_count: 0, season_display: None, collection_display: None, tmdb_id: None, link_id: None }
                })
                .collect()
        }
        _ => {
            return Err(format!("Unsupported library format: {}", format));
        }
    };

    Ok(entries)
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

    // Directors / Cast / Composers — route every person reference through
    // `ensure_person` so tmdb_id gets stored for TMDB-matched entries, and honor the
    // picker's `person_id` hint to preserve existing identities without name-matching.
    // Collected tmdb_id+profile_path tuples get handed to process_person_images at the
    // end for image downloads.
    let mut new_people: Vec<(i64, i64, Option<String>)> = Vec::new();

    if let Some(ref directors) = detail.directors {
        sqlx::query("DELETE FROM movie_director WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for d in directors {
            let person_id = if let Some(pid) = d.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &d.name, d.tmdb_id).await?
            };
            if let Some(tid) = d.tmdb_id {
                new_people.push((person_id, tid, d.profile_path.clone()));
            }
            sqlx::query("INSERT INTO movie_director (movie_id, person_id) VALUES (?, ?)")
                .bind(entry_id)
                .bind(person_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref cast) = detail.cast {
        sqlx::query("DELETE FROM movie_cast WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for (i, c) in cast.iter().enumerate() {
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
            if let Some(tid) = c.tmdb_id {
                new_people.push((person_id, tid, c.profile_path.clone()));
            }
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

    if let Some(ref composers) = detail.composers {
        sqlx::query("DELETE FROM movie_composer WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        for c in composers {
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
            if let Some(tid) = c.tmdb_id {
                new_people.push((person_id, tid, c.profile_path.clone()));
            }
            sqlx::query("INSERT OR IGNORE INTO movie_composer (movie_id, person_id) VALUES (?, ?)")
                .bind(entry_id)
                .bind(person_id)
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

    process_person_images(&state.app_db, &state.app_data_dir, new_people).await;
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
            let person_id = if let Some(pid) = d.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &d.name, d.tmdb_id).await?
            };
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
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
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
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
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
    pub image_type: String, // "cover" or "background"
}

#[tauri::command]
pub async fn download_tmdb_images(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    images: Vec<TmdbImageDownload>,
) -> Result<(), String> {
    let lib_paths = get_library_paths(&state.app_db, &library_id).await?;

    // Get entry folder_path from view
    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry_full WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path,) = entry_row.ok_or("Entry not found")?;

    let root = resolve_entry_root(&lib_paths, &folder_path)
        .ok_or("Could not resolve entry folder on disk")?;
    let full_entry_path = PathBuf::from(root).join(&folder_path);

    let client = reqwest::Client::new();
    let mut downloaded_covers = false;
    let mut downloaded_backgrounds = false;

    for img in &images {
        let url = format!("https://image.tmdb.org/t/p/{}{}", img.size, img.file_path);
        // Derive filename: tmdb_{size}_{original_name}
        let original_name = img.file_path.trim_start_matches('/');
        let save_name = format!("tmdb_{}_{}", img.size, original_name);

        let (subdir, is_cover) = match img.image_type.as_str() {
            "cover" => ("covers", true),
            "background" => ("backgrounds", false),
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
            downloaded_backgrounds = true;
        }
    }

    // Sync cached images for updated directories
    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    let library_base = PathBuf::from(root);

    if downloaded_covers {
        sync_cached_images_for_entry(
            &state.app_db, &library_id, &cache_base, &library_base, &folder_path, "covers", "cover",
        )
        .await?;
    }
    if downloaded_backgrounds {
        sync_cached_images_for_entry(
            &state.app_db, &library_id, &cache_base, &library_base, &folder_path, "backgrounds", "background",
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
    let lib_paths = get_library_paths(&state.app_db, &library_id).await?;

    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry_full WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path,) = entry_row.ok_or("Entry not found")?;

    let root = resolve_entry_root(&lib_paths, &folder_path)
        .ok_or("Could not resolve entry folder on disk")?;
    let library_base = PathBuf::from(root);
    let target_dir = library_base.join(&folder_path).join("covers");
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("Failed to create covers dir: {e}"))?;

    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err("Source file does not exist".into());
    }
    if !is_image_file(&src) {
        return Err("File is not a supported image".into());
    }

    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "cover".into());
    let ext = src.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "jpg".into());
    let mut target_name = format!("{stem}.{ext}");
    let mut target_path = target_dir.join(&target_name);
    let mut counter = 1;
    while target_path.exists() {
        target_name = format!("{stem}_{counter}.{ext}");
        target_path = target_dir.join(&target_name);
        counter += 1;
    }

    std::fs::copy(&src, &target_path).map_err(|e| format!("Failed to copy cover: {e}"))?;

    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    sync_cached_images_for_entry(
        &state.app_db, &library_id, &cache_base, &library_base, &folder_path, "covers", "cover",
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
    let lib_paths = _paths;

    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry_full WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path,) = entry_row.ok_or("Entry not found")?;

    let source_row: Option<(String,)> = sqlx::query_as(
        "SELECT source_filename FROM cached_images WHERE library_id = ? AND entry_folder_path = ? AND image_type = 'cover' AND cached_path = ?",
    )
    .bind(&library_id)
    .bind(&folder_path)
    .bind(&cover_path)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (source_filename,) = source_row.ok_or("Cover not found in cache")?;

    let root = resolve_entry_root(&lib_paths, &folder_path)
        .ok_or("Could not resolve entry folder on disk")?;
    let library_base = PathBuf::from(root);
    let source_file = library_base.join(&folder_path).join("covers").join(&source_filename);

    if source_file.exists() {
        std::fs::remove_file(&source_file)
            .map_err(|e| format!("Failed to delete cover file: {e}"))?;
    }

    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    sync_cached_images_for_entry(
        &state.app_db, &library_id, &cache_base, &library_base, &folder_path, "covers", "cover",
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
    pub file_path: String,
    pub sort_order: i64,
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
        "SELECT id, title, season_number, sort_order FROM season WHERE show_id = ? ORDER BY sort_order",
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
    let rows: Vec<(i64, String, Option<i64>, String, i64)> = sqlx::query_as(
        "SELECT id, title, episode_number, file_path, sort_order FROM episode WHERE season_id = ? ORDER BY sort_order",
    )
    .bind(season_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;


    Ok(rows
        .into_iter()
        .map(|(id, title, episode_number, file_path, sort_order)| EpisodeInfo {
            id,
            title,
            episode_number,
            file_path,
            sort_order,
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
         ORDER BY s.sort_order, s.season_number, e.sort_order, e.episode_number",
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
fn role_works_cte(role: &str) -> Result<&'static str, String> {
    match role {
        "actor" => Ok(
            "WITH role_works AS ( \
               SELECT person_id, 'movie' AS kind, movie_id AS eid FROM movie_cast \
               UNION SELECT person_id, 'show', show_id FROM show_cast \
               UNION SELECT sec.person_id, 'show', ss.show_id \
                       FROM season_cast sec JOIN season ss ON sec.season_id = ss.id \
               UNION SELECT ec.person_id, 'show', ss.show_id \
                       FROM episode_cast ec \
                       JOIN episode e ON ec.episode_id = e.id \
                       JOIN season ss ON e.season_id = ss.id \
             )"
        ),
        "director_creator" => Ok(
            "WITH role_works AS ( \
               SELECT person_id, 'movie' AS kind, movie_id AS eid FROM movie_director \
               UNION SELECT person_id, 'show', show_id FROM show_creator \
               UNION SELECT ed.person_id, 'show', ss.show_id \
                       FROM episode_director ed \
                       JOIN episode e ON ed.episode_id = e.id \
                       JOIN season ss ON e.season_id = ss.id \
             )"
        ),
        "composer" => Ok(
            "WITH role_works AS ( \
               SELECT person_id, 'movie' AS kind, movie_id AS eid FROM movie_composer \
               UNION SELECT person_id, 'show', show_id FROM show_composer \
             )"
        ),
        // Union of every role — used by the top-level "People" sidebar node and for
        // person-detail pages reached from there (shows all works, regardless of role).
        "all" => Ok(
            "WITH role_works AS ( \
               SELECT person_id, 'movie' AS kind, movie_id AS eid FROM movie_cast \
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
             )"
        ),
        other => Err(format!("Invalid role: {}", other)),
    }
}

/// Build the person-specific involvement label for a single (person, entry) pair.
///
/// Returns `Some(label)` describing what *this person* did in *this work* — e.g.
/// `as Walter White`, `acted in`, `directed`, `created`, or anthology-specific variants
/// like `as Lacie in "Nosedive"` or `acted in 3 episodes`. Returns `None` when no credit
/// rows exist for the pair under the requested role (rare — `get_entries_for_person`
/// only returns entries the person has credits on).
///
/// Role priority for `"all"`: cast → director/creator → composer. First match wins, so
/// a person who acted *and* directed a work gets the cast label.
///
/// Spoiler guardrail: episode titles and counts only surface for shows where
/// `show.is_anthology = 1`. Regular shows always fall back to generic `acted in` /
/// `directed` so character arcs and deaths aren't revealed via the person page.
async fn compute_person_entry_label(
    pool: &SqlitePool,
    person_id: i64,
    entry_id: i64,
    entry_type: &str,
    role: &str,
) -> Result<Option<String>, String> {
    let roles_to_try: Vec<&str> = match role {
        "all" => vec!["actor", "director_creator", "composer"],
        other => vec![other],
    };
    for r in roles_to_try {
        if let Some(label) = try_compute_label_for_role(pool, person_id, entry_id, entry_type, r).await? {
            return Ok(Some(label));
        }
    }
    Ok(None)
}

/// Computes the label for a specific role (single role, no fallback). Called by
/// [compute_person_entry_label] once per candidate role.
async fn try_compute_label_for_role(
    pool: &SqlitePool,
    person_id: i64,
    entry_id: i64,
    entry_type: &str,
    role: &str,
) -> Result<Option<String>, String> {
    /// Produces `Some("as {character}")` when the role is a non-empty string, else None.
    /// The "acted in" fallback used to live here but was removed — the section header
    /// ("actor") already conveys what the person did, so a bare "acted in" is noise.
    fn cast_label(role: Option<String>) -> Option<String> {
        role.and_then(|s| {
            let t = s.trim();
            if t.is_empty() { None } else { Some(format!("as {}", t)) }
        })
    }

    match (entry_type, role) {
        ("movie", "actor") => {
            let row: Option<(Option<String>,)> = sqlx::query_as(
                "SELECT role FROM movie_cast WHERE movie_id = ? AND person_id = ? LIMIT 1",
            )
            .bind(entry_id)
            .bind(person_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            // Only emit a label when there's an actual character name. No row, or a row
            // with NULL/empty role → None (card's secondary line stays blank).
            Ok(row.and_then(|(r,)| cast_label(r)))
        }
        // Directors and composers — their section header says what they did, so the
        // card itself emits no label. Anthology variants that add an episode title or
        // count stay below for the director/creator case only (those carry additional
        // info beyond "directed").
        ("movie", "director_creator") | ("movie", "composer") => Ok(None),
        ("show", "actor") => {
            // Prefer the most authoritative cast row (show-level → season-level →
            // episode-level) for the character name. No bare "acted in" fallback
            // anywhere — just the character name when one exists.
            let sc: Option<(Option<String>,)> = sqlx::query_as(
                "SELECT role FROM show_cast WHERE show_id = ? AND person_id = ? LIMIT 1",
            )
            .bind(entry_id)
            .bind(person_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            if let Some((r,)) = sc {
                return Ok(cast_label(r));
            }
            let sec: Option<(Option<String>,)> = sqlx::query_as(
                "SELECT sec.role FROM season_cast sec JOIN season s ON s.id = sec.season_id \
                 WHERE s.show_id = ? AND sec.person_id = ? LIMIT 1",
            )
            .bind(entry_id)
            .bind(person_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            if let Some((r,)) = sec {
                return Ok(cast_label(r));
            }
            // episode_cast only. Non-anthology: surface just the character name; no
            // "acted in N episodes" fallback (spoiler guardrail is already handled by
            // NOT emitting counts/titles). Anthology: episode title allowed, also
            // gated on character name presence.
            let total: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM episode_cast ec \
                 JOIN episode e ON e.id = ec.episode_id \
                 JOIN season s ON s.id = e.season_id \
                 WHERE s.show_id = ? AND ec.person_id = ?",
            )
            .bind(entry_id)
            .bind(person_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
            if total.0 == 0 {
                return Ok(None);
            }
            let role_name: Option<String> = sqlx::query_as::<_, (Option<String>,)>(
                "SELECT ec.role FROM episode_cast ec \
                 JOIN episode e ON e.id = ec.episode_id \
                 JOIN season s ON s.id = e.season_id \
                 WHERE s.show_id = ? AND ec.person_id = ? AND ec.role IS NOT NULL AND ec.role != '' \
                 LIMIT 1",
            )
            .bind(entry_id)
            .bind(person_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|(r,)| r);
            let anthology_row: Option<(i64,)> = sqlx::query_as(
                "SELECT is_anthology FROM show WHERE id = ?",
            )
            .bind(entry_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            let is_anthology = anthology_row.map(|(v,)| v != 0).unwrap_or(false);

            // Not anthology → just the character name, or nothing.
            if !is_anthology {
                return Ok(role_name.map(|s| format!("as {}", s.trim())));
            }

            // Anthology single-episode: tack on the episode title when we have both
            // a character and a title. Missing character → None.
            if total.0 == 1 {
                let role = match role_name {
                    Some(s) => s,
                    None => return Ok(None),
                };
                let title: Option<String> = sqlx::query_as::<_, (String,)>(
                    "SELECT e.title FROM episode_cast ec \
                     JOIN episode e ON e.id = ec.episode_id \
                     JOIN season s ON s.id = e.season_id \
                     WHERE s.show_id = ? AND ec.person_id = ? LIMIT 1",
                )
                .bind(entry_id)
                .bind(person_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?
                .map(|(t,)| t);
                let label = match title {
                    Some(t) if !t.is_empty() => format!("as {} in \"{}\"", role.trim(), t),
                    _ => format!("as {}", role.trim()),
                };
                return Ok(Some(label));
            }
            // Anthology 2+ episodes: just the character name. Episode count isn't shown
            // when character is present (kept concise).
            Ok(role_name.map(|s| format!("as {}", s.trim())))
        }
        ("show", "director_creator") => {
            // show_creator → header-only; no "created" label.
            let sc: Option<(i64,)> = sqlx::query_as(
                "SELECT 1 FROM show_creator WHERE show_id = ? AND person_id = ? LIMIT 1",
            )
            .bind(entry_id)
            .bind(person_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            if sc.is_some() {
                return Ok(None);
            }
            // Episode-director case. Anthology variants (`directed "Title"` /
            // `directed N episodes`) still carry info beyond the section header, so
            // they stay. Non-anthology case has no character name to anchor on and
            // no extra info → None.
            let total: (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM episode_director ed \
                 JOIN episode e ON e.id = ed.episode_id \
                 JOIN season s ON s.id = e.season_id \
                 WHERE s.show_id = ? AND ed.person_id = ?",
            )
            .bind(entry_id)
            .bind(person_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
            let n = total.0;
            if n == 0 {
                return Ok(None);
            }
            let anthology_row: Option<(i64,)> = sqlx::query_as(
                "SELECT is_anthology FROM show WHERE id = ?",
            )
            .bind(entry_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
            let is_anthology = anthology_row.map(|(v,)| v != 0).unwrap_or(false);
            if !is_anthology {
                return Ok(None);
            }
            if n == 1 {
                let row: Option<(String,)> = sqlx::query_as(
                    "SELECT e.title FROM episode_director ed \
                     JOIN episode e ON e.id = ed.episode_id \
                     JOIN season s ON s.id = e.season_id \
                     WHERE s.show_id = ? AND ed.person_id = ? LIMIT 1",
                )
                .bind(entry_id)
                .bind(person_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
                if let Some((title,)) = row {
                    return Ok(Some(format!("directed \"{}\"", title)));
                }
            }
            Ok(Some(format!("directed {} episodes", n)))
        }
        // Composer sections never emit a card label — the section header handles it.
        ("show", "composer") => Ok(None),
        _ => Ok(None),
    }
}

async fn get_library_meta(
    app_db: &SqlitePool,
    library_id: &str,
) -> Result<(String, Vec<String>, String), String> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT format, paths, default_sort_mode FROM library WHERE id = ?",
    )
    .bind(library_id)
    .fetch_optional(app_db)
    .await
    .map_err(|e| e.to_string())?;
    let (format, paths_json, sort_mode) = row.ok_or("Library not found")?;
    let paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();
    Ok((format, paths, sort_mode))
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

    // Split the total count into movie and show counts so the card can render format-
    // specific labels like "2 movies & 4 shows". The role_works CTE uses UNION (not
    // UNION ALL), so each (person, kind, entry) row is already distinct — a person
    // credited at show-, season-, and episode-level on the same show still counts as 1.
    let query = format!(
        "{cte} \
         SELECT p.id, p.name, p.image_path, \
                SUM(CASE WHEN rw.kind = 'movie' THEN 1 ELSE 0 END) AS movie_count, \
                SUM(CASE WHEN rw.kind = 'show'  THEN 1 ELSE 0 END) AS show_count \
         FROM person p \
         JOIN role_works rw ON rw.person_id = p.id \
         GROUP BY p.id \
         ORDER BY p.name COLLATE NOCASE ASC"
    );

    let rows: Vec<(i64, String, Option<String>, i64, i64)> = sqlx::query_as(&query)
        .fetch_all(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, name, image_path, movie_count, show_count)| PersonSummary {
            id,
            name,
            image_path,
            movie_count,
            show_count,
        })
        .collect())
}

/// Person-detail page response: works grouped by role section. Each list contains the
/// works the person is credited on for that role; an entry can appear in more than one
/// section (e.g. a director who also acted in the same movie). Frontend hides empty
/// sections and re-sorts client-side per section.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersonEntriesResponse {
    pub actor: Vec<MediaEntry>,
    pub director: Vec<MediaEntry>,
    pub composer: Vec<MediaEntry>,
}

/// Internal helper — fetches the works a person has credits on for a single role and
/// labels each one with the role-specific involvement string ("as Walter White",
/// "directed", "composed", etc.). Returns entries with `year`/`end_year` nulled and
/// the label written into `season_display` so the existing card rendering works
/// unchanged.
async fn fetch_person_entries_for_role(
    pool: &SqlitePool,
    library_id: &str,
    person_id: i64,
    role: &str,
    covers_map: &mut HashMap<String, Vec<String>>,
) -> Result<Vec<MediaEntry>, String> {
    let cte = role_works_cte(role)?;
    // Year is included so the frontend can sort sections by release date. The card
    // suppresses year visually via a `hideYear` prop; sort uses it under the hood.
    let query = format!(
        "{cte} \
         SELECT mef.id, mef.title, \
           CASE WHEN mef.entry_type = 'movie' THEN SUBSTR(mef.release_date, 1, 4) ELSE NULL END AS year, \
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

    let rows: Vec<(i64, String, Option<String>, String, Option<i64>, String, Option<String>, Option<String>)> =
        sqlx::query_as(&query)
            .bind(library_id)
            .bind(person_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

    let mut entries: Vec<MediaEntry> = Vec::with_capacity(rows.len());
    for (id, title, year, folder_path, parent_id, entry_type, selected_cover, tmdb_id) in rows {
        // Cover lookup uses a clone since the same entry may also appear in another role
        // section (e.g. someone who acts AND directs the same movie) and would need its
        // covers there too.
        let covers = covers_map.get(&folder_path).cloned().unwrap_or_default();
        let label = compute_person_entry_label(pool, person_id, id, &entry_type, role).await?;
        // Shows: hydrate year/end_year so the section's date-sort can use the show's
        // run range. Movies: year already inline from the SELECT above.
        let (final_year, final_end_year) = if entry_type == "show" {
            let (y, ey, _sd) = enrich_show_fields(pool, id).await?;
            (y, ey)
        } else {
            (year, None)
        };
        entries.push(MediaEntry {
            id,
            title,
            year: final_year,
            end_year: final_end_year,
            folder_path,
            parent_id,
            entry_type,
            covers,
            selected_cover,
            child_count: 0,
            season_display: label,
            collection_display: None,
            tmdb_id,
            link_id: None,
        });
    }

    Ok(entries)
}

/// Mass-update a person's character name (cast role) for a given work. Movies hit the
/// single `movie_cast` row. Shows update across `show_cast`, all `season_cast` rows for
/// that person on that show, and all `episode_cast` rows for that person on that show
/// — the user can't see the layered structure, so we keep it consistent everywhere.
///
/// Empty `new_role` stores `NULL` (treated as "no character name" by the label code).
///
/// See [count_person_role_variants] — used by the frontend to warn when this update
/// would clobber multiple distinct existing values (voice actors playing several
/// characters across episodes).
#[tauri::command]
pub async fn update_person_cast_role(
    state: tauri::State<'_, AppState>,
    person_id: i64,
    entry_id: i64,
    entry_type: String,
    new_role: String,
) -> Result<(), String> {
    let trimmed = new_role.trim();
    let value: Option<&str> = if trimmed.is_empty() { None } else { Some(trimmed) };

    match entry_type.as_str() {
        "movie" => {
            sqlx::query("UPDATE movie_cast SET role = ? WHERE movie_id = ? AND person_id = ?")
                .bind(value)
                .bind(entry_id)
                .bind(person_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
        "show" => {
            sqlx::query("UPDATE show_cast SET role = ? WHERE show_id = ? AND person_id = ?")
                .bind(value)
                .bind(entry_id)
                .bind(person_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query(
                "UPDATE season_cast SET role = ? \
                 WHERE person_id = ? AND season_id IN (SELECT id FROM season WHERE show_id = ?)",
            )
            .bind(value)
            .bind(person_id)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query(
                "UPDATE episode_cast SET role = ? \
                 WHERE person_id = ? AND episode_id IN ( \
                   SELECT e.id FROM episode e JOIN season s ON s.id = e.season_id \
                   WHERE s.show_id = ?)",
            )
            .bind(value)
            .bind(person_id)
            .bind(entry_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("Unsupported entry_type for character edit: {}", other)),
    }

    Ok(())
}

/// Count of *distinct non-null* role values currently stored across a person's cast rows
/// for a given work. Used by the character-edit dialog to warn when saving will replace
/// multiple existing names with one — typically a voice actor or anthology guest playing
/// different characters across episodes.
#[tauri::command]
pub async fn count_person_role_variants(
    state: tauri::State<'_, AppState>,
    person_id: i64,
    entry_id: i64,
    entry_type: String,
) -> Result<i64, String> {
    match entry_type.as_str() {
        "movie" => {
            let row: (i64,) = sqlx::query_as(
                "SELECT COUNT(DISTINCT role) FROM movie_cast \
                 WHERE movie_id = ? AND person_id = ? AND role IS NOT NULL AND role != ''",
            )
            .bind(entry_id)
            .bind(person_id)
            .fetch_one(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
            Ok(row.0)
        }
        "show" => {
            let row: (i64,) = sqlx::query_as(
                "SELECT COUNT(DISTINCT role) FROM ( \
                   SELECT role FROM show_cast WHERE show_id = ? AND person_id = ? AND role IS NOT NULL AND role != '' \
                   UNION ALL \
                   SELECT sec.role FROM season_cast sec JOIN season s ON s.id = sec.season_id \
                     WHERE s.show_id = ? AND sec.person_id = ? AND sec.role IS NOT NULL AND sec.role != '' \
                   UNION ALL \
                   SELECT ec.role FROM episode_cast ec \
                     JOIN episode e ON e.id = ec.episode_id \
                     JOIN season s ON s.id = e.season_id \
                     WHERE s.show_id = ? AND ec.person_id = ? AND ec.role IS NOT NULL AND ec.role != '' \
                 )",
            )
            .bind(entry_id)
            .bind(person_id)
            .bind(entry_id)
            .bind(person_id)
            .bind(entry_id)
            .bind(person_id)
            .fetch_one(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
            Ok(row.0)
        }
        other => Err(format!("Unsupported entry_type for role variant count: {}", other)),
    }
}

#[tauri::command]
pub async fn get_entries_for_person(
    state: tauri::State<'_, AppState>,
    library_id: String,
    person_id: i64,
) -> Result<PersonEntriesResponse, String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;
    if format != "video" {
        return Err("People browsing is only supported for video libraries".to_string());
    }

    let mut covers_map = get_all_cached_covers(&state.app_db, &library_id)
        .await
        .map_err(|e| e.to_string())?;

    let actor = fetch_person_entries_for_role(&state.app_db, &library_id, person_id, "actor", &mut covers_map).await?;
    let director = fetch_person_entries_for_role(&state.app_db, &library_id, person_id, "director_creator", &mut covers_map).await?;
    let composer = fetch_person_entries_for_role(&state.app_db, &library_id, person_id, "composer", &mut covers_map).await?;

    Ok(PersonEntriesResponse { actor, director, composer })
}

// ---------- Person identity / bio / TMDB matching ----------

/// Read a single person record. Used by the person-detail page header + bio panel and
/// as a refresh after match/refresh/clear actions.
#[tauri::command]
pub async fn get_person_detail(
    state: tauri::State<'_, AppState>,
    person_id: i64,
) -> Result<PersonDetail, String> {
    let row: Option<(i64, String, Option<String>, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT id, name, image_path, tmdb_id, bio FROM person WHERE id = ?",
    )
    .bind(person_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let (id, name, image_path, tmdb_id, bio) = row.ok_or("Person not found")?;
    Ok(PersonDetail { id, name, image_path, tmdb_id, bio })
}

/// Local search used by the picker's "In library" section. Case-insensitive substring
/// match on `person.name`, capped to 15 rows.
#[tauri::command]
pub async fn search_persons_local(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<LocalPersonSearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", q);
    let rows: Vec<(i64, String, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT id, name, image_path, tmdb_id FROM person \
         WHERE name LIKE ? COLLATE NOCASE \
         ORDER BY name COLLATE NOCASE \
         LIMIT 15",
    )
    .bind(&pattern)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, name, image_path, tmdb_id)| LocalPersonSearchResult {
            id,
            name,
            image_path,
            tmdb_id,
        })
        .collect())
}

/// TMDB person search for the picker's "From TMDB" section.
#[tauri::command]
pub async fn search_tmdb_person(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<TmdbPersonSearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;
    let client = reqwest::Client::new();
    let response = crate::tmdb::search_person(&client, &token, q).await?;
    Ok(response
        .results
        .into_iter()
        .map(|hit| {
            let summary: Option<String> = {
                let titles: Vec<String> = hit
                    .known_for
                    .iter()
                    .take(3)
                    .filter_map(|k| k.title.clone().or_else(|| k.name.clone()))
                    .collect();
                if titles.is_empty() { None } else { Some(titles.join(", ")) }
            };
            TmdbPersonSearchResult {
                id: hit.id,
                name: hit.name,
                profile_path: hit.profile_path,
                known_for_department: hit.known_for_department,
                known_for_summary: summary,
            }
        })
        .collect())
}

/// Internal helper — fetches /person/{tmdb_id} and writes name/tmdb_id/bio to the
/// given person row. Kicks off a profile image download when the person has none.
/// Used by both apply_tmdb_person_match and refresh_tmdb_person.
async fn fetch_and_apply_tmdb_person(
    pool: &sqlx::SqlitePool,
    app_data_dir: &std::path::Path,
    person_id: i64,
    tmdb_id: i64,
    token: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let detail = crate::tmdb::get_person_detail(&client, token, tmdb_id).await?;
    let bio: Option<String> = detail
        .biography
        .as_ref()
        .and_then(|b| {
            let t = b.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        });
    sqlx::query("UPDATE person SET tmdb_id = ?, name = ?, bio = ? WHERE id = ?")
        .bind(tmdb_id)
        .bind(&detail.name)
        .bind(bio.as_deref())
        .bind(person_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    // Reuse the shared image-download path — it skips the work when the person
    // already has an image, and handles missing profile_path gracefully.
    process_person_images(pool, app_data_dir, vec![(person_id, tmdb_id, detail.profile_path)]).await;
    Ok(())
}

/// Attach a TMDB record to an existing person. Writes tmdb_id, updates name to the
/// canonical TMDB spelling, pulls biography, and downloads the profile image if the
/// person has none locally.
#[tauri::command]
pub async fn apply_tmdb_person_match(
    state: tauri::State<'_, AppState>,
    person_id: i64,
    tmdb_id: i64,
) -> Result<(), String> {
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;
    fetch_and_apply_tmdb_person(&state.app_db, &state.app_data_dir, person_id, tmdb_id, &token).await
}

/// Re-pull TMDB data for a person that's already matched. Errors if the person has no
/// tmdb_id (caller shouldn't expose the action in that state).
#[tauri::command]
pub async fn refresh_tmdb_person(
    state: tauri::State<'_, AppState>,
    person_id: i64,
) -> Result<(), String> {
    let existing: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT tmdb_id FROM person WHERE id = ?",
    )
    .bind(person_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let tmdb_id = existing
        .and_then(|(t,)| t)
        .ok_or_else(|| "Person is not matched to TMDB.".to_string())?;
    let token: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No TMDB API token configured. Add one in settings.".to_string())?;
    fetch_and_apply_tmdb_person(&state.app_db, &state.app_data_dir, person_id, tmdb_id, &token).await
}

/// Nulls the person's tmdb_id and bio. Keeps image_path + person_image rows (the
/// previously-fetched portrait still belongs to this person; removing it is a
/// separate UX we haven't surfaced).
#[tauri::command]
pub async fn clear_tmdb_person_match(
    state: tauri::State<'_, AppState>,
    person_id: i64,
) -> Result<(), String> {
    sqlx::query("UPDATE person SET tmdb_id = NULL, bio = NULL WHERE id = ?")
        .bind(person_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistSummary {
    pub id: i64,
    pub title: String,
    pub selected_cover: Option<String>,
    pub covers: Vec<String>,
}

#[tauri::command]
pub async fn get_playlists(
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<Vec<PlaylistSummary>, String> {
    let rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id, title, selected_cover FROM media_playlist WHERE library_id = ? ORDER BY sort_order ASC, title COLLATE NOCASE ASC",
    )
    .bind(&library_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let playlists = rows
        .into_iter()
        .map(|(id, title, selected_cover)| {
            let dir = playlist_covers_dir(&state.app_data_dir, "playlist", id);
            let covers = list_playlist_covers(&dir);
            PlaylistSummary { id, title, selected_cover, covers }
        })
        .collect();
    Ok(playlists)
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
    // Columns mirror `media_entry_full` so we can hydrate a MediaEntry for each target.
    // The `?` placeholders are bound twice each (the OR/IS-NULL pattern handles "playlist root" vs "nested collection").
    let link_rows: Vec<(
        i64, // link_id
        i64, // sort_order
        i64, // target id
        String, Option<String>, Option<String>, String, Option<i64>, String, Option<String>, Option<String>,
    )> = sqlx::query_as(
        // COALESCE(link.selected_cover, target.selected_cover) — the link's own override wins;
        // when it's NULL (never set, or null-out'd by a library-side cover delete) we fall back
        // to whatever the target entry currently shows.
        "SELECT ml.id, ml.sort_order, \
                mef.id, mef.title, \
                CASE WHEN mef.entry_type = 'movie' THEN SUBSTR(mef.release_date, 1, 4) ELSE NULL END as year, \
                NULL as end_year, \
                mef.folder_path, mef.parent_id, mef.entry_type, \
                COALESCE(ml.selected_cover, mef.selected_cover) as selected_cover, \
                mef.sort_title \
         FROM media_link ml \
         JOIN media_entry_full mef ON mef.id = ml.target_entry_id \
         WHERE (ml.parent_playlist_id IS ? AND ml.parent_collection_id IS ?)",
    )
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

    for (link_id, sort_order, id, title, year, end_year, folder_path, parent_id, entry_type, selected_cover, sort_title) in link_rows {
        let covers = covers_map.get(&folder_path).cloned().unwrap_or_default();
        // Compute year range + season_display for show targets so playlist cards look the
        // same as library cards. The library grid computes these in one big CASE expression
        // in its query; here we do a small follow-up per show since the link_rows select
        // is already complex and only a subset of entries need it.
        let (final_year, final_end_year, season_display) = if entry_type == "show" {
            enrich_show_fields(&state.app_db, id).await?
        } else {
            (year, end_year, None)
        };
        let entry = MediaEntry {
            id,
            title,
            year: final_year,
            end_year: final_end_year,
            folder_path,
            parent_id,
            entry_type,
            covers,
            selected_cover,
            child_count: 0,
            season_display,
            collection_display: None,
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

        let cover_dir = playlist_covers_dir(&state.app_data_dir, "collection", id);
        let collection_covers = list_playlist_covers(&cover_dir);
        let entry = MediaEntry {
            id,
            title,
            year: None,
            end_year: None,
            folder_path: String::new(),
            parent_id: None,
            entry_type: "playlist_collection".to_string(),
            covers: collection_covers,
            selected_cover,
            child_count: child_count.0,
            season_display: None,
            collection_display: None,
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

/// Compute year range + season_display for a show, matching what the library grid
/// produces inline in its big CASE expression. Returns (year, end_year, season_display).
/// Returns (None, None, None) when the show has no episodes / seasons.
async fn enrich_show_fields(
    pool: &sqlx::SqlitePool,
    show_id: i64,
) -> Result<(Option<String>, Option<String>, Option<String>), String> {
    let year_row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT MIN(SUBSTR(e.release_date, 1, 4)), MAX(SUBSTR(e.release_date, 1, 4)) \
         FROM episode e JOIN season s ON e.season_id = s.id \
         WHERE s.show_id = ? AND e.release_date IS NOT NULL",
    )
    .bind(show_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (year, end_year) = match year_row {
        Some((lo, hi)) => {
            // Mirror the library query's NULLIF(max, min) — single-year shows get None for end_year.
            let end_year = if hi == lo { None } else { hi };
            (lo, end_year)
        }
        None => (None, None),
    };

    let season_row: Option<(i64, Option<i64>, Option<i64>, i64)> = sqlx::query_as(
        "SELECT COUNT(*), MIN(season_number), MAX(season_number), \
                COUNT(season_number) \
         FROM season WHERE show_id = ?",
    )
    .bind(show_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let season_display = season_row.and_then(|(total, min_n, max_n, numbered)| {
        match total {
            0 => None,
            1 => match min_n {
                Some(n) => Some(format!("season {n}")),
                None => Some("1 season".to_string()),
            },
            _ => {
                // Contiguous numbered-range check mirrors the library query.
                if numbered == total && min_n.is_some() && max_n.is_some()
                    && (max_n.unwrap() - min_n.unwrap() + 1) == total
                {
                    Some(format!("seasons {}\u{2013}{}", min_n.unwrap(), max_n.unwrap()))
                } else {
                    Some(format!("{total} seasons"))
                }
            }
        }
    });

    Ok((year, end_year, season_display))
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
    let lib_paths: Vec<String> = _paths;
    let managed: i32 = sqlx::query_scalar("SELECT managed FROM library WHERE id = ?")
        .bind(&library_id)
        .fetch_one(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    // If managed library, rename the actual folder on disk and update paths
    if managed != 0 {
        let cache_base = state.app_data_dir.join("cache").join(&library_id);

        match format.as_str() {
            "video" => {
                // Query from view for folder_path, release_date (year extracted), entry_type
                let entry_row: Option<(String, Option<String>, String)> = sqlx::query_as(
                    "SELECT folder_path, SUBSTR(release_date, 1, 4), entry_type FROM media_entry_full WHERE id = ?",
                )
                .bind(entry_id)
                .fetch_optional(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;

                let (folder_path, year, entry_type) = entry_row.ok_or("Entry not found")?;
                let lib_base = PathBuf::from(resolve_entry_root(&lib_paths, &folder_path).ok_or("Could not find entry on disk")?);
                let old_full_path = lib_base.join(&folder_path);

                let safe_title = sanitize_filename(&new_title);
                let new_folder_name = if entry_type == "movie" {
                    match &year {
                        Some(y) => format!("{} ({})", safe_title, y),
                        None => safe_title,
                    }
                } else {
                    safe_title
                };

                let old_parent = old_full_path.parent().ok_or("Invalid folder path")?;
                let new_full_path = old_parent.join(&new_folder_name);

                if old_full_path != new_full_path {
                    if new_full_path.exists() {
                        return Err(format!("A folder named '{}' already exists", new_folder_name));
                    }

                    rename_path(&old_full_path, &new_full_path)
                        .map_err(|e| format!("Failed to rename folder: {}", e))?;

                    let new_rel_path = new_full_path
                        .strip_prefix(&lib_base)
                        .unwrap_or(&new_full_path)
                        .to_string_lossy()
                        .to_string();

                    let old_rel_prefix = format!("{}\\", folder_path);
                    let new_rel_prefix = format!("{}\\", new_rel_path);

                    // Update this entry's folder_path on the correct detail table
                    match entry_type.as_str() {
                        "movie" => sqlx::query("UPDATE movie SET folder_path = ? WHERE id = ?").bind(&new_rel_path).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?,
                        "show" => sqlx::query("UPDATE show SET folder_path = ? WHERE id = ?").bind(&new_rel_path).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?,
                        _ => sqlx::query("UPDATE media_collection SET folder_path = ? WHERE id = ?").bind(&new_rel_path).bind(entry_id).execute(&state.app_db).await.map_err(|e| e.to_string())?,
                    };

                    // Update child folder_paths across all detail tables
                    for tbl in &["movie", "show", "media_collection"] {
                        sqlx::query(
                            &format!("UPDATE {} SET folder_path = ? || SUBSTR(folder_path, ?) WHERE folder_path LIKE ? AND id != ?", tbl),
                        )
                        .bind(&new_rel_prefix)
                        .bind((old_rel_prefix.len() + 1) as i32)
                        .bind(format!("{}%", old_rel_prefix))
                        .bind(entry_id)
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                    }

                    // Update season folder_paths if this is a show
                    if entry_type == "show" {
                        sqlx::query(
                            "UPDATE season SET folder_path = ? || SUBSTR(folder_path, ?) WHERE show_id = ?",
                        )
                        .bind(&new_rel_prefix)
                        .bind((old_rel_prefix.len() + 1) as i32)
                        .bind(entry_id)
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;

                        sqlx::query(
                            "UPDATE episode SET file_path = ? || SUBSTR(file_path, ?) WHERE season_id IN (SELECT id FROM season WHERE show_id = ?)",
                        )
                        .bind(&new_rel_prefix)
                        .bind((old_rel_prefix.len() + 1) as i32)
                        .bind(entry_id)
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                    }

                    // Update cached_images — cache folder lives in our app_data so it's
                    // always local, standard rename suffices (no Shell fallback needed).
                    let old_cache = cache_base.join(&folder_path);
                    let new_cache = cache_base.join(&new_rel_path);
                    if old_cache.exists() {
                        let _ = std::fs::rename(&old_cache, &new_cache);
                    }
                    let old_cache_abs = old_cache.to_string_lossy().to_string().replace('/', "\\");
                    let new_cache_abs = new_cache.to_string_lossy().to_string().replace('/', "\\");
                    let old_cache_abs_prefix = format!("{}\\", old_cache_abs);
                    let new_cache_abs_prefix = format!("{}\\", new_cache_abs);
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                        .bind(&new_rel_path)
                        .bind(&old_cache_abs)
                        .bind(&new_cache_abs)
                        .bind(&folder_path)
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                    let old_rel_prefix_ci = format!("{}\\", folder_path);
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ? || SUBSTR(entry_folder_path, ?), cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path LIKE ?")
                        .bind(&format!("{}\\", new_rel_path))
                        .bind((old_rel_prefix_ci.len() + 1) as i32)
                        .bind(&old_cache_abs_prefix)
                        .bind(&new_cache_abs_prefix)
                        .bind(format!("{}%", old_rel_prefix_ci))
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            "music" => {
                let entry_row: Option<(String,)> = sqlx::query_as(
                    "SELECT folder_path FROM artist WHERE id = ?",
                )
                .bind(entry_id)
                .fetch_optional(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;

                let (folder_path,) = entry_row.ok_or("Entry not found")?;
                let lib_base = PathBuf::from(resolve_entry_root(&lib_paths, &folder_path).ok_or("Could not find entry on disk")?);
                let old_full_path = lib_base.join(&folder_path);

                let safe_title = sanitize_filename(&new_title);

                let new_full_path = old_full_path.parent().ok_or("Invalid folder path")?.join(&safe_title);

                if old_full_path != new_full_path {
                    if new_full_path.exists() {
                        return Err(format!("A folder named '{}' already exists", safe_title));
                    }

                    rename_path(&old_full_path, &new_full_path)
                        .map_err(|e| format!("Failed to rename folder: {}", e))?;

                    let new_rel_path = new_full_path
                        .strip_prefix(&lib_base)
                        .unwrap_or(&new_full_path)
                        .to_string_lossy()
                        .to_string();

                    let old_rel_prefix = format!("{}\\", folder_path);
                    let new_rel_prefix = format!("{}\\", new_rel_path);

                    // Update artist folder_path
                    sqlx::query("UPDATE artist SET folder_path = ? WHERE id = ?")
                        .bind(&new_rel_path)
                        .bind(entry_id)
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;

                    // Update album folder_paths
                    sqlx::query(
                        "UPDATE album SET folder_path = ? || SUBSTR(folder_path, ?) WHERE artist_id = ?",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(entry_id)
                    .execute(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;

                    // Update song file_paths
                    sqlx::query(
                        "UPDATE song SET file_path = ? || SUBSTR(file_path, ?) WHERE album_id IN (SELECT id FROM album WHERE artist_id = ?)",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(entry_id)
                    .execute(&state.app_db)
                    .await
                    .map_err(|e| e.to_string())?;

                    // Update cached_images
                    let old_cache = cache_base.join(&folder_path);
                    let new_cache = cache_base.join(&new_rel_path);
                    if old_cache.exists() {
                        let _ = std::fs::rename(&old_cache, &new_cache);
                    }
                    let old_cache_abs = old_cache.to_string_lossy().to_string().replace('/', "\\");
                    let new_cache_abs = new_cache.to_string_lossy().to_string().replace('/', "\\");
                    let old_cache_abs_prefix = format!("{}\\", old_cache_abs);
                    let new_cache_abs_prefix = format!("{}\\", new_cache_abs);
                    // Update this entry + child album entries
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                        .bind(&new_rel_path)
                        .bind(&old_cache_abs)
                        .bind(&new_cache_abs)
                        .bind(&folder_path)
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                    let old_rel_prefix_ci = format!("{}\\", folder_path);
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ? || SUBSTR(entry_folder_path, ?), cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path LIKE ?")
                        .bind(&format!("{}\\", new_rel_path))
                        .bind((old_rel_prefix_ci.len() + 1) as i32)
                        .bind(&old_cache_abs_prefix)
                        .bind(&new_cache_abs_prefix)
                        .bind(format!("{}%", old_rel_prefix_ci))
                        .execute(&state.app_db)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            _ => {
                return Err(format!("Unsupported library format: {}", format));
            }
        }
    }

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

/// Recursively copy a directory and all its contents.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(&entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

/// Move a directory: try rename first (instant, same-drive only), fall back to copy + delete.
/// Uses `rename_path` so SMB oplock descendants don't kill same-drive rename on Windows.
fn move_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }
    match rename_path(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_dir_recursive(src, dst)
                .map_err(|e| format!("Failed to copy folder: {}", e))?;
            std::fs::remove_dir_all(src)
                .map_err(|e| format!("Copied but failed to remove original: {}", e))?;
            Ok(())
        }
    }
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
    let lib_paths: Vec<String> = _paths;
    let managed: i32 = sqlx::query_scalar("SELECT managed FROM library WHERE id = ?")
        .bind(&library_id)
        .fetch_one(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    match format.as_str() {
        "video" => {
            // Get the entry being moved
            let entry_row: (String, Option<i64>) = sqlx::query_as(
                "SELECT folder_path, parent_id FROM media_entry_full WHERE id = ?",
            )
            .bind(entry_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Entry not found")?;

            let (old_folder_path, old_parent_id) = entry_row;

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

            // Determine the new folder_path
            let folder_name = PathBuf::from(&old_folder_path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let new_folder_path = if let Some(target_id) = new_parent_id {
                let (parent_folder,): (String,) = sqlx::query_as(
                    "SELECT folder_path FROM media_entry_full WHERE id = ?",
                )
                .bind(target_id)
                .fetch_optional(&state.app_db)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("Target collection not found")?;
                format!("{}\\{}", parent_folder, folder_name)
            } else {
                // Moving to root level — folder_name only
                folder_name.clone()
            };

            // --- Phase 1: Disk moves (reversible) ---
            let mut source_moved = false;
            let mut cache_moved = false;
            let mut old_full_path = PathBuf::new();
            let mut new_full_path = PathBuf::new();
            let cache_base = state.app_data_dir.join("cache").join(&library_id);
            let old_cache = cache_base.join(&old_folder_path);
            let new_cache = cache_base.join(&new_folder_path);

            // Move source folder on disk if managed
            if managed != 0 {
                let lib_base = PathBuf::from(
                    resolve_entry_root(&lib_paths, &old_folder_path)
                        .ok_or("Could not find entry on disk")?,
                );
                old_full_path = lib_base.join(&old_folder_path);
                new_full_path = lib_base.join(&new_folder_path);

                if old_full_path != new_full_path {
                    if new_full_path.exists() {
                        return Err(format!(
                            "A folder named '{}' already exists at the destination",
                            folder_name
                        ));
                    }
                    move_dir(&old_full_path, &new_full_path)?;
                    source_moved = true;
                }
            }

            // Move cache directory on disk
            if old_cache.exists() {
                if move_dir(&old_cache, &new_cache).is_ok() {
                    cache_moved = true;
                }
            }

            // --- Phase 2: DB updates in a transaction ---
            // Use full absolute cache prefixes for REPLACE to avoid matching
            // folder names that appear elsewhere in the absolute path
            let old_cache_abs = old_cache.to_string_lossy().to_string().replace('/', "\\");
            let new_cache_abs = new_cache.to_string_lossy().to_string().replace('/', "\\");
            let old_cache_abs_prefix = format!("{}\\", old_cache_abs);
            let new_cache_abs_prefix = format!("{}\\", new_cache_abs);

            let db_result: Result<(), String> = async {
                let mut tx = state.app_db.begin().await.map_err(|e| e.to_string())?;

                let old_rel_prefix = format!("{}\\", old_folder_path);
                let new_rel_prefix = format!("{}\\", new_folder_path);

                // This entry's cached_images
                sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                    .bind(&new_folder_path)
                    .bind(&old_cache_abs)
                    .bind(&new_cache_abs)
                    .bind(&old_folder_path)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                // Child entries' cached_images
                sqlx::query("UPDATE cached_images SET entry_folder_path = ? || SUBSTR(entry_folder_path, ?), cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path LIKE ?")
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(&old_cache_abs_prefix)
                    .bind(&new_cache_abs_prefix)
                    .bind(format!("{}%", old_rel_prefix))
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                // Update selected_cover for this entry across all detail tables
                for tbl in &["movie", "show", "media_collection"] {
                    sqlx::query(&format!("UPDATE {} SET selected_cover = REPLACE(selected_cover, ?, ?) WHERE selected_cover LIKE ? AND id = ?", tbl))
                        .bind(&old_cache_abs)
                        .bind(&new_cache_abs)
                        .bind(format!("{}%", old_cache_abs))
                        .bind(entry_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }

                // Update selected_cover for child entries across all detail tables
                for tbl in &["movie", "show", "media_collection"] {
                    sqlx::query(&format!("UPDATE {} SET selected_cover = REPLACE(selected_cover, ?, ?) WHERE selected_cover LIKE ? AND id != ?", tbl))
                        .bind(&old_cache_abs_prefix)
                        .bind(&new_cache_abs_prefix)
                        .bind(format!("{}%", old_cache_abs_prefix))
                        .bind(entry_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }

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

                // Update folder_path and sort_order on the correct detail table
                for tbl in &["movie", "show", "media_collection"] {
                    sqlx::query(&format!("UPDATE {} SET folder_path = ?, sort_order = ? WHERE id = ?", tbl))
                        .bind(&new_folder_path)
                        .bind(new_sort_order)
                        .bind(entry_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }

                // Update child folder_paths across all detail tables
                for tbl in &["movie", "show", "media_collection"] {
                    sqlx::query(
                        &format!("UPDATE {} SET folder_path = ? || SUBSTR(folder_path, ?) WHERE folder_path LIKE ? AND id != ?", tbl),
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(format!("{}%", old_rel_prefix))
                    .bind(entry_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                }

                // Update season/episode paths if entry is a show
                let (entry_type_name,): (String,) = sqlx::query_as(
                    "SELECT met.name FROM media_entry me JOIN media_entry_type met ON me.entry_type_id = met.id WHERE me.id = ?",
                )
                .bind(entry_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("Entry not found")?;

                if entry_type_name == "show" {
                    sqlx::query(
                        "UPDATE season SET folder_path = ? || SUBSTR(folder_path, ?) WHERE show_id = ?",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(entry_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                    sqlx::query(
                        "UPDATE episode SET file_path = ? || SUBSTR(file_path, ?) WHERE season_id IN (SELECT id FROM season WHERE show_id = ?)",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(entry_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                }

                tx.commit().await.map_err(|e| e.to_string())?;
                Ok(())
            }
            .await;

            // --- Phase 3: Roll back disk moves if DB failed ---
            if let Err(e) = db_result {
                if source_moved {
                    let _ = move_dir(&new_full_path, &old_full_path);
                }
                if cache_moved {
                    let _ = move_dir(&new_cache, &old_cache);
                }
                return Err(e);
            }
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
    base_path: Option<String>,
) -> Result<(), String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;
    if format != "video" {
        return Err("Collections are only supported for video libraries".to_string());
    }
    let lib_paths: Vec<String> = _paths;
    let managed: i32 = sqlx::query_scalar("SELECT managed FROM library WHERE id = ?")
        .bind(&library_id)
        .fetch_one(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    let safe_name = sanitize_filename(&name);
    if safe_name.is_empty() {
        return Err("Invalid collection name".to_string());
    }

    // Determine the parent folder path on disk
    let parent_folder = if let Some(pid) = parent_id {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT folder_path FROM media_entry_full WHERE id = ?",
        )
        .bind(pid)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
        row.ok_or("Parent entry not found")?.0
    } else {
        String::new()
    };

    let rel_path = if parent_folder.is_empty() {
        safe_name.clone()
    } else {
        format!("{}\\{}", parent_folder, safe_name)
    };

    // For managed libraries, create the folder on disk
    if managed != 0 {
        let lib_base = PathBuf::from(
            base_path.as_deref().unwrap_or(&lib_paths[0])
        );
        let full_path = lib_base.join(&rel_path);
        if full_path.exists() {
            return Err(format!("A folder named '{}' already exists", safe_name));
        }
        std::fs::create_dir_all(&full_path)
            .map_err(|e| format!("Failed to create folder: {}", e))?;
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
    sqlx::query("INSERT INTO media_collection (id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?)")
        .bind(entry_id)
        .bind(&name)
        .bind(&rel_path)
        .bind(&sort_title)
        .bind(max_order.0 + 1)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
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

#[tauri::command]
pub async fn delete_entry(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    delete_from_disk: bool,
) -> Result<(), String> {
    let lib_paths = get_library_paths(&state.app_db, &library_id).await?;
    let managed: i32 = sqlx::query_scalar("SELECT managed FROM library WHERE id = ?")
        .bind(&library_id)
        .fetch_one(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    // Get the entry's folder_path from the view
    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry_full WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path,) = entry_row.ok_or("Entry not found")?;

    // Delete from disk if requested and library is managed
    if delete_from_disk && managed != 0 {
        if let Some(root) = resolve_entry_root(&lib_paths, &folder_path) {
            let full_path = PathBuf::from(root).join(&folder_path);
            if full_path.exists() {
                // Read recycle bin threshold setting
                let threshold_gb: i64 = sqlx::query_as::<_, (String,)>(
                    "SELECT value FROM settings WHERE key = 'recycle_bin_max_gb'",
                )
                .fetch_optional(&state.app_db)
                .await
                .map_err(|e| e.to_string())?
                .and_then(|(v,)| v.parse().ok())
                .unwrap_or(50); // default 50 GB

                let use_trash = if threshold_gb < 0 {
                    true // always recycle
                } else if threshold_gb == 0 {
                    false // always permanent
                } else {
                    let size_bytes = dir_size(&full_path);
                    let threshold_bytes = threshold_gb as u64 * 1_073_741_824;
                    size_bytes <= threshold_bytes
                };

                if use_trash {
                    trash::delete(&full_path)
                        .map_err(|e| format!("Failed to send to Recycle Bin: {}", e))?;
                } else {
                    std::fs::remove_dir_all(&full_path)
                        .map_err(|e| format!("Failed to delete folder: {}", e))?;
                }
            }
        }
    }

    // Clean up cached images on disk for this entry and descendants
    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    if cache_base.exists() {
        let cache_entry_dir = cache_base.join(&folder_path);
        if cache_entry_dir.exists() {
            let _ = std::fs::remove_dir_all(&cache_entry_dir);
        }
    }

    // Remove cached_images DB rows for this entry and descendants
    sqlx::query("DELETE FROM cached_images WHERE library_id = ? AND (entry_folder_path = ? OR entry_folder_path LIKE ?)")
        .bind(&library_id)
        .bind(&folder_path)
        .bind(format!("{}\\%", folder_path))
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    // Purge presets scoped to this entry or any descendant collection. We collect collection
    // descendants before the cascade removes them from media_entry.
    let descendant_collections: Vec<(i64,)> = sqlx::query_as(
        "WITH RECURSIVE descendants(id) AS ( \
           SELECT id FROM media_entry WHERE id = ? \
           UNION ALL \
           SELECT me.id FROM media_entry me JOIN descendants d ON me.parent_id = d.id \
         ) \
         SELECT id FROM descendants \
         WHERE id IN (SELECT id FROM media_collection)",
    )
    .bind(entry_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    for (cid,) in descendant_collections {
        let _ = sqlx::query("DELETE FROM sort_preset WHERE scope_key = ?")
            .bind(format!("lib-coll:{}", cid))
            .execute(&state.app_db)
            .await;
    }

    // Delete from DB (CASCADE handles children, movie, collection, show tables)
    sqlx::query("DELETE FROM media_entry WHERE id = ?")
        .bind(entry_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn check_entry_has_files(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
) -> Result<bool, String> {
    let lib_paths = get_library_paths(&state.app_db, &library_id).await?;

    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry_full WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path,) = entry_row.ok_or("Entry not found")?;

    if let Some(root) = resolve_entry_root(&lib_paths, &folder_path) {
        let full_path = PathBuf::from(root).join(&folder_path);
        if full_path.exists() {
            let has_files = std::fs::read_dir(&full_path)
                .map(|rd| rd.filter_map(|e| e.ok()).any(|e| {
                    e.file_type().map(|ft| ft.is_file()).unwrap_or(false)
                }))
                .unwrap_or(false);
            return Ok(has_files);
        }
    }

    Ok(false)
}

#[tauri::command]
pub async fn rescan_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    let (format, _paths, _default_sort_mode) = get_library_meta(&state.app_db, &library_id).await?;
    let lib_paths = _paths;

    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    std::fs::create_dir_all(&cache_base).map_err(|e| e.to_string())?;

    let base_paths: Vec<PathBuf> = lib_paths.iter().map(|p| PathBuf::from(p)).collect();
    match format.as_str() {
        "video" => rescan_video_library(&app, &state.app_db, &library_id, &base_paths, &cache_base).await?,
        "music" => rescan_music_library(&app, &state.app_db, &library_id, &base_paths, &cache_base).await?,
        _ => return Err(format!("Unsupported library format: {}", format)),
    }

    Ok(())
}

async fn rescan_video_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    library_id: &str,
    base_paths: &[PathBuf],
    cache_base: &Path,
) -> Result<(), String> {
    use std::collections::{HashSet, HashMap};

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
    let collection_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'collection'")
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;

    // Collect all disk paths from ALL bases
    let mut disk_paths: HashSet<String> = HashSet::new();
    let mut path_to_base: HashMap<String, PathBuf> = HashMap::new();
    for base_path in base_paths {
        let mut paths_for_base: HashSet<String> = HashSet::new();
        collect_disk_paths(base_path, base_path, &mut paths_for_base)
            .map_err(|e| e.to_string())?;
        for p in &paths_for_base {
            path_to_base.insert(p.clone(), base_path.clone());
        }
        disk_paths.extend(paths_for_base);
    }

    // Get all DB entries
    let db_rows: Vec<(i64, String, Option<i64>, i64)> = sqlx::query_as(
        "SELECT id, folder_path, parent_id, entry_type_id FROM media_entry_full WHERE library_id = ?",
    )
    .bind(library_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let db_paths: HashSet<String> = db_rows.iter().map(|(_, p, _, _)| p.clone()).collect();

    // Delete removed entries (deepest first to respect FK)
    let mut to_delete: Vec<(i64, String)> = db_rows
        .iter()
        .filter(|(_, p, _, _)| !disk_paths.contains(p))
        .map(|(id, p, _, _)| (*id, p.clone()))
        .collect();
    to_delete.sort_by(|a, b| {
        b.1.matches('\\').count().cmp(&a.1.matches('\\').count())
            .then_with(|| b.1.matches('/').count().cmp(&a.1.matches('/').count()))
    });

    for (id, rel_path) in &to_delete {
        delete_cached_images_for_entry(pool, library_id, cache_base, rel_path).await?;
        sqlx::query("DELETE FROM media_entry WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Add new paths (shallowest first so parents exist before children)
    let mut new_paths: Vec<String> = disk_paths
        .iter()
        .filter(|p| !db_paths.contains(*p))
        .cloned()
        .collect();
    new_paths.sort_by(|a, b| {
        let depth_a = a.matches('\\').count() + a.matches('/').count();
        let depth_b = b.matches('\\').count() + b.matches('/').count();
        depth_a.cmp(&depth_b).then_with(|| a.cmp(b))
    });

    for rel_path in &new_paths {
        let base_path = path_to_base.get(rel_path).unwrap();
        let full_path = base_path.join(rel_path);
        let folder_name = full_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let _ = app.emit("scan-progress", &folder_name);

        let (title, year) = parse_folder_name(&folder_name);
        let sort_title = generate_sort_title(&title, "en");

        // Find parent
        let parent_rel = full_path
            .parent()
            .and_then(|p| p.strip_prefix(base_path).ok())
            .map(|p| p.to_string_lossy().to_string());

        let parent_id: Option<i64> = if let Some(ref parent_path) = parent_rel {
            if parent_path.is_empty() {
                None
            } else {
                let row: Option<(i64,)> = sqlx::query_as(
                    "SELECT id FROM media_entry_full WHERE folder_path = ? AND library_id = ?",
                )
                .bind(parent_path)
                .bind(library_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
                row.map(|(id,)| id)
            }
        } else {
            None
        };

        // Classify: check if subdirs match season pattern → show, else collection/movie
        let subdirs: Vec<_> = std::fs::read_dir(&full_path)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| is_scannable_dir(e))
            .collect();

        let has_season = subdirs.iter().any(|e| {
            let (_, num) = parse_season_folder_name(&e.file_name().to_string_lossy());
            num.is_some()
        });

        let max_order: Option<(i32,)> = if let Some(pid) = parent_id {
            sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM media_entry_full WHERE parent_id = ? AND library_id = ?")
                .bind(pid)
                .bind(library_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?
        } else {
            sqlx::query_as(
                "SELECT COALESCE(MAX(sort_order), -1) FROM media_entry_full WHERE parent_id IS NULL AND library_id = ?",
            )
            .bind(library_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
        };
        let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

        if has_season && parent_id.is_none() {
            // TV show (only at root level)
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

            // Don't recurse into seasons here — they'll be handled in the season rescan below
        } else if !subdirs.is_empty() {
            // Collection
            let result = sqlx::query(
                "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
            )
            .bind(library_id)
            .bind(parent_id)
            .bind(collection_type_id.0)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

            let entry_id = result.last_insert_rowid();
            sqlx::query("INSERT INTO media_collection (id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?)")
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
        } else {
            let has_video = std::fs::read_dir(&full_path)
                .map(|rd| rd.filter_map(|e| e.ok()).any(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS)))
                .unwrap_or(false);

            if has_video {
                // Movie (leaf with video files)
                let result = sqlx::query(
                    "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
                )
                .bind(library_id)
                .bind(parent_id)
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
            } else {
                // Empty folder → collection
                let result = sqlx::query(
                    "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
                )
                .bind(library_id)
                .bind(parent_id)
                .bind(collection_type_id.0)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

                let entry_id = result.last_insert_rowid();
                sqlx::query("INSERT INTO media_collection (id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?)")
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
            }
        }
    }

    // Sync cached images for existing entries
    let existing_paths: Vec<String> = db_rows
        .iter()
        .filter(|(_, p, _, _)| disk_paths.contains(p))
        .map(|(_, p, _, _)| p.clone())
        .collect();
    for rel_path in &existing_paths {
        if let Some(base) = path_to_base.get(rel_path) {
            sync_entry_images(pool, library_id, cache_base, base, rel_path).await?;
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
        // Resolve which base this show belongs to
        let show_base = path_to_base.get(show_rel)
            .or_else(|| {
                // For existing entries not in path_to_base, find which base contains it
                base_paths.iter().find(|b| b.join(show_rel).exists())
            })
            .ok_or_else(|| format!("Cannot resolve base path for show: {}", show_rel))?;
        let show_path = show_base.join(show_rel);

        let disk_seasons: HashSet<String> = std::fs::read_dir(&show_path)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| is_scannable_dir(e))
            .map(|e| {
                e.path()
                    .strip_prefix(show_base)
                    .unwrap_or(&e.path())
                    .to_string_lossy()
                    .to_string()
            })
            .collect();

        let db_seasons: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, folder_path FROM season WHERE show_id = ?")
                .bind(show_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;

        // Delete removed seasons
        for (id, path) in &db_seasons {
            if !disk_seasons.contains(path) {
                sqlx::query("DELETE FROM season WHERE id = ?")
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }

        let existing_season_paths: HashSet<String> = db_seasons.iter().map(|(_, p)| p.clone()).collect();

        // Add new seasons
        for rel_path in &disk_seasons {
            if existing_season_paths.contains(rel_path) {
                continue;
            }
            let full_path = show_base.join(rel_path);
            let name = full_path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let (season_title, season_number) = parse_season_folder_name(&name);

            let max_order: Option<(i32,)> =
                sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM season WHERE show_id = ?")
                    .bind(show_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

            sqlx::query(
                "INSERT INTO season (show_id, title, season_number, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(show_id)
            .bind(&season_title)
            .bind(season_number)
            .bind(rel_path)
            .bind(sort_order)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }

        // Episodes for each season
        let all_seasons: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, folder_path FROM season WHERE show_id = ?")
                .bind(show_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;

        for (season_id, season_rel) in &all_seasons {
            let season_path = show_base.join(season_rel);

            let disk_episodes: HashSet<String> = std::fs::read_dir(&season_path)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .filter(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS))
                .map(|e| {
                    e.path()
                        .strip_prefix(show_base)
                        .unwrap_or(&e.path())
                        .to_string_lossy()
                        .to_string()
                })
                .collect();

            let db_episodes: Vec<(i64, String)> =
                sqlx::query_as("SELECT id, file_path FROM episode WHERE season_id = ?")
                    .bind(season_id)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| e.to_string())?;

            for (id, path) in &db_episodes {
                if !disk_episodes.contains(path) {
                    sqlx::query("DELETE FROM episode WHERE id = ?")
                        .bind(id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
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
                let (ep_title, ep_number) = parse_episode_filename(&file_name);

                let max_order: Option<(i32,)> =
                    sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM episode WHERE season_id = ?")
                        .bind(season_id)
                        .fetch_optional(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

                sqlx::query(
                    "INSERT INTO episode (season_id, title, episode_number, file_path, sort_order) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(season_id)
                .bind(&ep_title)
                .bind(ep_number)
                .bind(rel_path)
                .bind(sort_order)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

async fn rescan_music_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    library_id: &str,
    base_paths: &[PathBuf],
    cache_base: &Path,
) -> Result<(), String> {
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

    Ok(())
}

fn collect_disk_paths(
    base: &PathBuf,
    dir: &PathBuf,
    out: &mut std::collections::HashSet<String>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_dir() && name != "covers" && name != "backgrounds" && name != "extras" && !name.starts_with('.') {
            let rel = entry
                .path()
                .strip_prefix(base)
                .unwrap_or(&entry.path())
                .to_string_lossy()
                .to_string();
            out.insert(rel);
            collect_disk_paths(base, &entry.path(), out)?;
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
    image_type_dir: &str, // "covers" or "backgrounds"
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
    image_type: &str, // "cover" or "background"
    images: &[(String, String)], // (source_filename, cached_path)
) -> Result<(), sqlx::Error> {
    for (filename, cached_path) in images {
        sqlx::query(
            "INSERT OR REPLACE INTO cached_images (library_id, entry_folder_path, image_type, source_filename, cached_path) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(library_id)
        .bind(entry_folder_path)
        .bind(image_type)
        .bind(filename)
        .bind(cached_path)
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

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(meta) = p.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

fn delete_cache_for_library(app_data_dir: &Path, library_id: &str) {
    let cache_dir = app_data_dir.join("cache").join(library_id);
    if cache_dir.exists() {
        let _ = std::fs::remove_dir_all(&cache_dir);
    }
}

/// Cache both covers and backgrounds for an entry, inserting into DB
async fn cache_entry_images(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    cache_base: &Path,
    library_base: &Path,
    entry_rel_path: &str,
) -> Result<(), sqlx::Error> {
    let covers = cache_images_for_entry(cache_base, library_base, entry_rel_path, "covers");
    insert_cached_images(pool, library_id, entry_rel_path, "cover", &covers).await?;
    let backgrounds = cache_images_for_entry(cache_base, library_base, entry_rel_path, "backgrounds");
    insert_cached_images(pool, library_id, entry_rel_path, "background", &backgrounds).await?;
    Ok(())
}

/// Diff-aware sync for rescan: add new images, remove deleted ones, skip unchanged
async fn sync_cached_images_for_entry(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    cache_base: &Path,
    library_base: &Path,
    entry_rel_path: &str,
    image_type_dir: &str, // "covers" or "backgrounds"
    image_type_db: &str,  // "cover" or "background"
) -> Result<(), String> {
    let source_dir = library_base.join(entry_rel_path).join(image_type_dir);
    let cache_dir = cache_base.join(entry_rel_path).join(image_type_dir);

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
        "SELECT source_filename, cached_path FROM cached_images WHERE library_id = ? AND entry_folder_path = ? AND image_type = ?",
    )
    .bind(library_id)
    .bind(entry_rel_path)
    .bind(image_type_db)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let db_files: std::collections::HashSet<String> = db_rows.iter().map(|(f, _)| f.clone()).collect();

    // Delete removed files
    for (filename, cached_path) in &db_rows {
        if !disk_files.contains(filename) {
            let _ = std::fs::remove_file(cached_path);
            sqlx::query(
                "DELETE FROM cached_images WHERE library_id = ? AND entry_folder_path = ? AND image_type = ? AND source_filename = ?",
            )
            .bind(library_id)
            .bind(entry_rel_path)
            .bind(image_type_db)
            .bind(filename)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    // Copy new files
    let _ = std::fs::create_dir_all(&cache_dir);
    for filename in &disk_files {
        if !db_files.contains(filename) {
            let source = source_dir.join(filename);
            let cached = cache_dir.join(filename);
            if std::fs::copy(&source, &cached).is_ok() {
                sqlx::query(
                    "INSERT OR REPLACE INTO cached_images (library_id, entry_folder_path, image_type, source_filename, cached_path) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(library_id)
                .bind(entry_rel_path)
                .bind(image_type_db)
                .bind(filename)
                .bind(cached.to_string_lossy().to_string())
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

/// Sync both covers and backgrounds for an entry during rescan
async fn sync_entry_images(
    pool: &sqlx::SqlitePool,
    library_id: &str,
    cache_base: &Path,
    library_base: &Path,
    entry_rel_path: &str,
) -> Result<(), String> {
    sync_cached_images_for_entry(pool, library_id, cache_base, library_base, entry_rel_path, "covers", "cover").await?;
    sync_cached_images_for_entry(pool, library_id, cache_base, library_base, entry_rel_path, "backgrounds", "background").await?;
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

async fn scan_video_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    library_id: &str,
    base_path: &PathBuf,
    cache_base: &Path,
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
    let collection_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'collection'")
            .fetch_one(pool)
            .await?;

    let mut top_dirs: Vec<_> = std::fs::read_dir(base_path)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        .filter_map(|e| e.ok())
        .filter(|e| is_scannable_dir(e))
        .collect();
    top_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for (i, dir_entry) in top_dirs.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(sqlx::Error::Protocol("Library creation cancelled".to_string()));
        }
        let path = dir_entry.path();
        let name = dir_entry.file_name().to_string_lossy().to_string();
        let _ = app.emit("scan-progress", &name);

        let subdirs: Vec<_> = std::fs::read_dir(&path)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
            .filter_map(|e| e.ok())
            .filter(|e| is_scannable_dir(e))
            .collect();

        let has_season = subdirs.iter().any(|e| {
            let (_, num) = parse_season_folder_name(&e.file_name().to_string_lossy());
            num.is_some()
        });

        let (title, _) = parse_folder_name(&name);
        let sort_title = generate_sort_title(&title, "en");
        let rel_path = path
            .strip_prefix(base_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        if has_season {
            // TV show
            let result = sqlx::query(
                "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, NULL, ?)",
            )
            .bind(library_id)
            .bind(show_type_id.0)
            .execute(pool)
            .await?;

            let entry_id = result.last_insert_rowid();
            sqlx::query("INSERT INTO show (id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?)")
                .bind(entry_id)
                .bind(&title)
                .bind(&rel_path)
                .bind(&sort_title)
                .bind(i as i32)
                .execute(pool)
                .await?;

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
                    let (ep_title, ep_number) = parse_episode_filename(&ep_name);
                    let ep_rel = ep_entry
                        .path()
                        .strip_prefix(base_path)
                        .unwrap_or(&ep_entry.path())
                        .to_string_lossy()
                        .to_string();

                    sqlx::query(
                        "INSERT INTO episode (season_id, title, episode_number, file_path, sort_order) VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(season_id)
                    .bind(&ep_title)
                    .bind(ep_number)
                    .bind(&ep_rel)
                    .bind(k as i32)
                    .execute(pool)
                    .await?;
                }
            }
        } else {
            // Movie or collection — delegate to recursive scan
            scan_video_dir(
                app,
                pool,
                library_id,
                base_path,
                &path,
                None,
                cache_base,
                i as i32,
                movie_type_id.0,
                collection_type_id.0,
                cancel,
            )
            .await?;
        }
    }

    Ok(())
}

#[async_recursion::async_recursion]
async fn scan_video_dir(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    library_id: &str,
    base_path: &PathBuf,
    dir: &PathBuf,
    parent_id: Option<i64>,
    cache_base: &Path,
    sort_order: i32,
    movie_type_id: i64,
    collection_type_id: i64,
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

    let has_video_files = subdirs.is_empty() && std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).any(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS)))
        .unwrap_or(false);

    if has_video_files {
        // Movie (leaf node with video files)
        let result = sqlx::query(
            "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
        )
        .bind(library_id)
        .bind(parent_id)
        .bind(movie_type_id)
        .execute(pool)
        .await?;

        let entry_id = result.last_insert_rowid();
        sqlx::query("INSERT INTO movie (id, title, folder_path, sort_title, sort_order, release_date) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(entry_id)
            .bind(&title)
            .bind(&rel_path)
            .bind(&sort_title)
            .bind(sort_order)
            .bind(&year)
            .execute(pool)
            .await?;

        cache_entry_images(pool, library_id, cache_base, base_path, &rel_path).await?;
    } else {
        // Collection (has subdirs, or empty folder)
        let result = sqlx::query(
            "INSERT INTO media_entry (library_id, parent_id, entry_type_id) VALUES (?, ?, ?)",
        )
        .bind(library_id)
        .bind(parent_id)
        .bind(collection_type_id)
        .execute(pool)
        .await?;

        let entry_id = result.last_insert_rowid();
        sqlx::query("INSERT INTO media_collection (id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?)")
            .bind(entry_id)
            .bind(&title)
            .bind(&rel_path)
            .bind(&sort_title)
            .bind(sort_order)
            .execute(pool)
            .await?;

        cache_entry_images(pool, library_id, cache_base, base_path, &rel_path).await?;

        let mut child_dirs: Vec<_> = subdirs;
        child_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

        for (j, child_entry) in child_dirs.iter().enumerate() {
            let child_path = child_entry.path();
            scan_video_dir(
                app,
                pool,
                library_id,
                base_path,
                &child_path,
                Some(entry_id),
                cache_base,
                j as i32,
                movie_type_id,
                collection_type_id,
                cancel,
            )
            .await?;
        }
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

fn parse_episode_filename(name: &str) -> (String, Option<i32>) {
    let stem = std::path::Path::new(name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let lower = stem.to_lowercase();

    // Match SxxExx pattern anywhere in the filename
    let bytes = lower.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b's' {
            let s_digits: String = lower[i + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
            if s_digits.is_empty() { continue; }
            let e_pos = i + 1 + s_digits.len();
            if e_pos < bytes.len() && bytes[e_pos] == b'e' {
                let ep_digits: String = lower[e_pos + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = ep_digits.parse::<i32>() {
                    return (stem, Some(n));
                }
            }
        }
    }

    (stem, None)
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

fn is_scannable_dir(entry: &std::fs::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy().to_string();
    entry.path().is_dir()
        && name != "covers"
        && name != "backgrounds"
        && name != "extras"
        && !name.starts_with('.')
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
    pub plot: Option<String>,
    pub tagline: Option<String>,
    pub maturity_rating: Option<String>,
    pub genres: Vec<String>,
    pub creators: Vec<PersonInfo>,
    pub cast: Vec<CastInfo>,
    pub composers: Vec<PersonInfo>,
    pub studios: Vec<String>,
    pub keywords: Vec<String>,
    /// True for anthology shows (Black Mirror, True Detective, etc.) where seasons or
    /// episodes are self-contained. When true, per-episode involvement labels on the
    /// person-detail page can reveal episode titles without risking spoilers.
    pub is_anthology: bool,
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
    pub release_date: Option<String>,
    pub plot: Option<String>,
    pub runtime: Option<i64>,
    pub cast: Vec<CastInfo>,
    pub directors: Vec<PersonInfo>,
    pub composers: Vec<PersonInfo>,
}

async fn get_library_paths(
    app_db: &SqlitePool,
    library_id: &str,
) -> Result<Vec<String>, String> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT paths FROM library WHERE id = ?",
    )
    .bind(library_id)
    .fetch_optional(app_db)
    .await
    .map_err(|e| e.to_string())?;
    let (paths_json,) = row.ok_or("Library not found")?;
    Ok(serde_json::from_str(&paths_json).unwrap_or_default())
}

#[tauri::command]
pub async fn get_show_detail(
    state: tauri::State<'_, AppState>,
    show_id: i64,
) -> Result<ShowDetail, String> {
    // Uses shared app_db pool

    let show_row: Option<(Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>, i64)> =
        sqlx::query_as(
            "SELECT tmdb_id, imdb_id, plot, tagline, maturity_rating_id, is_anthology FROM show WHERE id = ?",
        )
        .bind(show_id)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    let (tmdb_id, imdb_id, plot, tagline, mr_id, is_anthology_int) = show_row.ok_or("Show not found")?;
    let is_anthology = is_anthology_int != 0;

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

    // Cast
    let cast_rows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path, sc.role FROM show_cast sc JOIN person p ON sc.person_id = p.id WHERE sc.show_id = ? ORDER BY sc.sort_order",
    )
    .bind(show_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;
    let cast: Vec<CastInfo> = cast_rows.into_iter().map(|(id, name, image_path, role)| CastInfo { id, name, image_path, role }).collect();

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


    Ok(ShowDetail {
        id: show_id,
        tmdb_id,
        imdb_id,
        plot,
        tagline,
        maturity_rating,
        genres,
        creators,
        cast,
        composers,
        studios,
        keywords,
        is_anthology,
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

    let row: Option<(String, Option<i64>, Option<String>, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT title, episode_number, release_date, plot, runtime FROM episode WHERE id = ?",
    )
    .bind(episode_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (title, episode_number, release_date, plot, runtime) = row.ok_or("Episode not found")?;

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
    /// User-editable anthology flag. `None` = don't touch (keyword auto-detect may still
    /// flip it during this apply); `Some(bool)` = user-provided explicit value, overrides
    /// auto-detect.
    pub is_anthology: Option<bool>,
    /// User-editable display title. Writes to `show.title` + `show.sort_title`. Does NOT
    /// rename the folder on disk — that's handled by the dedicated `rename_entry` flow.
    pub title: Option<String>,
}

#[tauri::command]
pub async fn apply_tmdb_show_metadata(
    state: tauri::State<'_, AppState>,
    show_id: i64,
    fields: TmdbShowFieldSelection,
) -> Result<(), String> {
    let mut new_people: Vec<(i64, i64, Option<String>)> = Vec::new();

    // Display title — overwrites show.title + sort_title when non-empty. Folder on disk
    // stays as-is (rename_entry is the path for folder renaming).
    if let Some(ref title) = fields.title {
        let trimmed = title.trim();
        if !trimmed.is_empty() {
            let sort_title = generate_sort_title(trimmed, "en");
            sqlx::query("UPDATE show SET title = ?, sort_title = ? WHERE id = ?")
                .bind(trimmed)
                .bind(&sort_title)
                .bind(show_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

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
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT INTO show_creator (show_id, person_id) VALUES (?, ?)")
                .bind(show_id).bind(person_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref cast) = fields.cast {
        sqlx::query("DELETE FROM show_cast WHERE show_id = ?").bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for (i, c) in cast.iter().enumerate() {
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT INTO show_cast (show_id, person_id, role, sort_order) VALUES (?, ?, ?, ?)")
                .bind(show_id).bind(person_id).bind(&c.role).bind(i as i64).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref composers) = fields.composers {
        sqlx::query("DELETE FROM show_composer WHERE show_id = ?").bind(show_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for c in composers {
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
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

    // Anthology flag — explicit user value wins; otherwise auto-detect from the imported
    // keywords (match `anthology` case-insensitively in the keyword name). This covers
    // Black Mirror, True Detective, American Horror Story, Fargo, etc. on TMDB without
    // requiring the user to toggle manually.
    if let Some(flag) = fields.is_anthology {
        sqlx::query("UPDATE show SET is_anthology = ? WHERE id = ?")
            .bind(if flag { 1_i64 } else { 0_i64 })
            .bind(show_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    } else if fields.keywords.is_some() {
        let auto: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM show_keyword sk JOIN keyword k ON k.id = sk.keyword_id \
             WHERE sk.show_id = ? AND LOWER(k.name) LIKE '%anthology%' LIMIT 1",
        )
        .bind(show_id)
        .fetch_optional(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
        if auto.is_some() {
            sqlx::query("UPDATE show SET is_anthology = 1 WHERE id = ?")
                .bind(show_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
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
    /// TMDB's season `name` or a user-edited title. Overwrites `season.title` when non-empty.
    /// Only affects the display title; does not rename the folder on disk.
    pub title: Option<String>,
}

#[tauri::command]
pub async fn apply_tmdb_season_metadata(
    state: tauri::State<'_, AppState>,
    season_id: i64,
    fields: TmdbSeasonFieldSelection,
) -> Result<(), String> {
    let mut new_people: Vec<(i64, i64, Option<String>)> = Vec::new();

    // Display title — only written when non-empty. The filename/folder is untouched;
    // this is purely the DB-side display value shown in the UI.
    if let Some(ref title) = fields.title {
        if !title.trim().is_empty() {
            sqlx::query("UPDATE season SET title = ? WHERE id = ?")
                .bind(title.trim())
                .bind(season_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref plot) = fields.plot {
        sqlx::query("UPDATE season SET plot = ? WHERE id = ?")
            .bind(plot).bind(season_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
    }

    if let Some(ref cast) = fields.cast {
        sqlx::query("DELETE FROM season_cast WHERE season_id = ?").bind(season_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for (i, c) in cast.iter().enumerate() {
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
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
            let person_id = if let Some(pid) = d.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &d.name, d.tmdb_id).await?
            };
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
    pub plot: Option<String>,
    pub runtime: Option<i64>,
    pub release_date: Option<String>,
    pub cast: Option<Vec<CastUpdateInfo>>,
    pub director: Option<Vec<PersonUpdateInfo>>,
    pub composer: Option<Vec<PersonUpdateInfo>>,
    /// TMDB's episode `name` or a user-edited title. Overwrites `episode.title` when non-empty.
    /// Only affects the display title; does not rename the file on disk.
    pub title: Option<String>,
}

#[tauri::command]
pub async fn apply_tmdb_episode_metadata(
    state: tauri::State<'_, AppState>,
    episode_id: i64,
    fields: TmdbEpisodeFieldSelection,
) -> Result<(), String> {
    let mut new_people: Vec<(i64, i64, Option<String>)> = Vec::new();

    // Display title — only written when non-empty. The file on disk is untouched; this
    // is purely the DB-side display value used in the UI (detail page, person-detail
    // anthology labels, etc.).
    if let Some(ref title) = fields.title {
        if !title.trim().is_empty() {
            sqlx::query("UPDATE episode SET title = ? WHERE id = ?")
                .bind(title.trim())
                .bind(episode_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
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
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
            if let Some(tid) = c.tmdb_id { new_people.push((person_id, tid, c.profile_path.clone())); }
            sqlx::query("INSERT INTO episode_cast (episode_id, person_id, role, sort_order) VALUES (?, ?, ?, ?)")
                .bind(episode_id).bind(person_id).bind(&c.role).bind(i as i64).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref directors) = fields.director {
        sqlx::query("DELETE FROM episode_director WHERE episode_id = ?").bind(episode_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for d in directors {
            let person_id = if let Some(pid) = d.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &d.name, d.tmdb_id).await?
            };
            if let Some(tid) = d.tmdb_id { new_people.push((person_id, tid, d.profile_path.clone())); }
            sqlx::query("INSERT OR IGNORE INTO episode_director (episode_id, person_id) VALUES (?, ?)")
                .bind(episode_id).bind(person_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref composers) = fields.composer {
        sqlx::query("DELETE FROM episode_composer WHERE episode_id = ?").bind(episode_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        for c in composers {
            let person_id = if let Some(pid) = c.person_id {
                pid
            } else {
                ensure_person(&state.app_db, &c.name, c.tmdb_id).await?
            };
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

    // Get local episodes for this season
    let local_episodes: Vec<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, episode_number FROM episode WHERE season_id = ? ORDER BY episode_number",
    )
    .bind(season_id)
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    // Fetch TMDB season detail (includes episode summaries with guest_stars and crew)
    let client = reqwest::Client::new();
    let season_detail = crate::tmdb::get_season_detail(&client, &token, tmdb_id, season_number).await?;

    // Populate the season's own display title from TMDB when available. Only touches the
    // DB value — folder on disk is left alone. Unconditional overwrite here because the
    // existing value is almost always the filename-derived default; users who've manually
    // renamed can avoid re-bulk-fetching.
    if !season_detail.name.is_empty() {
        sqlx::query("UPDATE season SET title = ? WHERE id = ?")
            .bind(&season_detail.name)
            .bind(season_id)
            .execute(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;
    }

    let mut applied_count: i64 = 0;

    // Match by episode number
    for (local_id, local_ep_num) in &local_episodes {
        let local_num = match local_ep_num {
            Some(n) => *n,
            None => continue,
        };

        let tmdb_ep = season_detail.episodes.iter().find(|e| e.episode_number == local_num);
        let tmdb_ep = match tmdb_ep {
            Some(e) => e,
            None => continue,
        };

        // Episode display title — unconditional overwrite (same reasoning as season).
        if !tmdb_ep.name.is_empty() {
            sqlx::query("UPDATE episode SET title = ? WHERE id = ?")
                .bind(&tmdb_ep.name)
                .bind(local_id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
        }

        // Apply plot + runtime
        if let Some(ref overview) = tmdb_ep.overview {
            if !overview.is_empty() {
                sqlx::query("UPDATE episode SET plot = COALESCE(plot, ?) WHERE id = ? AND plot IS NULL")
                    .bind(overview).bind(local_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            }
        }
        if let Some(runtime) = tmdb_ep.runtime {
            sqlx::query("UPDATE episode SET runtime = COALESCE(runtime, ?) WHERE id = ? AND runtime IS NULL")
                .bind(runtime).bind(local_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
        }
        if let Some(ref air_date) = tmdb_ep.air_date {
            if !air_date.is_empty() {
                sqlx::query("UPDATE episode SET release_date = COALESCE(release_date, ?) WHERE id = ? AND release_date IS NULL")
                    .bind(air_date).bind(local_id).execute(&state.app_db).await.map_err(|e| e.to_string())?;
            }
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
