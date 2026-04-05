use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::Emitter;

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
            return title[article.len()..].to_string();
        }
    }
    title.to_string()
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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EntriesResponse {
    pub entries: Vec<MediaEntry>,
    pub sort_mode: String,
    pub format: String,
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
pub async fn create_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    paths: Vec<String>,
    format: String,
    portable: bool,
    managed: bool,
) -> Result<Library, String> {
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
        },
    );

    let pool = crate::db::create_library_pool(&db_path, &format)
        .await
        .map_err(|e| e.to_string())?;

    let cache_base = state.app_data_dir.join("cache").join(&id);
    std::fs::create_dir_all(&cache_base).map_err(|e| e.to_string())?;

    match format.as_str() {
        "video" => {
            sqlx::query("DELETE FROM media_entry").execute(&pool).await.map_err(|e| e.to_string())?;
            for p in &paths {
                let lib_path = PathBuf::from(p);
                scan_video_library(&app, &pool, &lib_path, &cache_base).await.map_err(|e| e.to_string())?;
            }
        }
        "tv" => {
            sqlx::query("DELETE FROM shows").execute(&pool).await.map_err(|e| e.to_string())?;
            for p in &paths {
                let lib_path = PathBuf::from(p);
                scan_tv_library(&app, &pool, &lib_path, &cache_base).await.map_err(|e| e.to_string())?;
            }
        }
        "music" => {
            sqlx::query("DELETE FROM artists").execute(&pool).await.map_err(|e| e.to_string())?;
            for p in &paths {
                let lib_path = PathBuf::from(p);
                scan_music_library(&app, &pool, &lib_path, &cache_base).await.map_err(|e| e.to_string())?;
            }
        }
        _ => {
            sqlx::query("DELETE FROM movie").execute(&pool).await.map_err(|e| e.to_string())?;
            for p in &paths {
                let lib_path = PathBuf::from(p);
                scan_folder(&app, &pool, &lib_path, None, &cache_base).await.map_err(|e| e.to_string())?;
            }
        }
    }

    pool.close().await;

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
    };

    sqlx::query(
        "INSERT INTO libraries (id, name, paths, format, portable, db_filename, default_sort_mode, managed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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

    Ok(library)
}

