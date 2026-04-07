use crate::AppState;
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Library {
    pub id: String,
    pub name: String,
    pub paths: Vec<String>,
    pub format: String,
    pub portable: bool,
    pub db_filename: String,
    pub default_sort_mode: String,
    pub managed: bool,
    pub player_path: Option<String>,
    pub player_args: Option<String>,
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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EntriesResponse {
    pub entries: Vec<MediaEntry>,
    pub sort_mode: String,
    pub format: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersonInfo {
    pub id: i64,
    pub name: String,
    pub image_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CastInfo {
    pub id: i64,
    pub name: String,
    pub image_path: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CrewInfo {
    pub id: i64,
    pub name: String,
    pub image_path: Option<String>,
    pub job: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MovieDetail {
    pub id: i64,
    pub tmdb_id: Option<String>,
    pub imdb_id: Option<String>,
    pub rotten_tomatoes_id: Option<String>,
    pub plot: Option<String>,
    pub tagline: Option<String>,
    pub runtime: Option<i64>,
    pub maturity_rating: Option<String>,
    pub genres: Vec<String>,
    pub directors: Vec<PersonInfo>,
    pub cast: Vec<CastInfo>,
    pub crew: Vec<CrewInfo>,
    pub producers: Vec<PersonInfo>,
    pub studios: Vec<String>,
    pub keywords: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MovieDetailUpdate {
    pub tmdb_id: Option<String>,
    pub imdb_id: Option<String>,
    pub rotten_tomatoes_id: Option<String>,
    pub title: Option<String>,
    pub year: Option<String>,
    pub plot: Option<String>,
    pub tagline: Option<String>,
    pub runtime: Option<i64>,
    pub maturity_rating: Option<String>,
    pub genres: Option<Vec<String>>,
    pub directors: Option<Vec<String>>,
    pub cast: Option<Vec<CastUpdateInfo>>,
    pub crew: Option<Vec<CrewUpdateInfo>>,
    pub producers: Option<Vec<String>>,
    pub studios: Option<Vec<String>>,
    pub keywords: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CastUpdateInfo {
    pub name: String,
    pub role: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CrewUpdateInfo {
    pub name: String,
    pub job: Option<String>,
}

fn sanitize_db_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else if c == ' ' {
                '-'
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(|c| c == '-' || c == '_').to_string();
    if trimmed.is_empty() {
        "library".to_string()
    } else {
        trimmed
    }
}

fn unique_db_filename(app_data_dir: &PathBuf, base: &str) -> String {
    let candidate = format!("{}.db", base);
    if !app_data_dir.join(&candidate).exists() {
        return candidate;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{}-{}.db", base, n);
        if !app_data_dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}", now)
}

fn get_library_db_path(app_data_dir: &PathBuf, lib: &Library) -> PathBuf {
    if lib.portable {
        PathBuf::from(&lib.paths[0]).join(".waverunner.db")
    } else {
        app_data_dir.join(&lib.db_filename)
    }
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

    let db_filename = if portable {
        ".waverunner.db".to_string()
    } else {
        let base = sanitize_db_filename(&name);
        unique_db_filename(&state.app_data_dir, &base)
    };

    let db_path = get_library_db_path(
        &state.app_data_dir,
        &Library {
            id: id.clone(),
            name: name.clone(),
            paths: paths.clone(),
            format: format.clone(),
            portable,
            db_filename: db_filename.clone(),
            default_sort_mode: "alpha".to_string(),
            managed,
            player_path: None,
            player_args: None,
        },
    );

    let pool = crate::db::create_library_pool(&db_path, &format)
        .await
        .map_err(|e| e.to_string())?;

    let cache_base = state.app_data_dir.join("cache").join(&id);
    std::fs::create_dir_all(&cache_base).map_err(|e| e.to_string())?;

    let paths_json = serde_json::to_string(&paths).map_err(|e| e.to_string())?;

    let library = Library {
        id: id.clone(),
        name: name.clone(),
        paths: paths.clone(),
        format: format.clone(),
        portable,
        db_filename: db_filename.clone(),
        default_sort_mode: "alpha".to_string(),
        managed,
        player_path: None,
        player_args: None,
    };

    // Insert with creating=1 before scanning so startup cleanup can find it
    sqlx::query(
        "INSERT INTO libraries (id, name, paths, format, portable, db_filename, default_sort_mode, managed, creating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
    )
    .bind(&library.id)
    .bind(&library.name)
    .bind(&paths_json)
    .bind(&library.format)
    .bind(library.portable as i32)
    .bind(&library.db_filename)
    .bind(&library.default_sort_mode)
    .bind(library.managed as i32)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    // Reset cancellation flag
    state.cancel_creation.store(false, Ordering::SeqCst);
    let cancel = &state.cancel_creation;

    let scan_result: Result<(), String> = async {
        match format.as_str() {
            "video" => {
                sqlx::query("DELETE FROM media_entry").execute(&pool).await.map_err(|e| e.to_string())?;
                for p in &paths {
                    let lib_path = PathBuf::from(p);
                    scan_video_library(&app, &pool, &lib_path, &cache_base, cancel).await.map_err(|e| e.to_string())?;
                }
            }
            "tv" => {
                sqlx::query("DELETE FROM shows").execute(&pool).await.map_err(|e| e.to_string())?;
                for p in &paths {
                    let lib_path = PathBuf::from(p);
                    scan_tv_library(&app, &pool, &lib_path, &cache_base, cancel).await.map_err(|e| e.to_string())?;
                }
            }
            "music" => {
                sqlx::query("DELETE FROM artists").execute(&pool).await.map_err(|e| e.to_string())?;
                for p in &paths {
                    let lib_path = PathBuf::from(p);
                    scan_music_library(&app, &pool, &lib_path, &cache_base, cancel).await.map_err(|e| e.to_string())?;
                }
            }
            _ => {
                sqlx::query("DELETE FROM movie").execute(&pool).await.map_err(|e| e.to_string())?;
                for p in &paths {
                    let lib_path = PathBuf::from(p);
                    scan_folder(&app, &pool, &lib_path, None, &cache_base, cancel).await.map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }.await;

    pool.close().await;

    match scan_result {
        Ok(()) => {
            sqlx::query("UPDATE libraries SET creating = 0 WHERE id = ?")
                .bind(&id)
                .execute(&state.app_db)
                .await
                .map_err(|e| e.to_string())?;
            Ok(library)
        }
        Err(e) => {
            // Cleanup: remove DB file, cache, and libraries row
            let _ = std::fs::remove_file(&db_path);
            delete_cache_for_library(&state.app_data_dir, &id);
            let _ = sqlx::query("DELETE FROM libraries WHERE id = ?")
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
    let rows: Vec<(String, String, i32, String)> = sqlx::query_as(
        "SELECT id, paths, portable, db_filename FROM libraries WHERE creating = 1",
    )
    .fetch_all(app_db)
    .await
    .map_err(|e| e.to_string())?;

    for (id, paths_json, portable, db_filename) in rows {
        let paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();
        let db_path = if portable != 0 && !paths.is_empty() {
            PathBuf::from(&paths[0]).join(".waverunner.db")
        } else {
            app_data_dir.join(&db_filename)
        };
        let _ = std::fs::remove_file(&db_path);
        delete_cache_for_library(app_data_dir, &id);
        let _ = sqlx::query("DELETE FROM libraries WHERE id = ?")
            .bind(&id)
            .execute(app_db)
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_libraries(state: tauri::State<'_, AppState>) -> Result<Vec<Library>, String> {
    let rows: Vec<(String, String, String, String, i32, String, String, i32, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, name, paths, format, portable, db_filename, default_sort_mode, managed, player_path, player_args FROM libraries WHERE creating = 0 ORDER BY name",
    )
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, name, paths_json, format, portable, db_filename, default_sort_mode, managed, player_path, player_args)| Library {
            id,
            name,
            paths: serde_json::from_str(&paths_json).unwrap_or_default(),
            format,
            portable: portable != 0,
            db_filename,
            default_sort_mode,
            managed: managed != 0,
            player_path,
            player_args,
        })
        .collect())
}

#[tauri::command]
pub async fn delete_library(
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    let row: Option<(String, String, i32, String)> = sqlx::query_as(
        "SELECT id, paths, portable, db_filename FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (_, paths_json, portable, db_filename) = row.ok_or("Library not found")?;
    let paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    // Delete cache first — if it fails (e.g. files locked), abort the whole delete
    let cache_dir = state.app_data_dir.join("cache").join(&library_id);
    if cache_dir.exists() {
        std::fs::remove_dir_all(&cache_dir).map_err(|e| {
            format!("Could not delete library cache: {}", e)
        })?;
    }

    if db_path.exists() {
        std::fs::remove_file(&db_path).map_err(|e| {
            format!(
                "Could not delete the database file: {} — {}",
                db_path.display(),
                e
            )
        })?;
    }

    sqlx::query("DELETE FROM libraries WHERE id = ?")
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
) -> Result<EntriesResponse, String> {
    let row: Option<(String, i32, String, String, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, default_sort_mode, format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, default_sort_mode, format) = row.ok_or("Library not found")?;
    let _paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let mut covers_map = get_all_cached_covers(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let result = match format.as_str() {
        "video" => {
            let sort_mode = match parent_id {
                Some(pid) => {
                    let row: Option<(String,)> = sqlx::query_as(
                        "SELECT sort_mode FROM collection WHERE id = ?",
                    )
                    .bind(pid)
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| e.to_string())?;
                    row.map(|(m,)| m).unwrap_or(default_sort_mode)
                }
                None => default_sort_mode,
            };

            let order_clause = match sort_mode.as_str() {
                "year" => "ORDER BY me.year ASC, me.sort_title COLLATE NOCASE ASC",
                "custom" => "ORDER BY me.sort_order ASC, me.sort_title COLLATE NOCASE ASC",
                _ => "ORDER BY me.sort_title COLLATE NOCASE ASC",
            };

            let query_str = match parent_id {
                Some(_) => format!(
                    "SELECT me.id, me.title, me.year, me.end_year, me.folder_path, me.parent_id, met.name as entry_type, me.selected_cover, (SELECT COUNT(*) FROM media_entry c WHERE c.parent_id = me.id) as child_count FROM media_entry me JOIN media_entry_type met ON me.entry_type_id = met.id WHERE me.parent_id = ? {}",
                    order_clause
                ),
                None => format!(
                    "SELECT me.id, me.title, me.year, me.end_year, me.folder_path, me.parent_id, met.name as entry_type, me.selected_cover, (SELECT COUNT(*) FROM media_entry c WHERE c.parent_id = me.id) as child_count FROM media_entry me JOIN media_entry_type met ON me.entry_type_id = met.id WHERE me.parent_id IS NULL {}",
                    order_clause
                ),
            };

            let rows: Vec<(i64, String, Option<String>, Option<String>, String, Option<i64>, String, Option<String>, i64)> = match parent_id {
                Some(pid) => {
                    sqlx::query_as(&query_str)
                        .bind(pid)
                        .fetch_all(&pool)
                        .await
                }
                None => {
                    sqlx::query_as(&query_str)
                        .fetch_all(&pool)
                        .await
                }
            }
            .map_err(|e| e.to_string())?;

            let entries: Vec<MediaEntry> = rows
                .into_iter()
                .map(|(id, title, year, end_year, folder_path, parent_id, entry_type, selected_cover, child_count)| {
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
                    }
                })
                .collect();

            EntriesResponse {
                entries,
                sort_mode,
                format,
            }
        }
        "tv" => {
            let order_clause = match default_sort_mode.as_str() {
                "year" => "ORDER BY year ASC, sort_title COLLATE NOCASE ASC",
                "custom" => "ORDER BY sort_order ASC, sort_title COLLATE NOCASE ASC",
                _ => "ORDER BY sort_title COLLATE NOCASE ASC",
            };

            let query_str = format!(
                "SELECT id, title, year, folder_path, selected_cover FROM shows {}",
                order_clause
            );

            let rows: Vec<(i64, String, Option<String>, String, Option<String>)> =
                sqlx::query_as(&query_str)
                    .fetch_all(&pool)
                    .await
                    .map_err(|e| e.to_string())?;

            let entries: Vec<MediaEntry> = rows
                .into_iter()
                .map(|(id, title, year, folder_path, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry {
                        id,
                        title,
                        year,
                        end_year: None,
                        folder_path,
                        parent_id: None,
                        entry_type: "show".to_string(),
                        covers,
                        selected_cover,
                        child_count: 0,
                    }
                })
                .collect();

            EntriesResponse {
                entries,
                sort_mode: default_sort_mode,
                format,
            }
        }
        "music" => {
            let order_clause = match default_sort_mode.as_str() {
                "custom" => "ORDER BY sort_order ASC, sort_name COLLATE NOCASE ASC",
                _ => "ORDER BY sort_name COLLATE NOCASE ASC",
            };

            let query_str = format!(
                "SELECT id, name, folder_path, selected_cover FROM artists {}",
                order_clause
            );

            let rows: Vec<(i64, String, String, Option<String>)> =
                sqlx::query_as(&query_str)
                    .fetch_all(&pool)
                    .await
                    .map_err(|e| e.to_string())?;

            let entries: Vec<MediaEntry> = rows
                .into_iter()
                .map(|(id, name, folder_path, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry {
                        id,
                        title: name,
                        year: None,
                        end_year: None,
                        folder_path,
                        parent_id: None,
                        entry_type: "artist".to_string(),
                        covers,
                        selected_cover,
                        child_count: 0,
                    }
                })
                .collect();

            EntriesResponse {
                entries,
                sort_mode: default_sort_mode,
                format,
            }
        }
        _ => {
            // Movies — existing logic
            let sort_mode = match parent_id {
                Some(pid) => {
                    let row: Option<(String,)> = sqlx::query_as(
                        "SELECT sort_mode FROM movie WHERE id = ?",
                    )
                    .bind(pid)
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| e.to_string())?;
                    row.map(|(m,)| m).unwrap_or(default_sort_mode)
                }
                None => default_sort_mode,
            };

            let order_clause = match sort_mode.as_str() {
                "year" => "ORDER BY year ASC, sort_title COLLATE NOCASE ASC",
                "custom" => "ORDER BY sort_order ASC, sort_title COLLATE NOCASE ASC",
                _ => "ORDER BY sort_title COLLATE NOCASE ASC",
            };

            let query_str = match parent_id {
                Some(_) => format!(
                    "SELECT id, title, year, folder_path, parent_id, is_collection, selected_cover FROM movie WHERE parent_id = ? {}",
                    order_clause
                ),
                None => format!(
                    "SELECT id, title, year, folder_path, parent_id, is_collection, selected_cover FROM movie WHERE parent_id IS NULL {}",
                    order_clause
                ),
            };

            let rows: Vec<(i64, String, Option<String>, String, Option<i64>, i32, Option<String>)> = match parent_id {
                Some(pid) => {
                    sqlx::query_as(&query_str)
                        .bind(pid)
                        .fetch_all(&pool)
                        .await
                }
                None => {
                    sqlx::query_as(&query_str)
                        .fetch_all(&pool)
                        .await
                }
            }
            .map_err(|e| e.to_string())?;

            let entries: Vec<MediaEntry> = rows
                .into_iter()
                .map(|(id, title, year, folder_path, parent_id, is_collection, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry {
                        id,
                        title,
                        year,
                        end_year: None,
                        folder_path,
                        parent_id,
                        entry_type: if is_collection != 0 { "collection".to_string() } else { "movie".to_string() },
                        covers,
                        selected_cover,
                        child_count: 0,
                    }
                })
                .collect();

            EntriesResponse {
                entries,
                sort_mode,
                format,
            }
        }
    };

    pool.close().await;
    Ok(result)
}

#[tauri::command]
pub async fn search_entries(
    state: tauri::State<'_, AppState>,
    library_id: String,
    parent_id: Option<i64>,
    query: String,
) -> Result<Vec<MediaEntry>, String> {
    let row: Option<(String, i32, String, String, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, default_sort_mode, format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, _default_sort_mode, format) = row.ok_or("Library not found")?;
    let _paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let mut covers_map = get_all_cached_covers(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let like_pattern = format!("%{}%", query);

    let entries = match format.as_str() {
        "video" => {
            let query_str = match parent_id {
                Some(_) => "\
                    WITH RECURSIVE descendants(id) AS ( \
                        SELECT id FROM media_entry WHERE parent_id = ? \
                        UNION ALL \
                        SELECT me.id FROM media_entry me JOIN descendants d ON me.parent_id = d.id \
                    ) \
                    SELECT me.id, me.title, me.year, me.end_year, me.folder_path, me.parent_id, met.name as entry_type, me.selected_cover \
                    FROM media_entry me \
                    JOIN media_entry_type met ON me.entry_type_id = met.id \
                    WHERE me.id IN (SELECT id FROM descendants) AND me.title LIKE ? \
                    ORDER BY me.sort_title COLLATE NOCASE ASC",
                None => "\
                    SELECT me.id, me.title, me.year, me.end_year, me.folder_path, me.parent_id, met.name as entry_type, me.selected_cover \
                    FROM media_entry me \
                    JOIN media_entry_type met ON me.entry_type_id = met.id \
                    WHERE me.title LIKE ? \
                    ORDER BY me.sort_title COLLATE NOCASE ASC",
            };

            let rows: Vec<(i64, String, Option<String>, Option<String>, String, Option<i64>, String, Option<String>)> = match parent_id {
                Some(pid) => {
                    sqlx::query_as(query_str)
                        .bind(pid)
                        .bind(&like_pattern)
                        .fetch_all(&pool)
                        .await
                }
                None => {
                    sqlx::query_as(query_str)
                        .bind(&like_pattern)
                        .fetch_all(&pool)
                        .await
                }
            }
            .map_err(|e| e.to_string())?;

            rows.into_iter()
                .map(|(id, title, year, end_year, folder_path, parent_id, entry_type, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry { id, title, year, end_year, folder_path, parent_id, entry_type, covers, selected_cover, child_count: 0 }
                })
                .collect()
        }
        "tv" => {
            let rows: Vec<(i64, String, Option<String>, String, Option<String>)> =
                sqlx::query_as(
                    "SELECT id, title, year, folder_path, selected_cover FROM shows WHERE title LIKE ? ORDER BY sort_title COLLATE NOCASE ASC",
                )
                .bind(&like_pattern)
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;

            rows.into_iter()
                .map(|(id, title, year, folder_path, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry { id, title, year, end_year: None, folder_path, parent_id: None, entry_type: "show".to_string(), covers, selected_cover, child_count: 0 }
                })
                .collect()
        }
        "music" => {
            let rows: Vec<(i64, String, String, Option<String>)> =
                sqlx::query_as(
                    "SELECT id, name, folder_path, selected_cover FROM artists WHERE name LIKE ? ORDER BY sort_name COLLATE NOCASE ASC",
                )
                .bind(&like_pattern)
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;

            rows.into_iter()
                .map(|(id, name, folder_path, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry { id, title: name, year: None, end_year: None, folder_path, parent_id: None, entry_type: "artist".to_string(), covers, selected_cover, child_count: 0 }
                })
                .collect()
        }
        _ => {
            // Legacy movies — recursive CTE scoped to parent
            let query_str = match parent_id {
                Some(_) => "\
                    WITH RECURSIVE descendants(id) AS ( \
                        SELECT id FROM movie WHERE parent_id = ? \
                        UNION ALL \
                        SELECT m.id FROM movie m JOIN descendants d ON m.parent_id = d.id \
                    ) \
                    SELECT id, title, year, folder_path, parent_id, is_collection, selected_cover \
                    FROM movie WHERE id IN (SELECT id FROM descendants) AND title LIKE ? \
                    ORDER BY sort_title COLLATE NOCASE ASC",
                None => "\
                    SELECT id, title, year, folder_path, parent_id, is_collection, selected_cover \
                    FROM movie WHERE title LIKE ? ORDER BY sort_title COLLATE NOCASE ASC",
            };

            let rows: Vec<(i64, String, Option<String>, String, Option<i64>, i32, Option<String>)> = match parent_id {
                Some(pid) => {
                    sqlx::query_as(query_str)
                        .bind(pid)
                        .bind(&like_pattern)
                        .fetch_all(&pool)
                        .await
                }
                None => {
                    sqlx::query_as(query_str)
                        .bind(&like_pattern)
                        .fetch_all(&pool)
                        .await
                }
            }
            .map_err(|e| e.to_string())?;

            rows.into_iter()
                .map(|(id, title, year, folder_path, parent_id, is_collection, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry {
                        id, title, year, end_year: None, folder_path, parent_id,
                        entry_type: if is_collection != 0 { "collection".to_string() } else { "movie".to_string() },
                        covers, selected_cover, child_count: 0,
                    }
                })
                .collect()
        }
    };

    pool.close().await;
    Ok(entries)
}

#[tauri::command]
pub async fn get_movie_detail(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
) -> Result<MovieDetail, String> {
    let row: Option<(String, i32, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename) = row.ok_or("Library not found")?;
    let _paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    // Movie scalar fields
    let movie_row: Option<(i64, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<i64>, Option<i64>)> =
        sqlx::query_as(
            "SELECT id, tmdb_id, imdb_id, rotten_tomatoes_id, plot, tagline, runtime, maturity_rating_id FROM movie WHERE id = ?",
        )
        .bind(entry_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let (id, tmdb_id, imdb_id, rotten_tomatoes_id, plot, tagline, runtime, maturity_rating_id) =
        movie_row.ok_or("Movie not found")?;

    // Maturity rating name
    let maturity_rating: Option<String> = if let Some(mr_id) = maturity_rating_id {
        let mr_row: Option<(String,)> = sqlx::query_as("SELECT name FROM maturity_rating WHERE id = ?")
            .bind(mr_id)
            .fetch_optional(&pool)
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
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let genres: Vec<String> = genre_rows.into_iter().map(|(n,)| n).collect();

    // Directors
    let director_rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path FROM movie_director md JOIN person p ON md.person_id = p.id WHERE md.movie_id = ? ORDER BY p.name",
    )
    .bind(entry_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let directors: Vec<PersonInfo> = director_rows.into_iter().map(|(id, name, image_path)| PersonInfo { id, name, image_path }).collect();

    // Cast
    let cast_rows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path, mc.role FROM movie_cast mc JOIN person p ON mc.person_id = p.id WHERE mc.movie_id = ? ORDER BY mc.sort_order",
    )
    .bind(entry_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let cast: Vec<CastInfo> = cast_rows.into_iter().map(|(id, name, image_path, role)| CastInfo { id, name, image_path, role }).collect();

    // Crew
    let crew_rows: Vec<(i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path, mc.job FROM movie_crew mc JOIN person p ON mc.person_id = p.id WHERE mc.movie_id = ? ORDER BY p.name",
    )
    .bind(entry_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let crew: Vec<CrewInfo> = crew_rows.into_iter().map(|(id, name, image_path, job)| CrewInfo { id, name, image_path, job }).collect();

    // Producers
    let producer_rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT p.id, p.name, p.image_path FROM movie_producer mp JOIN person p ON mp.person_id = p.id WHERE mp.movie_id = ? ORDER BY p.name",
    )
    .bind(entry_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let producers: Vec<PersonInfo> = producer_rows.into_iter().map(|(id, name, image_path)| PersonInfo { id, name, image_path }).collect();

    // Studios
    let studio_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT s.name FROM movie_studio ms JOIN studio s ON ms.studio_id = s.id WHERE ms.movie_id = ? ORDER BY s.name",
    )
    .bind(entry_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let studios: Vec<String> = studio_rows.into_iter().map(|(n,)| n).collect();

    // Keywords
    let keyword_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT k.name FROM movie_keyword mk JOIN keyword k ON mk.keyword_id = k.id WHERE mk.movie_id = ? ORDER BY k.name",
    )
    .bind(entry_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let keywords: Vec<String> = keyword_rows.into_iter().map(|(n,)| n).collect();

    pool.close().await;

    Ok(MovieDetail {
        id,
        tmdb_id,
        imdb_id,
        rotten_tomatoes_id,
        plot,
        tagline,
        runtime,
        maturity_rating,
        genres,
        directors,
        cast,
        crew,
        producers,
        studios,
        keywords,
    })
}

#[tauri::command]
pub async fn update_movie_detail(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    detail: MovieDetailUpdate,
) -> Result<(), String> {
    let row: Option<(String, i32, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename) = row.ok_or("Library not found")?;
    let _paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    // Update media_entry title/year if provided
    if let Some(ref title) = detail.title {
        let sort_title = generate_sort_title(title, "en");
        sqlx::query("UPDATE media_entry SET title = ?, sort_title = ? WHERE id = ?")
            .bind(title)
            .bind(&sort_title)
            .bind(entry_id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref year) = detail.year {
        let year_val = if year.is_empty() { None } else { Some(year.as_str()) };
        sqlx::query("UPDATE media_entry SET year = ? WHERE id = ?")
            .bind(year_val)
            .bind(entry_id)
            .execute(&pool)
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
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    // Maturity rating
    if let Some(ref mr_name) = detail.maturity_rating {
        if mr_name.is_empty() {
            sqlx::query("UPDATE movie SET maturity_rating_id = NULL WHERE id = ?")
                .bind(entry_id)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        } else {
            sqlx::query("INSERT OR IGNORE INTO maturity_rating (name) VALUES (?)")
                .bind(mr_name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("UPDATE movie SET maturity_rating_id = (SELECT id FROM maturity_rating WHERE name = ?) WHERE id = ?")
                .bind(mr_name)
                .bind(entry_id)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Genres (delete + re-insert)
    if let Some(ref genres) = detail.genres {
        sqlx::query("DELETE FROM movie_genre WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
        for genre_name in genres {
            sqlx::query("INSERT OR IGNORE INTO genre (name) VALUES (?)")
                .bind(genre_name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_genre (movie_id, genre_id) VALUES (?, (SELECT id FROM genre WHERE name = ?))")
                .bind(entry_id)
                .bind(genre_name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Directors
    if let Some(ref directors) = detail.directors {
        sqlx::query("DELETE FROM movie_director WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
        for name in directors {
            sqlx::query("INSERT OR IGNORE INTO person (name) VALUES (?)")
                .bind(name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_director (movie_id, person_id) VALUES (?, (SELECT id FROM person WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Cast
    if let Some(ref cast) = detail.cast {
        sqlx::query("DELETE FROM movie_cast WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
        for (i, c) in cast.iter().enumerate() {
            sqlx::query("INSERT OR IGNORE INTO person (name) VALUES (?)")
                .bind(&c.name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_cast (movie_id, person_id, role, sort_order) VALUES (?, (SELECT id FROM person WHERE name = ?), ?, ?)")
                .bind(entry_id)
                .bind(&c.name)
                .bind(&c.role)
                .bind(i as i64)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Crew
    if let Some(ref crew) = detail.crew {
        sqlx::query("DELETE FROM movie_crew WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
        for c in crew {
            sqlx::query("INSERT OR IGNORE INTO person (name) VALUES (?)")
                .bind(&c.name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_crew (movie_id, person_id, job) VALUES (?, (SELECT id FROM person WHERE name = ?), ?)")
                .bind(entry_id)
                .bind(&c.name)
                .bind(&c.job)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Producers
    if let Some(ref producers) = detail.producers {
        sqlx::query("DELETE FROM movie_producer WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
        for name in producers {
            sqlx::query("INSERT OR IGNORE INTO person (name) VALUES (?)")
                .bind(name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_producer (movie_id, person_id) VALUES (?, (SELECT id FROM person WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Studios
    if let Some(ref studios) = detail.studios {
        sqlx::query("DELETE FROM movie_studio WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
        for name in studios {
            sqlx::query("INSERT OR IGNORE INTO studio (name) VALUES (?)")
                .bind(name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_studio (movie_id, studio_id) VALUES (?, (SELECT id FROM studio WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Keywords
    if let Some(ref keywords) = detail.keywords {
        sqlx::query("DELETE FROM movie_keyword WHERE movie_id = ?")
            .bind(entry_id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
        for name in keywords {
            sqlx::query("INSERT OR IGNORE INTO keyword (name) VALUES (?)")
                .bind(name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO movie_keyword (movie_id, keyword_id) VALUES (?, (SELECT id FROM keyword WHERE name = ?))")
                .bind(entry_id)
                .bind(name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    pool.close().await;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DetectedPlayer {
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub async fn detect_players() -> Result<Vec<DetectedPlayer>, String> {
    let candidates: Vec<(&str, Vec<&str>)> = vec![
        ("VLC", vec![
            r"C:\Program Files\VideoLAN\VLC\vlc.exe",
            r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
        ]),
        ("mpv", vec![
            r"C:\Program Files\mpv\mpv.exe",
            r"C:\Program Files (x86)\mpv\mpv.exe",
        ]),
        ("MPC-HC", vec![
            r"C:\Program Files\MPC-HC\mpc-hc64.exe",
            r"C:\Program Files (x86)\MPC-HC\mpc-hc.exe",
        ]),
        ("PotPlayer", vec![
            r"C:\Program Files\DAUM\PotPlayer\PotPlayerMini64.exe",
            r"C:\Program Files (x86)\DAUM\PotPlayer\PotPlayerMini.exe",
        ]),
    ];

    let mut found = Vec::new();
    for (name, paths) in candidates {
        for path in paths {
            if PathBuf::from(path).exists() {
                found.push(DetectedPlayer {
                    name: name.to_string(),
                    path: path.to_string(),
                });
                break;
            }
        }
    }
    Ok(found)
}

#[tauri::command]
pub async fn set_library_player(
    state: tauri::State<'_, AppState>,
    library_id: String,
    player_path: Option<String>,
    player_args: Option<String>,
) -> Result<(), String> {
    sqlx::query("UPDATE libraries SET player_path = ?, player_args = ? WHERE id = ?")
        .bind(&player_path)
        .bind(&player_args)
        .bind(&library_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn play_movie(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
) -> Result<(), String> {
    // Get library info
    let row: Option<(String, i32, String, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, player_path, player_args, format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, player_path, player_args, format) = row.ok_or("Library not found")?;
    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path).await.map_err(|e| e.to_string())?;

    // Get entry folder_path
    let folder_path: String = match format.as_str() {
        "video" => {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT folder_path FROM media_entry WHERE id = ?",
            )
            .bind(entry_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| e.to_string())?;
            row.ok_or("Entry not found")?.0
        }
        _ => {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT folder_path FROM movie WHERE id = ?",
            )
            .bind(entry_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| e.to_string())?;
            row.ok_or("Entry not found")?.0
        }
    };

    pool.close().await;

    // Resolve full path
    let root = resolve_entry_root(&lib_paths, &folder_path)
        .ok_or("Could not find entry on disk")?;
    let full_folder = PathBuf::from(root).join(&folder_path);

    // Find video file
    let video_file = std::fs::read_dir(&full_folder)
        .map_err(|e| format!("Cannot read folder: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS))
        .map(|e| e.path())
        .next()
        .ok_or("No video file found in movie folder")?;

    // Launch player (detached so closing waverunner doesn't kill it)
    if let Some(ref exe) = player_path {
        let mut cmd = std::process::Command::new(exe);
        if let Some(ref args) = player_args {
            for arg in args.split_whitespace() {
                cmd.arg(arg);
            }
        }
        cmd.arg(&video_file);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x00000008 | 0x00000010); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        }
        cmd.spawn().map_err(|e| format!("Failed to launch player: {}", e))?;
    } else {
        // OS default: use 'cmd /C start "" "path"' on Windows
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &video_file.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
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

#[tauri::command]
pub async fn get_show_seasons(
    state: tauri::State<'_, AppState>,
    library_id: String,
    show_id: i64,
) -> Result<Vec<SeasonInfo>, String> {
    let row: Option<(String, i32, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename) = row.ok_or("Library not found")?;
    let paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path).await.map_err(|e| e.to_string())?;

    let rows: Vec<(i64, String, Option<i64>, i64)> = sqlx::query_as(
        "SELECT id, title, season_number, sort_order FROM season WHERE show_id = ? ORDER BY sort_order",
    )
    .bind(show_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    pool.close().await;

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
    library_id: String,
    season_id: i64,
) -> Result<Vec<EpisodeInfo>, String> {
    let row: Option<(String, i32, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename) = row.ok_or("Library not found")?;
    let paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path).await.map_err(|e| e.to_string())?;

    let rows: Vec<(i64, String, Option<i64>, String, i64)> = sqlx::query_as(
        "SELECT id, title, episode_number, file_path, sort_order FROM episode WHERE season_id = ? ORDER BY sort_order",
    )
    .bind(season_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    pool.close().await;

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
pub async fn play_episode(
    state: tauri::State<'_, AppState>,
    library_id: String,
    episode_id: i64,
) -> Result<(), String> {
    let row: Option<(String, i32, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, player_path, player_args FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, player_path, player_args) = row.ok_or("Library not found")?;
    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path).await.map_err(|e| e.to_string())?;

    // Get the episode file_path (relative to library root)
    let ep_row: Option<(String,)> = sqlx::query_as(
        "SELECT file_path FROM episode WHERE id = ?",
    )
    .bind(episode_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| e.to_string())?;

    pool.close().await;

    let file_path = ep_row.ok_or("Episode not found")?.0;

    // Resolve full path against library roots
    let mut full_path: Option<PathBuf> = None;
    for p in &lib_paths {
        let candidate = PathBuf::from(p).join(&file_path);
        if candidate.exists() {
            full_path = Some(candidate);
            break;
        }
    }
    let full_path = full_path.ok_or("Episode file not found on disk")?;

    // Launch player (detached so closing waverunner doesn't kill it)
    if let Some(ref exe) = player_path {
        let mut cmd = std::process::Command::new(exe);
        if let Some(ref args) = player_args {
            for arg in args.split_whitespace() {
                cmd.arg(arg);
            }
        }
        cmd.arg(&full_path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x00000008 | 0x00000010); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        }
        cmd.spawn().map_err(|e| format!("Failed to launch player: {}", e))?;
    } else {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &full_path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}


#[tauri::command]
pub async fn set_sort_mode(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: Option<i64>,
    sort_mode: String,
) -> Result<(), String> {
    if !["alpha", "year", "custom"].contains(&sort_mode.as_str()) {
        return Err("Invalid sort mode".to_string());
    }

    let row: Option<(String,)> = sqlx::query_as(
        "SELECT format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (format,) = row.ok_or("Library not found")?;

    match entry_id {
        Some(eid) if format == "video" => {
            // Set sort_mode on a collection entry (video)
            let lib_row: Option<(String, i32, String)> = sqlx::query_as(
                "SELECT paths, portable, db_filename FROM libraries WHERE id = ?",
            )
            .bind(&library_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;

            let (paths_json, portable, db_filename) = lib_row.ok_or("Library not found")?;
            let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

            let db_path = if portable != 0 {
                PathBuf::from(&lib_paths[0]).join(".waverunner.db")
            } else {
                state.app_data_dir.join(&db_filename)
            };

            let pool = crate::db::connect_library_pool(&db_path)
                .await
                .map_err(|e| e.to_string())?;

            sqlx::query("UPDATE collection SET sort_mode = ? WHERE id = ?")
                .bind(&sort_mode)
                .bind(eid)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;

            pool.close().await;
        }
        Some(eid) if format == "movies" => {
            // Set sort_mode on a collection entry (legacy movies)
            let lib_row: Option<(String, i32, String)> = sqlx::query_as(
                "SELECT paths, portable, db_filename FROM libraries WHERE id = ?",
            )
            .bind(&library_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;

            let (paths_json, portable, db_filename) = lib_row.ok_or("Library not found")?;
            let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

            let db_path = if portable != 0 {
                PathBuf::from(&lib_paths[0]).join(".waverunner.db")
            } else {
                state.app_data_dir.join(&db_filename)
            };

            let pool = crate::db::connect_library_pool(&db_path)
                .await
                .map_err(|e| e.to_string())?;

            sqlx::query("UPDATE movie SET sort_mode = ? WHERE id = ?")
                .bind(&sort_mode)
                .bind(eid)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;

            pool.close().await;
        }
        _ => {
            // Set default_sort_mode on the library (root level, or any TV/music)
            sqlx::query("UPDATE libraries SET default_sort_mode = ? WHERE id = ?")
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
    entry_ids: Vec<i64>,
) -> Result<(), String> {
    let row: Option<(String, i32, String, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, format) = row.ok_or("Library not found")?;
    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let table = match format.as_str() {
        "video" => "media_entry",
        "tv" => "shows",
        "music" => "artists",
        _ => "movie",
    };

    for (i, id) in entry_ids.iter().enumerate() {
        let q = format!("UPDATE {} SET sort_order = ? WHERE id = ?", table);
        sqlx::query(&q)
            .bind(i as i32)
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    pool.close().await;
    Ok(())
}

#[tauri::command]
pub async fn rename_entry(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    new_title: String,
) -> Result<(), String> {
    let row: Option<(String, i32, String, i32, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, managed, format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, managed, format) = row.ok_or("Library not found")?;
    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    // If managed library, rename the actual folder on disk and update paths
    if managed != 0 {
        let cache_base = state.app_data_dir.join("cache").join(&library_id);

        match format.as_str() {
            "video" => {
                // Query media_entry + entry_type
                let entry_row: Option<(String, Option<String>, String)> = sqlx::query_as(
                    "SELECT me.folder_path, me.year, met.name FROM media_entry me JOIN media_entry_type met ON me.entry_type_id = met.id WHERE me.id = ?",
                )
                .bind(entry_id)
                .fetch_optional(&pool)
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
                        pool.close().await;
                        return Err(format!("A folder named '{}' already exists", new_folder_name));
                    }

                    std::fs::rename(&old_full_path, &new_full_path)
                        .map_err(|e| format!("Failed to rename folder: {}", e))?;

                    let new_rel_path = new_full_path
                        .strip_prefix(&lib_base)
                        .unwrap_or(&new_full_path)
                        .to_string_lossy()
                        .to_string();

                    let old_rel_prefix = format!("{}\\", folder_path);
                    let new_rel_prefix = format!("{}\\", new_rel_path);

                    // Update this entry's folder_path
                    sqlx::query("UPDATE media_entry SET folder_path = ? WHERE id = ?")
                        .bind(&new_rel_path)
                        .bind(entry_id)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;

                    // Update child media_entry folder_paths (collections can nest)
                    sqlx::query(
                        "UPDATE media_entry SET folder_path = ? || SUBSTR(folder_path, ?) WHERE folder_path LIKE ? AND id != ?",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(format!("{}%", old_rel_prefix))
                    .bind(entry_id)
                    .execute(&pool)
                    .await
                    .map_err(|e| e.to_string())?;

                    // Update season folder_paths if this is a show
                    if entry_type == "show" {
                        sqlx::query(
                            "UPDATE season SET folder_path = ? || SUBSTR(folder_path, ?) WHERE show_id = ?",
                        )
                        .bind(&new_rel_prefix)
                        .bind((old_rel_prefix.len() + 1) as i32)
                        .bind(entry_id)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;

                        sqlx::query(
                            "UPDATE episode SET file_path = ? || SUBSTR(file_path, ?) WHERE season_id IN (SELECT id FROM season WHERE show_id = ?)",
                        )
                        .bind(&new_rel_prefix)
                        .bind((old_rel_prefix.len() + 1) as i32)
                        .bind(entry_id)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    }

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
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                        .bind(&new_rel_path)
                        .bind(&old_cache_abs)
                        .bind(&new_cache_abs)
                        .bind(&folder_path)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    let old_rel_prefix_ci = format!("{}\\", folder_path);
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ? || SUBSTR(entry_folder_path, ?), cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path LIKE ?")
                        .bind(&format!("{}\\", new_rel_path))
                        .bind((old_rel_prefix_ci.len() + 1) as i32)
                        .bind(&old_cache_abs_prefix)
                        .bind(&new_cache_abs_prefix)
                        .bind(format!("{}%", old_rel_prefix_ci))
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            "movies" => {
                let entry_row: Option<(String, Option<String>)> = sqlx::query_as(
                    "SELECT folder_path, year FROM movie WHERE id = ?",
                )
                .bind(entry_id)
                .fetch_optional(&pool)
                .await
                .map_err(|e| e.to_string())?;

                let (folder_path, year) = entry_row.ok_or("Entry not found")?;
                let lib_base = PathBuf::from(resolve_entry_root(&lib_paths, &folder_path).ok_or("Could not find entry on disk")?);
                let old_full_path = lib_base.join(&folder_path);

                let safe_title = sanitize_filename(&new_title);
                let new_folder_name = match &year {
                    Some(y) => format!("{} ({})", safe_title, y),
                    None => safe_title,
                };

                let old_parent = old_full_path.parent().ok_or("Invalid folder path")?;
                let new_full_path = old_parent.join(&new_folder_name);

                if old_full_path != new_full_path {
                    if new_full_path.exists() {
                        pool.close().await;
                        return Err(format!("A folder named '{}' already exists", new_folder_name));
                    }

                    std::fs::rename(&old_full_path, &new_full_path)
                        .map_err(|e| format!("Failed to rename folder: {}", e))?;

                    let new_rel_path = new_full_path
                        .strip_prefix(&lib_base)
                        .unwrap_or(&new_full_path)
                        .to_string_lossy()
                        .to_string();

                    let old_rel_prefix = format!("{}\\", folder_path);
                    let new_rel_prefix = format!("{}\\", new_rel_path);

                    sqlx::query("UPDATE movie SET folder_path = ? WHERE id = ?")
                        .bind(&new_rel_path)
                        .bind(entry_id)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;

                    sqlx::query(
                        "UPDATE movie SET folder_path = ? || SUBSTR(folder_path, ?) WHERE folder_path LIKE ? AND id != ?",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(format!("{}%", old_rel_prefix))
                    .bind(entry_id)
                    .execute(&pool)
                    .await
                    .map_err(|e| e.to_string())?;

                    // Update cached_images: rename cache dir + update DB paths
                    let old_cache = cache_base.join(&folder_path);
                    let new_cache = cache_base.join(&new_rel_path);
                    if old_cache.exists() {
                        let _ = std::fs::rename(&old_cache, &new_cache);
                    }
                    let old_cache_abs = old_cache.to_string_lossy().to_string().replace('/', "\\");
                    let new_cache_abs = new_cache.to_string_lossy().to_string().replace('/', "\\");
                    let old_cache_abs_prefix = format!("{}\\", old_cache_abs);
                    let new_cache_abs_prefix = format!("{}\\", new_cache_abs);
                    // Update this entry's cached_images
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                        .bind(&new_rel_path)
                        .bind(&old_cache_abs)
                        .bind(&new_cache_abs)
                        .bind(&folder_path)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    // Update child entries' cached_images (movies can nest)
                    let old_rel_prefix_ci = format!("{}\\", folder_path);
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ? || SUBSTR(entry_folder_path, ?), cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path LIKE ?")
                        .bind(&format!("{}\\", new_rel_path))
                        .bind((old_rel_prefix_ci.len() + 1) as i32)
                        .bind(&old_cache_abs_prefix)
                        .bind(&new_cache_abs_prefix)
                        .bind(format!("{}%", old_rel_prefix_ci))
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            "tv" => {
                let entry_row: Option<(String, Option<String>)> = sqlx::query_as(
                    "SELECT folder_path, year FROM shows WHERE id = ?",
                )
                .bind(entry_id)
                .fetch_optional(&pool)
                .await
                .map_err(|e| e.to_string())?;

                let (folder_path, year) = entry_row.ok_or("Entry not found")?;
                let lib_base = PathBuf::from(resolve_entry_root(&lib_paths, &folder_path).ok_or("Could not find entry on disk")?);
                let old_full_path = lib_base.join(&folder_path);

                let safe_title = sanitize_filename(&new_title);
                let new_folder_name = match &year {
                    Some(y) => format!("{} ({})", safe_title, y),
                    None => safe_title,
                };

                let new_full_path = old_full_path.parent().ok_or("Invalid folder path")?.join(&new_folder_name);

                if old_full_path != new_full_path {
                    if new_full_path.exists() {
                        pool.close().await;
                        return Err(format!("A folder named '{}' already exists", new_folder_name));
                    }

                    std::fs::rename(&old_full_path, &new_full_path)
                        .map_err(|e| format!("Failed to rename folder: {}", e))?;

                    let new_rel_path = new_full_path
                        .strip_prefix(&lib_base)
                        .unwrap_or(&new_full_path)
                        .to_string_lossy()
                        .to_string();

                    let old_rel_prefix = format!("{}\\", folder_path);
                    let new_rel_prefix = format!("{}\\", new_rel_path);

                    // Update show folder_path
                    sqlx::query("UPDATE shows SET folder_path = ? WHERE id = ?")
                        .bind(&new_rel_path)
                        .bind(entry_id)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;

                    // Update season folder_paths
                    sqlx::query(
                        "UPDATE seasons SET folder_path = ? || SUBSTR(folder_path, ?) WHERE show_id = ?",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(entry_id)
                    .execute(&pool)
                    .await
                    .map_err(|e| e.to_string())?;

                    // Update episode file_paths
                    sqlx::query(
                        "UPDATE episodes SET file_path = ? || SUBSTR(file_path, ?) WHERE season_id IN (SELECT id FROM seasons WHERE show_id = ?)",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(entry_id)
                    .execute(&pool)
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
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                        .bind(&new_rel_path)
                        .bind(&old_cache_abs)
                        .bind(&new_cache_abs)
                        .bind(&folder_path)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            "music" => {
                let entry_row: Option<(String,)> = sqlx::query_as(
                    "SELECT folder_path FROM artists WHERE id = ?",
                )
                .bind(entry_id)
                .fetch_optional(&pool)
                .await
                .map_err(|e| e.to_string())?;

                let (folder_path,) = entry_row.ok_or("Entry not found")?;
                let lib_base = PathBuf::from(resolve_entry_root(&lib_paths, &folder_path).ok_or("Could not find entry on disk")?);
                let old_full_path = lib_base.join(&folder_path);

                let safe_title = sanitize_filename(&new_title);

                let new_full_path = old_full_path.parent().ok_or("Invalid folder path")?.join(&safe_title);

                if old_full_path != new_full_path {
                    if new_full_path.exists() {
                        pool.close().await;
                        return Err(format!("A folder named '{}' already exists", safe_title));
                    }

                    std::fs::rename(&old_full_path, &new_full_path)
                        .map_err(|e| format!("Failed to rename folder: {}", e))?;

                    let new_rel_path = new_full_path
                        .strip_prefix(&lib_base)
                        .unwrap_or(&new_full_path)
                        .to_string_lossy()
                        .to_string();

                    let old_rel_prefix = format!("{}\\", folder_path);
                    let new_rel_prefix = format!("{}\\", new_rel_path);

                    // Update artist folder_path
                    sqlx::query("UPDATE artists SET folder_path = ? WHERE id = ?")
                        .bind(&new_rel_path)
                        .bind(entry_id)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;

                    // Update album folder_paths
                    sqlx::query(
                        "UPDATE albums SET folder_path = ? || SUBSTR(folder_path, ?) WHERE artist_id = ?",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(entry_id)
                    .execute(&pool)
                    .await
                    .map_err(|e| e.to_string())?;

                    // Update song file_paths
                    sqlx::query(
                        "UPDATE songs SET file_path = ? || SUBSTR(file_path, ?) WHERE album_id IN (SELECT id FROM albums WHERE artist_id = ?)",
                    )
                    .bind(&new_rel_prefix)
                    .bind((old_rel_prefix.len() + 1) as i32)
                    .bind(entry_id)
                    .execute(&pool)
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
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    let old_rel_prefix_ci = format!("{}\\", folder_path);
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ? || SUBSTR(entry_folder_path, ?), cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path LIKE ?")
                        .bind(&format!("{}\\", new_rel_path))
                        .bind((old_rel_prefix_ci.len() + 1) as i32)
                        .bind(&old_cache_abs_prefix)
                        .bind(&new_cache_abs_prefix)
                        .bind(format!("{}%", old_rel_prefix_ci))
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            _ => {}
        }
    }

    let sort_title = generate_sort_title(&new_title, "en");

    match format.as_str() {
        "video" => {
            sqlx::query("UPDATE media_entry SET title = ?, sort_title = ? WHERE id = ?")
                .bind(&new_title)
                .bind(&sort_title)
                .bind(entry_id)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        "tv" => {
            sqlx::query("UPDATE shows SET title = ?, sort_title = ? WHERE id = ?")
                .bind(&new_title)
                .bind(&sort_title)
                .bind(entry_id)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        "music" => {
            sqlx::query("UPDATE artists SET name = ?, sort_name = ? WHERE id = ?")
                .bind(&new_title)
                .bind(&sort_title)
                .bind(entry_id)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        _ => {
            sqlx::query("UPDATE movie SET title = ?, sort_title = ? WHERE id = ?")
                .bind(&new_title)
                .bind(&sort_title)
                .bind(entry_id)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    pool.close().await;
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
fn move_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }
    match std::fs::rename(src, dst) {
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
    let row: Option<(String, i32, String, i32, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, managed, format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, managed, format) = row.ok_or("Library not found")?;
    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    match format.as_str() {
        "video" => {
            // Get the entry being moved
            let entry_row: (String, Option<i64>) = sqlx::query_as(
                "SELECT folder_path, parent_id FROM media_entry WHERE id = ?",
            )
            .bind(entry_id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Entry not found")?;

            let (old_folder_path, old_parent_id) = entry_row;

            // No-op if already in the target parent
            if old_parent_id == new_parent_id {
                pool.close().await;
                return Ok(());
            }

            // Prevent moving into self or a descendant
            if let Some(target_id) = new_parent_id {
                if target_id == entry_id {
                    pool.close().await;
                    return Err("Cannot move entry into itself".to_string());
                }
                // Walk up from target to root, ensure we don't hit entry_id
                let mut check_id = Some(target_id);
                while let Some(cid) = check_id {
                    let parent: Option<(Option<i64>,)> = sqlx::query_as(
                        "SELECT parent_id FROM media_entry WHERE id = ?",
                    )
                    .bind(cid)
                    .fetch_optional(&pool)
                    .await
                    .map_err(|e| e.to_string())?;
                    match parent {
                        Some((Some(pid),)) => {
                            if pid == entry_id {
                                pool.close().await;
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
                    "SELECT folder_path FROM media_entry WHERE id = ?",
                )
                .bind(target_id)
                .fetch_optional(&pool)
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
                        pool.close().await;
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
                let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

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

                // Update selected_cover for this entry
                sqlx::query("UPDATE media_entry SET selected_cover = REPLACE(selected_cover, ?, ?) WHERE selected_cover LIKE ? AND id = ?")
                    .bind(&old_cache_abs)
                    .bind(&new_cache_abs)
                    .bind(format!("{}%", old_cache_abs))
                    .bind(entry_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                // Update selected_cover for child entries
                sqlx::query("UPDATE media_entry SET selected_cover = REPLACE(selected_cover, ?, ?) WHERE selected_cover LIKE ? AND id != ?")
                    .bind(&old_cache_abs_prefix)
                    .bind(&new_cache_abs_prefix)
                    .bind(format!("{}%", old_cache_abs_prefix))
                    .bind(entry_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                // Determine sort_order for the moved entry
                let new_sort_order: i64 = if let Some(before_id) = insert_before_id {
                    let (before_order,): (i64,) = sqlx::query_as(
                        "SELECT sort_order FROM media_entry WHERE id = ?",
                    )
                    .bind(before_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("insert_before entry not found")?;

                    sqlx::query(
                        "UPDATE media_entry SET sort_order = sort_order + 1 WHERE parent_id IS ? AND sort_order >= ? AND id != ?",
                    )
                    .bind(new_parent_id)
                    .bind(before_order)
                    .bind(entry_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                    before_order
                } else {
                    let max_row: Option<(i64,)> = sqlx::query_as(
                        "SELECT MAX(sort_order) FROM media_entry WHERE parent_id IS ?",
                    )
                    .bind(new_parent_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    max_row.and_then(|r| Some(r.0 + 1)).unwrap_or(0)
                };

                // Update parent_id, folder_path, and sort_order
                sqlx::query("UPDATE media_entry SET parent_id = ?, folder_path = ?, sort_order = ? WHERE id = ?")
                    .bind(new_parent_id)
                    .bind(&new_folder_path)
                    .bind(new_sort_order)
                    .bind(entry_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;

                // Update child folder_paths
                sqlx::query(
                    "UPDATE media_entry SET folder_path = ? || SUBSTR(folder_path, ?) WHERE folder_path LIKE ? AND id != ?",
                )
                .bind(&new_rel_prefix)
                .bind((old_rel_prefix.len() + 1) as i32)
                .bind(format!("{}%", old_rel_prefix))
                .bind(entry_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;

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
                pool.close().await;
                return Err(e);
            }
        }
        _ => {
            pool.close().await;
            return Err("Move is only supported for video format libraries".to_string());
        }
    }

    pool.close().await;
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
    let row: Option<(String, i32, String, i32, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, managed, format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, managed, format) = row.ok_or("Library not found")?;
    if format != "video" {
        return Err("Collections are only supported for video libraries".to_string());
    }

    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let safe_name = sanitize_filename(&name);
    if safe_name.is_empty() {
        pool.close().await;
        return Err("Invalid collection name".to_string());
    }

    // Determine the parent folder path on disk
    let parent_folder = if let Some(pid) = parent_id {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT folder_path FROM media_entry WHERE id = ?",
        )
        .bind(pid)
        .fetch_optional(&pool)
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
            pool.close().await;
            return Err(format!("A folder named '{}' already exists", safe_name));
        }
        std::fs::create_dir_all(&full_path)
            .map_err(|e| format!("Failed to create folder: {}", e))?;
    }

    // Get the collection entry type id
    let collection_type_id: (i64,) =
        sqlx::query_as("SELECT id FROM media_entry_type WHERE name = 'collection'")
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;

    // Determine sort_order (append at end)
    let max_order: (i64,) = if parent_id.is_some() {
        sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM media_entry WHERE parent_id = ?")
            .bind(parent_id)
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?
    } else {
        sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM media_entry WHERE parent_id IS NULL")
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?
    };

    let sort_title = generate_sort_title(&name, "en");

    let result = sqlx::query(
        "INSERT INTO media_entry (parent_id, entry_type_id, title, folder_path, sort_title, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(parent_id)
    .bind(collection_type_id.0)
    .bind(&name)
    .bind(&rel_path)
    .bind(&sort_title)
    .bind(max_order.0 + 1)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    let entry_id = result.last_insert_rowid();
    sqlx::query("INSERT INTO collection (id) VALUES (?)")
        .bind(entry_id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    pool.close().await;
    Ok(())
}

#[tauri::command]
pub async fn set_cover(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    cover_path: Option<String>,
) -> Result<(), String> {
    let row: Option<(String, i32, String, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, format) = row.ok_or("Library not found")?;
    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let table = match format.as_str() {
        "video" => "media_entry",
        "tv" => "shows",
        "music" => "artists",
        _ => "movie",
    };

    let q = format!("UPDATE {} SET selected_cover = ? WHERE id = ?", table);
    sqlx::query(&q)
        .bind(&cover_path)
        .bind(entry_id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    pool.close().await;
    Ok(())
}

#[tauri::command]
pub async fn delete_entry(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    delete_from_disk: bool,
) -> Result<(), String> {
    let row: Option<(String, i32, String, i32)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, managed FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, managed) = row.ok_or("Library not found")?;
    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    // Get the entry's folder_path
    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&pool)
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
    sqlx::query("DELETE FROM cached_images WHERE entry_folder_path = ? OR entry_folder_path LIKE ?")
        .bind(&folder_path)
        .bind(format!("{}\\%", folder_path))
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    // Delete from DB (CASCADE handles children, movie, collection, show tables)
    sqlx::query("DELETE FROM media_entry WHERE id = ?")
        .bind(entry_id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    pool.close().await;
    Ok(())
}

#[tauri::command]
pub async fn check_entry_has_files(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
) -> Result<bool, String> {
    let row: Option<(String, i32, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename) = row.ok_or("Library not found")?;
    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let entry_row: Option<(String,)> = sqlx::query_as(
        "SELECT folder_path FROM media_entry WHERE id = ?",
    )
    .bind(entry_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| e.to_string())?;

    let (folder_path,) = entry_row.ok_or("Entry not found")?;
    pool.close().await;

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
    let row: Option<(String, i32, String, String)> = sqlx::query_as(
        "SELECT paths, portable, db_filename, format FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (paths_json, portable, db_filename, format) = row.ok_or("Library not found")?;
    let lib_paths: Vec<String> = serde_json::from_str(&paths_json).unwrap_or_default();

    let db_path = if portable != 0 {
        PathBuf::from(&lib_paths[0]).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::connect_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let cache_base = state.app_data_dir.join("cache").join(&library_id);
    std::fs::create_dir_all(&cache_base).map_err(|e| e.to_string())?;

    let base_paths: Vec<PathBuf> = lib_paths.iter().map(|p| PathBuf::from(p)).collect();
    match format.as_str() {
        "video" => rescan_video_library(&app, &pool, &base_paths, &cache_base).await?,
        "tv" => rescan_tv_library(&app, &pool, &base_paths, &cache_base).await?,
        "music" => rescan_music_library(&app, &pool, &base_paths, &cache_base).await?,
        _ => rescan_movies_library(&app, &pool, &base_paths, &cache_base).await?,
    }

    pool.close().await;
    Ok(())
}

async fn rescan_video_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
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
        "SELECT id, folder_path, parent_id, entry_type_id FROM media_entry",
    )
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
        delete_cached_images_for_entry(pool, cache_base, rel_path).await?;
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
                    "SELECT id FROM media_entry WHERE folder_path = ?",
                )
                .bind(parent_path)
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
            sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM media_entry WHERE parent_id = ?")
                .bind(pid)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?
        } else {
            sqlx::query_as(
                "SELECT COALESCE(MAX(sort_order), -1) FROM media_entry WHERE parent_id IS NULL",
            )
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
        };
        let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

        if has_season && parent_id.is_none() {
            // TV show (only at root level)
            let result = sqlx::query(
                "INSERT INTO media_entry (parent_id, entry_type_id, title, folder_path, sort_title, sort_order, year) VALUES (NULL, ?, ?, ?, ?, ?, ?)",
            )
            .bind(show_type_id.0)
            .bind(&title)
            .bind(rel_path)
            .bind(&sort_title)
            .bind(sort_order)
            .bind(&year)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

            let entry_id = result.last_insert_rowid();
            sqlx::query("INSERT INTO show (id) VALUES (?)")
                .bind(entry_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

            cache_entry_images(pool, cache_base, base_path, rel_path)
                .await
                .map_err(|e| e.to_string())?;

            // Don't recurse into seasons here — they'll be handled in the season rescan below
        } else if !subdirs.is_empty() {
            // Collection
            let result = sqlx::query(
                "INSERT INTO media_entry (parent_id, entry_type_id, title, folder_path, sort_title, sort_order, year) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(parent_id)
            .bind(collection_type_id.0)
            .bind(&title)
            .bind(rel_path)
            .bind(&sort_title)
            .bind(sort_order)
            .bind(&year)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

            let entry_id = result.last_insert_rowid();
            sqlx::query("INSERT INTO collection (id) VALUES (?)")
                .bind(entry_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

            cache_entry_images(pool, cache_base, base_path, rel_path)
                .await
                .map_err(|e| e.to_string())?;
        } else {
            let has_video = std::fs::read_dir(&full_path)
                .map(|rd| rd.filter_map(|e| e.ok()).any(|e| is_media_file(&e.path(), VIDEO_EXTENSIONS)))
                .unwrap_or(false);

            if has_video {
                // Movie (leaf with video files)
                let result = sqlx::query(
                    "INSERT INTO media_entry (parent_id, entry_type_id, title, folder_path, sort_title, sort_order, year) VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(parent_id)
                .bind(movie_type_id.0)
                .bind(&title)
                .bind(rel_path)
                .bind(&sort_title)
                .bind(sort_order)
                .bind(&year)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

                let entry_id = result.last_insert_rowid();
                sqlx::query("INSERT INTO movie (id) VALUES (?)")
                    .bind(entry_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;

                cache_entry_images(pool, cache_base, base_path, rel_path)
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                // Empty folder → collection
                let result = sqlx::query(
                    "INSERT INTO media_entry (parent_id, entry_type_id, title, folder_path, sort_title, sort_order, year) VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(parent_id)
                .bind(collection_type_id.0)
                .bind(&title)
                .bind(rel_path)
                .bind(&sort_title)
                .bind(sort_order)
                .bind(&year)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

                let entry_id = result.last_insert_rowid();
                sqlx::query("INSERT INTO collection (id) VALUES (?)")
                    .bind(entry_id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;

                cache_entry_images(pool, cache_base, base_path, rel_path)
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
            sync_entry_images(pool, cache_base, base, rel_path).await?;
        }
    }

    // Rescan seasons/episodes for all shows
    let all_shows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT me.id, me.folder_path FROM media_entry me JOIN show s ON me.id = s.id",
    )
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

async fn rescan_movies_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    base_paths: &[PathBuf],
    cache_base: &Path,
) -> Result<(), String> {
    use std::collections::{HashSet, HashMap};

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

    let db_rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT id, folder_path, parent_id FROM movie",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let db_paths: HashSet<String> = db_rows.iter().map(|(_, p, _)| p.clone()).collect();

    let mut to_delete: Vec<(i64, String)> = db_rows
        .iter()
        .filter(|(_, p, _)| !disk_paths.contains(p))
        .map(|(id, p, _)| (*id, p.clone()))
        .collect();
    to_delete.sort_by(|a, b| {
        b.1.matches('\\').count().cmp(&a.1.matches('\\').count())
            .then_with(|| b.1.matches('/').count().cmp(&a.1.matches('/').count()))
    });

    for (id, rel_path) in &to_delete {
        delete_cached_images_for_entry(pool, cache_base, rel_path).await?;
        sqlx::query("DELETE FROM movie WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }

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

        let parent_rel = full_path
            .parent()
            .and_then(|p| p.strip_prefix(base_path).ok())
            .map(|p| p.to_string_lossy().to_string());

        let parent_id: Option<i64> = if let Some(ref parent_path) = parent_rel {
            if parent_path.is_empty() {
                None
            } else {
                let row: Option<(i64,)> = sqlx::query_as(
                    "SELECT id FROM movie WHERE folder_path = ?",
                )
                .bind(parent_path)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
                row.map(|(id,)| id)
            }
        } else {
            None
        };

        let has_subdirs = std::fs::read_dir(&full_path)
            .map(|rd| {
                rd.filter_map(|e| e.ok()).any(|e| is_scannable_dir(&e))
            })
            .unwrap_or(false);

        let max_order: Option<(i32,)> = if let Some(pid) = parent_id {
            sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM movie WHERE parent_id = ?")
                .bind(pid)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?
        } else {
            sqlx::query_as(
                "SELECT COALESCE(MAX(sort_order), -1) FROM movie WHERE parent_id IS NULL",
            )
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
        };
        let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

        let sort_title = generate_sort_title(&title, "en");

        sqlx::query(
            "INSERT INTO movie (title, year, folder_path, parent_id, is_collection, sort_order, sort_title) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&title)
        .bind(&year)
        .bind(rel_path)
        .bind(parent_id)
        .bind(has_subdirs as i32)
        .bind(sort_order)
        .bind(&sort_title)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        cache_entry_images(pool, cache_base, base_path, rel_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Sync cached images for existing entries
    let existing_paths: Vec<String> = db_rows
        .iter()
        .filter(|(_, p, _)| disk_paths.contains(p))
        .map(|(_, p, _)| p.clone())
        .collect();
    for rel_path in &existing_paths {
        if let Some(base) = path_to_base.get(rel_path).or_else(|| {
            base_paths.iter().find(|b| b.join(rel_path).exists())
        }) {
            sync_entry_images(pool, cache_base, base, rel_path).await?;
        }
    }

    // Update is_collection for existing entries
    let all_entries: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, folder_path FROM movie",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for (id, rel_path) in &all_entries {
        if let Some(base) = path_to_base.get(rel_path).or_else(|| {
            base_paths.iter().find(|b| b.join(rel_path).exists())
        }) {
            let full_path = base.join(rel_path);
            let has_subdirs = std::fs::read_dir(&full_path)
                .map(|rd| {
                    rd.filter_map(|e| e.ok()).any(|e| is_scannable_dir(&e))
                })
                .unwrap_or(false);

            sqlx::query("UPDATE movie SET is_collection = ? WHERE id = ?")
                .bind(has_subdirs as i32)
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

async fn rescan_tv_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    base_paths: &[PathBuf],
    cache_base: &Path,
) -> Result<(), String> {
    use std::collections::{HashSet, HashMap};

    // Level 1: Shows — collect from all bases
    let mut disk_shows: HashSet<String> = HashSet::new();
    let mut show_to_base: HashMap<String, PathBuf> = HashMap::new();
    for base_path in base_paths {
        for entry in std::fs::read_dir(base_path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if is_scannable_dir(&entry) {
                let rel = entry.path()
                    .strip_prefix(base_path)
                    .unwrap_or(&entry.path())
                    .to_string_lossy()
                    .to_string();
                show_to_base.insert(rel.clone(), base_path.clone());
                disk_shows.insert(rel);
            }
        }
    }

    let db_shows: Vec<(i64, String)> = sqlx::query_as("SELECT id, folder_path FROM shows")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Delete removed shows
    for (id, path) in &db_shows {
        if !disk_shows.contains(path) {
            delete_cached_images_for_entry(pool, cache_base, path).await?;
            sqlx::query("DELETE FROM shows WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    let existing_show_paths: HashSet<String> = db_shows.iter().map(|(_, p)| p.clone()).collect();

    // Add new shows
    for rel_path in &disk_shows {
        if existing_show_paths.contains(rel_path) {
            continue;
        }
        let base_path = show_to_base.get(rel_path).unwrap();
        let full_path = base_path.join(rel_path);
        let name = full_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let _ = app.emit("scan-progress", &name);
        let (title, year) = parse_folder_name(&name);
        let sort_title = generate_sort_title(&title, "en");

        let max_order: Option<(i32,)> =
            sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM shows")
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

        sqlx::query(
            "INSERT INTO shows (title, year, folder_path, sort_order, sort_title) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&title)
        .bind(&year)
        .bind(rel_path)
        .bind(sort_order)
        .bind(&sort_title)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        cache_entry_images(pool, cache_base, base_path, rel_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Sync cached images for existing shows
    for rel_path in &existing_show_paths {
        if disk_shows.contains(rel_path) {
            if let Some(base) = show_to_base.get(rel_path).or_else(|| {
                base_paths.iter().find(|b| b.join(rel_path).exists())
            }) {
                sync_entry_images(pool, cache_base, base, rel_path).await?;
            }
        }
    }

    // Level 2 & 3: Seasons and episodes for each show
    let all_shows: Vec<(i64, String)> = sqlx::query_as("SELECT id, folder_path FROM shows")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    for (show_id, show_rel) in &all_shows {
        let show_base = show_to_base.get(show_rel)
            .or_else(|| base_paths.iter().find(|b| b.join(show_rel).exists()))
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
            sqlx::query_as("SELECT id, folder_path FROM seasons WHERE show_id = ?")
                .bind(show_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;

        for (id, path) in &db_seasons {
            if !disk_seasons.contains(path) {
                sqlx::query("DELETE FROM seasons WHERE id = ?")
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }

        let existing_season_paths: HashSet<String> = db_seasons.iter().map(|(_, p)| p.clone()).collect();

        for rel_path in &disk_seasons {
            if existing_season_paths.contains(rel_path) {
                continue;
            }
            let full_path = show_base.join(rel_path);
            let name = full_path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let (season_title, season_number) = parse_season_folder_name(&name);

            let max_order: Option<(i32,)> =
                sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM seasons WHERE show_id = ?")
                    .bind(show_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

            sqlx::query(
                "INSERT INTO seasons (show_id, title, season_number, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
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
            sqlx::query_as("SELECT id, folder_path FROM seasons WHERE show_id = ?")
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
                sqlx::query_as("SELECT id, file_path FROM episodes WHERE season_id = ?")
                    .bind(season_id)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| e.to_string())?;

            for (id, path) in &db_episodes {
                if !disk_episodes.contains(path) {
                    sqlx::query("DELETE FROM episodes WHERE id = ?")
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
                    sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM episodes WHERE season_id = ?")
                        .bind(season_id)
                        .fetch_optional(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

                sqlx::query(
                    "INSERT INTO episodes (season_id, title, episode_number, file_path, sort_order) VALUES (?, ?, ?, ?, ?)",
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
    base_paths: &[PathBuf],
    cache_base: &Path,
) -> Result<(), String> {
    use std::collections::{HashSet, HashMap};

    // Level 1: Artists — collect from all bases
    let mut disk_artists: HashSet<String> = HashSet::new();
    let mut artist_to_base: HashMap<String, PathBuf> = HashMap::new();
    for base_path in base_paths {
        for entry in std::fs::read_dir(base_path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if is_scannable_dir(&entry) {
                let rel = entry.path()
                    .strip_prefix(base_path)
                    .unwrap_or(&entry.path())
                    .to_string_lossy()
                    .to_string();
                artist_to_base.insert(rel.clone(), base_path.clone());
                disk_artists.insert(rel);
            }
        }
    }

    let db_artists: Vec<(i64, String)> = sqlx::query_as("SELECT id, folder_path FROM artists")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    for (id, path) in &db_artists {
        if !disk_artists.contains(path) {
            delete_cached_images_for_entry(pool, cache_base, path).await?;
            sqlx::query("DELETE FROM artists WHERE id = ?")
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    let existing_artist_paths: HashSet<String> = db_artists.iter().map(|(_, p)| p.clone()).collect();

    for rel_path in &disk_artists {
        if existing_artist_paths.contains(rel_path) {
            continue;
        }
        let base_path = artist_to_base.get(rel_path).unwrap();
        let full_path = base_path.join(rel_path);
        let name = full_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let _ = app.emit("scan-progress", &name);
        let sort_name = generate_sort_title(&name, "en");

        let max_order: Option<(i32,)> =
            sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM artists")
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

        sqlx::query(
            "INSERT INTO artists (name, folder_path, sort_order, sort_name) VALUES (?, ?, ?, ?)",
        )
        .bind(&name)
        .bind(rel_path)
        .bind(sort_order)
        .bind(&sort_name)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        cache_entry_images(pool, cache_base, base_path, rel_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Sync cached images for existing artists
    for rel_path in &existing_artist_paths {
        if disk_artists.contains(rel_path) {
            if let Some(base) = artist_to_base.get(rel_path).or_else(|| {
                base_paths.iter().find(|b| b.join(rel_path).exists())
            }) {
                sync_entry_images(pool, cache_base, base, rel_path).await?;
            }
        }
    }

    // Level 2 & 3: Albums and songs for each artist
    let all_artists: Vec<(i64, String)> = sqlx::query_as("SELECT id, folder_path FROM artists")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    for (artist_id, artist_rel) in &all_artists {
        let artist_base = artist_to_base.get(artist_rel)
            .or_else(|| base_paths.iter().find(|b| b.join(artist_rel).exists()))
            .ok_or_else(|| format!("Cannot resolve base path for artist: {}", artist_rel))?;
        let artist_path = artist_base.join(artist_rel);

        let disk_albums: HashSet<String> = std::fs::read_dir(&artist_path)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| is_scannable_dir(e))
            .map(|e| {
                e.path()
                    .strip_prefix(artist_base)
                    .unwrap_or(&e.path())
                    .to_string_lossy()
                    .to_string()
            })
            .collect();

        let db_albums: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, folder_path FROM albums WHERE artist_id = ?")
                .bind(artist_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;

        for (id, path) in &db_albums {
            if !disk_albums.contains(path) {
                delete_cached_images_for_entry(pool, cache_base, path).await?;
                sqlx::query("DELETE FROM albums WHERE id = ?")
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }

        let existing_album_paths: HashSet<String> = db_albums.iter().map(|(_, p)| p.clone()).collect();

        for rel_path in &disk_albums {
            if existing_album_paths.contains(rel_path) {
                continue;
            }
            let full_path = artist_base.join(rel_path);
            let name = full_path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let (album_title, album_year) = parse_folder_name(&name);
            let album_sort_title = generate_sort_title(&album_title, "en");

            let max_order: Option<(i32,)> =
                sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM albums WHERE artist_id = ?")
                    .bind(artist_id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

            sqlx::query(
                "INSERT INTO albums (artist_id, title, year, folder_path, sort_order, sort_title) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(artist_id)
            .bind(&album_title)
            .bind(&album_year)
            .bind(rel_path)
            .bind(sort_order)
            .bind(&album_sort_title)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

            cache_entry_images(pool, cache_base, artist_base, rel_path)
                .await
                .map_err(|e| e.to_string())?;
        }

        // Sync cached images for existing albums
        for rel_path in &existing_album_paths {
            if disk_albums.contains(rel_path) {
                sync_entry_images(pool, cache_base, artist_base, rel_path).await?;
            }
        }

        // Songs for each album
        let all_albums: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, folder_path FROM albums WHERE artist_id = ?")
                .bind(artist_id)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;

        for (album_id, album_rel) in &all_albums {
            let album_path = artist_base.join(album_rel);

            let disk_songs: HashSet<String> = std::fs::read_dir(&album_path)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .filter(|e| is_media_file(&e.path(), AUDIO_EXTENSIONS))
                .map(|e| {
                    e.path()
                        .strip_prefix(artist_base)
                        .unwrap_or(&e.path())
                        .to_string_lossy()
                        .to_string()
                })
                .collect();

            let db_songs: Vec<(i64, String)> =
                sqlx::query_as("SELECT id, file_path FROM songs WHERE album_id = ?")
                    .bind(album_id)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| e.to_string())?;

            for (id, path) in &db_songs {
                if !disk_songs.contains(path) {
                    sqlx::query("DELETE FROM songs WHERE id = ?")
                        .bind(id)
                        .execute(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }

            let existing_song_paths: HashSet<String> = db_songs.iter().map(|(_, p)| p.clone()).collect();

            for rel_path in &disk_songs {
                if existing_song_paths.contains(rel_path) {
                    continue;
                }
                let file_name = std::path::Path::new(rel_path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let (song_title, track_number) = parse_song_filename(&file_name);

                let max_order: Option<(i32,)> =
                    sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM songs WHERE album_id = ?")
                        .bind(album_id)
                        .fetch_optional(pool)
                        .await
                        .map_err(|e| e.to_string())?;
                let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

                sqlx::query(
                    "INSERT INTO songs (album_id, title, track_number, file_path, sort_order) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(album_id)
                .bind(&song_title)
                .bind(track_number)
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
    entry_folder_path: &str,
    image_type: &str, // "cover" or "background"
    images: &[(String, String)], // (source_filename, cached_path)
) -> Result<(), sqlx::Error> {
    for (filename, cached_path) in images {
        sqlx::query(
            "INSERT OR REPLACE INTO cached_images (entry_folder_path, image_type, source_filename, cached_path) VALUES (?, ?, ?, ?)",
        )
        .bind(entry_folder_path)
        .bind(image_type)
        .bind(filename)
        .bind(cached_path)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn get_all_cached_covers(pool: &sqlx::SqlitePool) -> Result<HashMap<String, Vec<String>>, sqlx::Error> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT entry_folder_path, cached_path FROM cached_images WHERE image_type = 'cover' ORDER BY entry_folder_path, source_filename",
    )
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
    cache_base: &Path,
    library_base: &Path,
    entry_rel_path: &str,
) -> Result<(), sqlx::Error> {
    let covers = cache_images_for_entry(cache_base, library_base, entry_rel_path, "covers");
    insert_cached_images(pool, entry_rel_path, "cover", &covers).await?;
    let backgrounds = cache_images_for_entry(cache_base, library_base, entry_rel_path, "backgrounds");
    insert_cached_images(pool, entry_rel_path, "background", &backgrounds).await?;
    Ok(())
}

/// Diff-aware sync for rescan: add new images, remove deleted ones, skip unchanged
async fn sync_cached_images_for_entry(
    pool: &sqlx::SqlitePool,
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
        "SELECT source_filename, cached_path FROM cached_images WHERE entry_folder_path = ? AND image_type = ?",
    )
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
                "DELETE FROM cached_images WHERE entry_folder_path = ? AND image_type = ? AND source_filename = ?",
            )
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
                    "INSERT OR REPLACE INTO cached_images (entry_folder_path, image_type, source_filename, cached_path) VALUES (?, ?, ?, ?)",
                )
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
    cache_base: &Path,
    library_base: &Path,
    entry_rel_path: &str,
) -> Result<(), String> {
    sync_cached_images_for_entry(pool, cache_base, library_base, entry_rel_path, "covers", "cover").await?;
    sync_cached_images_for_entry(pool, cache_base, library_base, entry_rel_path, "backgrounds", "background").await?;
    Ok(())
}

/// Delete cached images for a specific entry
async fn delete_cached_images_for_entry(
    pool: &sqlx::SqlitePool,
    cache_base: &Path,
    entry_rel_path: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM cached_images WHERE entry_folder_path = ?")
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

async fn scan_tv_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    base_path: &PathBuf,
    cache_base: &Path,
    cancel: &AtomicBool,
) -> Result<(), sqlx::Error> {
    // Level 1: Shows
    let mut show_dirs: Vec<_> = std::fs::read_dir(base_path)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        .filter_map(|e| e.ok())
        .filter(|e| is_scannable_dir(e))
        .collect();
    show_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for (i, show_entry) in show_dirs.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(sqlx::Error::Protocol("Library creation cancelled".to_string()));
        }
        let show_path = show_entry.path();
        let show_name = show_entry.file_name().to_string_lossy().to_string();
        let _ = app.emit("scan-progress", &show_name);

        let (title, year) = parse_folder_name(&show_name);
        let sort_title = generate_sort_title(&title, "en");
        let rel_path = show_path
            .strip_prefix(base_path)
            .unwrap_or(&show_path)
            .to_string_lossy()
            .to_string();

        let result = sqlx::query(
            "INSERT INTO shows (title, year, folder_path, sort_order, sort_title) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&title)
        .bind(&year)
        .bind(&rel_path)
        .bind(i as i32)
        .bind(&sort_title)
        .execute(pool)
        .await?;

        let show_id = result.last_insert_rowid();

        cache_entry_images(pool, cache_base, base_path, &rel_path).await?;

        // Level 2: Seasons
        let mut season_dirs: Vec<_> = std::fs::read_dir(&show_path)
            .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
            .filter_map(|e| e.ok())
            .filter(|e| is_scannable_dir(e))
            .collect();

        // Sort by season number if parseable, else alphabetical
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
                "INSERT INTO seasons (show_id, title, season_number, folder_path, sort_order) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(show_id)
            .bind(&season_title)
            .bind(season_number)
            .bind(&season_rel)
            .bind(j as i32)
            .execute(pool)
            .await?;

            let season_id = result.last_insert_rowid();

            // Level 3: Episodes (files)
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
                    "INSERT INTO episodes (season_id, title, episode_number, file_path, sort_order) VALUES (?, ?, ?, ?, ?)",
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
    }

    Ok(())
}

async fn scan_music_library(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    base_path: &PathBuf,
    cache_base: &Path,
    cancel: &AtomicBool,
) -> Result<(), sqlx::Error> {
    // Level 1: Artists
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

        let sort_name = generate_sort_title(&artist_name, "en");
        let rel_path = artist_path
            .strip_prefix(base_path)
            .unwrap_or(&artist_path)
            .to_string_lossy()
            .to_string();

        let result = sqlx::query(
            "INSERT INTO artists (name, folder_path, sort_order, sort_name) VALUES (?, ?, ?, ?)",
        )
        .bind(&artist_name)
        .bind(&rel_path)
        .bind(i as i32)
        .bind(&sort_name)
        .execute(pool)
        .await?;

        let artist_id = result.last_insert_rowid();

        cache_entry_images(pool, cache_base, base_path, &rel_path).await?;

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

            let result = sqlx::query(
                "INSERT INTO albums (artist_id, title, year, folder_path, sort_order, sort_title) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(artist_id)
            .bind(&album_title)
            .bind(&album_year)
            .bind(&album_rel)
            .bind(j as i32)
            .bind(&album_sort_title)
            .execute(pool)
            .await?;

            let album_id = result.last_insert_rowid();

            cache_entry_images(pool, cache_base, base_path, &album_rel).await?;

            // Level 3: Songs (files)
            let mut song_files: Vec<_> = std::fs::read_dir(&album_path)
                .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
                .filter_map(|e| e.ok())
                .filter(|e| is_media_file(&e.path(), AUDIO_EXTENSIONS))
                .collect();

            song_files.sort_by(|a, b| {
                let (_, a_num) = parse_song_filename(&a.file_name().to_string_lossy());
                let (_, b_num) = parse_song_filename(&b.file_name().to_string_lossy());
                match (a_num, b_num) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    _ => a.file_name().cmp(&b.file_name()),
                }
            });

            for (k, song_entry) in song_files.iter().enumerate() {
                let song_name = song_entry.file_name().to_string_lossy().to_string();
                let (song_title, track_number) = parse_song_filename(&song_name);
                let song_rel = song_entry
                    .path()
                    .strip_prefix(base_path)
                    .unwrap_or(&song_entry.path())
                    .to_string_lossy()
                    .to_string();

                sqlx::query(
                    "INSERT INTO songs (album_id, title, track_number, file_path, sort_order) VALUES (?, ?, ?, ?, ?)",
                )
                .bind(album_id)
                .bind(&song_title)
                .bind(track_number)
                .bind(&song_rel)
                .bind(k as i32)
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

        let (title, year) = parse_folder_name(&name);
        let sort_title = generate_sort_title(&title, "en");
        let rel_path = path
            .strip_prefix(base_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        if has_season {
            // TV show
            let result = sqlx::query(
                "INSERT INTO media_entry (parent_id, entry_type_id, title, folder_path, sort_title, sort_order, year) VALUES (NULL, ?, ?, ?, ?, ?, ?)",
            )
            .bind(show_type_id.0)
            .bind(&title)
            .bind(&rel_path)
            .bind(&sort_title)
            .bind(i as i32)
            .bind(&year)
            .execute(pool)
            .await?;

            let entry_id = result.last_insert_rowid();
            sqlx::query("INSERT INTO show (id) VALUES (?)")
                .bind(entry_id)
                .execute(pool)
                .await?;

            cache_entry_images(pool, cache_base, base_path, &rel_path).await?;

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
            "INSERT INTO media_entry (parent_id, entry_type_id, title, folder_path, sort_title, sort_order, year) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(parent_id)
        .bind(movie_type_id)
        .bind(&title)
        .bind(&rel_path)
        .bind(&sort_title)
        .bind(sort_order)
        .bind(&year)
        .execute(pool)
        .await?;

        let entry_id = result.last_insert_rowid();
        sqlx::query("INSERT INTO movie (id) VALUES (?)")
            .bind(entry_id)
            .execute(pool)
            .await?;

        cache_entry_images(pool, cache_base, base_path, &rel_path).await?;
    } else {
        // Collection (has subdirs, or empty folder)
        let result = sqlx::query(
            "INSERT INTO media_entry (parent_id, entry_type_id, title, folder_path, sort_title, sort_order, year) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(parent_id)
        .bind(collection_type_id)
        .bind(&title)
        .bind(&rel_path)
        .bind(&sort_title)
        .bind(sort_order)
        .bind(&year)
        .execute(pool)
        .await?;

        let entry_id = result.last_insert_rowid();
        sqlx::query("INSERT INTO collection (id) VALUES (?)")
            .bind(entry_id)
            .execute(pool)
            .await?;

        cache_entry_images(pool, cache_base, base_path, &rel_path).await?;

        let mut child_dirs: Vec<_> = subdirs;
        child_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

        for (j, child_entry) in child_dirs.iter().enumerate() {
            let child_path = child_entry.path();
            scan_video_dir(
                app,
                pool,
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

async fn scan_folder(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    base_path: &PathBuf,
    parent_id: Option<i64>,
    cache_base: &Path,
    cancel: &AtomicBool,
) -> Result<(), sqlx::Error> {
    scan_dir(app, pool, base_path, base_path, parent_id, cache_base, cancel).await
}

#[async_recursion::async_recursion]
async fn scan_dir(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    base_path: &PathBuf,
    dir: &PathBuf,
    parent_id: Option<i64>,
    cache_base: &Path,
    cancel: &AtomicBool,
) -> Result<(), sqlx::Error> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            e.path().is_dir() && name != "covers" && name != "backgrounds" && name != "extras" && !name.starts_with('.')
        })
        .collect();

    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for (i, entry) in entries.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err(sqlx::Error::Protocol("Library creation cancelled".to_string()));
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        let _ = app.emit("scan-progress", &name);

        let has_subdirs = std::fs::read_dir(&path)
            .map(|rd| {
                rd.filter_map(|e| e.ok()).any(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    e.path().is_dir() && n != "covers" && n != "backgrounds" && n != "extras" && !n.starts_with('.')
                })
            })
            .unwrap_or(false);

        let (title, year) = parse_folder_name(&name);

        let rel_path = path
            .strip_prefix(base_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        let sort_title = generate_sort_title(&title, "en");

        let result = sqlx::query(
            "INSERT INTO movie (title, year, folder_path, parent_id, is_collection, sort_order, sort_title) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&title)
        .bind(&year)
        .bind(&rel_path)
        .bind(parent_id)
        .bind(has_subdirs as i32)
        .bind(i as i32)
        .bind(&sort_title)
        .execute(pool)
        .await?;

        let new_id = result.last_insert_rowid();

        cache_entry_images(pool, cache_base, base_path, &rel_path).await?;

        if has_subdirs {
            scan_dir(app, pool, base_path, &path, Some(new_id), cache_base, cancel).await?;
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