#[tauri::command]
pub async fn get_libraries(state: tauri::State<'_, AppState>) -> Result<Vec<Library>, String> {
    let rows: Vec<(String, String, String, String, i32, String, String, i32)> = sqlx::query_as(
        "SELECT id, name, paths, format, portable, db_filename, default_sort_mode, managed FROM libraries ORDER BY name",
    )
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, name, paths_json, format, portable, db_filename, default_sort_mode, managed)| Library {
            id,
            name,
            paths: serde_json::from_str(&paths_json).unwrap_or_default(),
            format,
            portable: portable != 0,
            db_filename,
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

    delete_cache_for_library(&state.app_data_dir, &library_id);

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
                "year" => "ORDER BY me.year ASC, me.sort_title ASC",
                "custom" => "ORDER BY me.sort_order ASC, me.sort_title ASC",
                _ => "ORDER BY me.sort_title ASC",
            };

            let query_str = match parent_id {
                Some(_) => format!(
                    "SELECT me.id, me.title, me.year, me.end_year, me.folder_path, me.parent_id, met.name as entry_type, me.selected_cover FROM media_entry me JOIN media_entry_type met ON me.entry_type_id = met.id WHERE me.parent_id = ? {}",
                    order_clause
                ),
                None => format!(
                    "SELECT me.id, me.title, me.year, me.end_year, me.folder_path, me.parent_id, met.name as entry_type, me.selected_cover FROM media_entry me JOIN media_entry_type met ON me.entry_type_id = met.id WHERE me.parent_id IS NULL {}",
                    order_clause
                ),
            };

            let rows: Vec<(i64, String, Option<String>, Option<String>, String, Option<i64>, String, Option<String>)> = match parent_id {
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
                .map(|(id, title, year, end_year, folder_path, parent_id, entry_type, selected_cover)| {
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
                "year" => "ORDER BY year ASC, sort_title ASC",
                "custom" => "ORDER BY sort_order ASC, sort_title ASC",
                _ => "ORDER BY sort_title ASC",
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
                "custom" => "ORDER BY sort_order ASC, sort_name ASC",
                _ => "ORDER BY sort_name ASC",
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
                "year" => "ORDER BY year ASC, sort_title ASC",
                "custom" => "ORDER BY sort_order ASC, sort_title ASC",
                _ => "ORDER BY sort_title ASC",
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
                    ORDER BY me.sort_title ASC",
                None => "\
                    SELECT me.id, me.title, me.year, me.end_year, me.folder_path, me.parent_id, met.name as entry_type, me.selected_cover \
                    FROM media_entry me \
                    JOIN media_entry_type met ON me.entry_type_id = met.id \
                    WHERE me.title LIKE ? \
                    ORDER BY me.sort_title ASC",
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
                    MediaEntry { id, title, year, end_year, folder_path, parent_id, entry_type, covers, selected_cover }
                })
                .collect()
        }
        "tv" => {
            let rows: Vec<(i64, String, Option<String>, String, Option<String>)> =
                sqlx::query_as(
                    "SELECT id, title, year, folder_path, selected_cover FROM shows WHERE title LIKE ? ORDER BY sort_title ASC",
                )
                .bind(&like_pattern)
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;

            rows.into_iter()
                .map(|(id, title, year, folder_path, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry { id, title, year, end_year: None, folder_path, parent_id: None, entry_type: "show".to_string(), covers, selected_cover }
                })
                .collect()
        }
        "music" => {
            let rows: Vec<(i64, String, String, Option<String>)> =
                sqlx::query_as(
                    "SELECT id, name, folder_path, selected_cover FROM artists WHERE name LIKE ? ORDER BY sort_name ASC",
                )
                .bind(&like_pattern)
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;

            rows.into_iter()
                .map(|(id, name, folder_path, selected_cover)| {
                    let covers = covers_map.remove(&folder_path).unwrap_or_default();
                    MediaEntry { id, title: name, year: None, end_year: None, folder_path, parent_id: None, entry_type: "artist".to_string(), covers, selected_cover }
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
                    ORDER BY sort_title ASC",
                None => "\
                    SELECT id, title, year, folder_path, parent_id, is_collection, selected_cover \
                    FROM movie WHERE title LIKE ? ORDER BY sort_title ASC",
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
                        covers, selected_cover,
                    }
                })
                .collect()
        }
    };

    pool.close().await;
    Ok(entries)
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
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                        .bind(&new_rel_path)
                        .bind(folder_path.replace('/', "\\"))
                        .bind(new_rel_path.replace('/', "\\"))
                        .bind(&folder_path)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    let old_prefix_ci = format!("{}\\", folder_path);
                    let new_prefix_ci = format!("{}\\", new_rel_path);
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ? || SUBSTR(entry_folder_path, ?), cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path LIKE ?")
                        .bind(&new_prefix_ci)
                        .bind((old_prefix_ci.len() + 1) as i32)
                        .bind(&old_prefix_ci)
                        .bind(&new_prefix_ci)
                        .bind(format!("{}%", old_prefix_ci))
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
                    // Update this entry's cached_images
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                        .bind(&new_rel_path)
                        .bind(folder_path.replace('/', "\\"))
                        .bind(new_rel_path.replace('/', "\\"))
                        .bind(&folder_path)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    // Update child entries' cached_images (movies can nest)
                    let old_prefix_ci = format!("{}\\", folder_path);
                    let new_prefix_ci = format!("{}\\", new_rel_path);
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ? || SUBSTR(entry_folder_path, ?), cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path LIKE ?")
                        .bind(&new_prefix_ci)
                        .bind((old_prefix_ci.len() + 1) as i32)
                        .bind(&old_prefix_ci)
                        .bind(&new_prefix_ci)
                        .bind(format!("{}%", old_prefix_ci))
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
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                        .bind(&new_rel_path)
                        .bind(&folder_path)
                        .bind(&new_rel_path)
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
                    // Update this entry + child album entries
                    let old_prefix_ci = format!("{}\\", folder_path);
                    let new_prefix_ci = format!("{}\\", new_rel_path);
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ?, cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path = ?")
                        .bind(&new_rel_path)
                        .bind(&folder_path)
                        .bind(&new_rel_path)
                        .bind(&folder_path)
                        .execute(&pool)
                        .await
                        .map_err(|e| e.to_string())?;
                    sqlx::query("UPDATE cached_images SET entry_folder_path = ? || SUBSTR(entry_folder_path, ?), cached_path = REPLACE(cached_path, ?, ?) WHERE entry_folder_path LIKE ?")
                        .bind(&new_prefix_ci)
                        .bind((old_prefix_ci.len() + 1) as i32)
                        .bind(&old_prefix_ci)
                        .bind(&new_prefix_ci)
                        .bind(format!("{}%", old_prefix_ci))
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
            // Movie (leaf)
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
) -> Result<(), sqlx::Error> {
    // Level 1: Shows
    let mut show_dirs: Vec<_> = std::fs::read_dir(base_path)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        .filter_map(|e| e.ok())
        .filter(|e| is_scannable_dir(e))
        .collect();
    show_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for (i, show_entry) in show_dirs.iter().enumerate() {
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
) -> Result<(), sqlx::Error> {
    // Level 1: Artists
    let mut artist_dirs: Vec<_> = std::fs::read_dir(base_path)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        .filter_map(|e| e.ok())
        .filter(|e| is_scannable_dir(e))
        .collect();
    artist_dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for (i, artist_entry) in artist_dirs.iter().enumerate() {
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
) -> Result<(), sqlx::Error> {
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

    if subdirs.is_empty() {
        // Movie (leaf node)
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
        // Collection
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
) -> Result<(), sqlx::Error> {
    scan_dir(app, pool, base_path, base_path, parent_id, cache_base).await
}

#[async_recursion::async_recursion]
async fn scan_dir(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    base_path: &PathBuf,
    dir: &PathBuf,
    parent_id: Option<i64>,
    cache_base: &Path,
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
            scan_dir(app, pool, base_path, &path, Some(new_id), cache_base).await?;
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

    // Try S01E01 pattern
    if let Some(pos) = lower.find('e') {
        if pos > 0 && lower[..pos].starts_with('s') {
            let after_e = &lower[pos + 1..];
            let digits: String = after_e.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                if let Ok(n) = digits.parse::<i32>() {
                    let title_start = pos + 1 + digits.len();
                    let title = stem[title_start..]
                        .trim_start_matches(|c: char| c == ' ' || c == '-' || c == '.')
                        .to_string();
                    let title = if title.is_empty() { stem.clone() } else { title };
                    return (title, Some(n));
                }
            }
        }
    }

    // Try E01 pattern
    if let Some(rest) = lower.strip_prefix('e') {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            if let Ok(n) = digits.parse::<i32>() {
                let title_start = 1 + digits.len();
                let title = stem[title_start..]
                    .trim_start_matches(|c: char| c == ' ' || c == '-' || c == '.')
                    .to_string();
                let title = if title.is_empty() { stem.clone() } else { title };
                return (title, Some(n));
            }
        }
    }

    // Try leading digits: "01 - Title"
    let digits: String = lower.chars().take_while(|c| c.is_ascii_digit()).collect();
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
