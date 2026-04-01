use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Library {
    pub id: String,
    pub name: String,
    pub path: String,
    pub format: String,
    pub portable: bool,
    pub db_filename: String,
    pub default_sort_mode: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaEntry {
    pub id: i64,
    pub title: String,
    pub year: Option<String>,
    pub folder_path: String,
    pub parent_id: Option<i64>,
    pub is_collection: bool,
    pub covers: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EntriesResponse {
    pub entries: Vec<MediaEntry>,
    pub sort_mode: String,
}

fn sanitize_filename(name: &str) -> String {
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
        PathBuf::from(&lib.path).join(".waverunner.db")
    } else {
        app_data_dir.join(&lib.db_filename)
    }
}

#[tauri::command]
pub async fn create_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    path: String,
    format: String,
    portable: bool,
) -> Result<Library, String> {
    let lib_path = PathBuf::from(&path);
    if !lib_path.exists() {
        return Err("Path does not exist".to_string());
    }

    let id = uuid_simple();

    let db_filename = if portable {
        ".waverunner.db".to_string()
    } else {
        let base = sanitize_filename(&name);
        unique_db_filename(&state.app_data_dir, &base)
    };

    let db_path = get_library_db_path(
        &state.app_data_dir,
        &Library {
            id: id.clone(),
            name: name.clone(),
            path: path.clone(),
            format: format.clone(),
            portable,
            db_filename: db_filename.clone(),
            default_sort_mode: "alpha".to_string(),
        },
    );

    let pool = crate::db::create_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM media")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    scan_folder(&app, &pool, &lib_path, None)
        .await
        .map_err(|e| e.to_string())?;

    pool.close().await;

    let library = Library {
        id: id.clone(),
        name: name.clone(),
        path: path.clone(),
        format: format.clone(),
        portable,
        db_filename: db_filename.clone(),
        default_sort_mode: "alpha".to_string(),
    };

    sqlx::query(
        "INSERT INTO libraries (id, name, path, format, portable, db_filename, default_sort_mode) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&library.id)
    .bind(&library.name)
    .bind(&library.path)
    .bind(&library.format)
    .bind(library.portable as i32)
    .bind(&library.db_filename)
    .bind(&library.default_sort_mode)
    .execute(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(library)
}

#[tauri::command]
pub async fn get_libraries(state: tauri::State<'_, AppState>) -> Result<Vec<Library>, String> {
    let rows: Vec<(String, String, String, String, i32, String, String)> = sqlx::query_as(
        "SELECT id, name, path, format, portable, db_filename, default_sort_mode FROM libraries ORDER BY name",
    )
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, name, path, format, portable, db_filename, default_sort_mode)| Library {
            id,
            name,
            path,
            format,
            portable: portable != 0,
            db_filename,
            default_sort_mode,
        })
        .collect())
}

#[tauri::command]
pub async fn delete_library(
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    let row: Option<(String, String, i32, String)> = sqlx::query_as(
        "SELECT id, path, portable, db_filename FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (_, path, portable, db_filename) = row.ok_or("Library not found")?;

    let db_path = if portable != 0 {
        PathBuf::from(&path).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let db_deleted = if db_path.exists() {
        std::fs::remove_file(&db_path).is_ok()
    } else {
        true
    };

    sqlx::query("DELETE FROM libraries WHERE id = ?")
        .bind(&library_id)
        .execute(&state.app_db)
        .await
        .map_err(|e| e.to_string())?;

    if !db_deleted {
        return Err(format!(
            "Library removed but the database file could not be deleted: {}",
            db_path.display()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn get_entries(
    state: tauri::State<'_, AppState>,
    library_id: String,
    parent_id: Option<i64>,
) -> Result<EntriesResponse, String> {
    let row: Option<(String, i32, String, String)> = sqlx::query_as(
        "SELECT path, portable, db_filename, default_sort_mode FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (path, portable, db_filename, default_sort_mode) = row.ok_or("Library not found")?;

    let db_path = if portable != 0 {
        PathBuf::from(&path).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::create_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    // Determine sort mode: if inside a collection, use its sort_mode; otherwise use library default
    let sort_mode = match parent_id {
        Some(pid) => {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT sort_mode FROM media WHERE id = ?",
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
        "year" => "ORDER BY year ASC, title ASC",
        "custom" => "ORDER BY sort_order ASC, title ASC",
        _ => "ORDER BY title ASC",
    };

    let query_str = match parent_id {
        Some(_) => format!(
            "SELECT id, title, year, folder_path, parent_id, is_collection FROM media WHERE parent_id = ? {}",
            order_clause
        ),
        None => format!(
            "SELECT id, title, year, folder_path, parent_id, is_collection FROM media WHERE parent_id IS NULL {}",
            order_clause
        ),
    };

    let rows: Vec<(i64, String, Option<String>, String, Option<i64>, i32)> = match parent_id {
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

    let lib_path = PathBuf::from(&path);
    let entries: Vec<MediaEntry> = rows
        .into_iter()
        .map(|(id, title, year, folder_path, parent_id, is_collection)| {
            let full_path = lib_path.join(&folder_path);
            let covers = find_covers(&full_path);
            MediaEntry {
                id,
                title,
                year,
                folder_path,
                parent_id,
                is_collection: is_collection != 0,
                covers,
            }
        })
        .collect();

    pool.close().await;
    Ok(EntriesResponse { entries, sort_mode })
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

    match entry_id {
        Some(eid) => {
            // Set sort_mode on a collection entry
            let row: Option<(String, i32, String)> = sqlx::query_as(
                "SELECT path, portable, db_filename FROM libraries WHERE id = ?",
            )
            .bind(&library_id)
            .fetch_optional(&state.app_db)
            .await
            .map_err(|e| e.to_string())?;

            let (path, portable, db_filename) = row.ok_or("Library not found")?;

            let db_path = if portable != 0 {
                PathBuf::from(&path).join(".waverunner.db")
            } else {
                state.app_data_dir.join(&db_filename)
            };

            let pool = crate::db::create_library_pool(&db_path)
                .await
                .map_err(|e| e.to_string())?;

            sqlx::query("UPDATE media SET sort_mode = ? WHERE id = ?")
                .bind(&sort_mode)
                .bind(eid)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;

            pool.close().await;
        }
        None => {
            // Set default_sort_mode on the library (for root level)
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
    let row: Option<(String, i32, String)> = sqlx::query_as(
        "SELECT path, portable, db_filename FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (path, portable, db_filename) = row.ok_or("Library not found")?;

    let db_path = if portable != 0 {
        PathBuf::from(&path).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::create_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    for (i, id) in entry_ids.iter().enumerate() {
        sqlx::query("UPDATE media SET sort_order = ? WHERE id = ?")
            .bind(i as i32)
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    pool.close().await;
    Ok(())
}

fn find_covers(folder_path: &PathBuf) -> Vec<String> {
    let covers_dir = folder_path.join("covers");
    let mut covers = Vec::new();

    if covers_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&covers_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    match ext.to_lowercase().as_str() {
                        "jpg" | "jpeg" | "png" | "avif" | "webp" => {
                            covers.push(path.to_string_lossy().to_string());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    covers
}

async fn scan_folder(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    base_path: &PathBuf,
    parent_id: Option<i64>,
) -> Result<(), sqlx::Error> {
    scan_dir(app, pool, base_path, base_path, parent_id).await
}

#[async_recursion::async_recursion]
async fn scan_dir(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    base_path: &PathBuf,
    dir: &PathBuf,
    parent_id: Option<i64>,
) -> Result<(), sqlx::Error> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            e.path().is_dir() && name != "covers" && name != "extras" && !name.starts_with('.')
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
                    e.path().is_dir() && n != "covers" && n != "extras" && !n.starts_with('.')
                })
            })
            .unwrap_or(false);

        let (title, year) = parse_folder_name(&name);

        let rel_path = path
            .strip_prefix(base_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        let result = sqlx::query(
            "INSERT INTO media (title, year, folder_path, parent_id, is_collection, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&title)
        .bind(&year)
        .bind(&rel_path)
        .bind(parent_id)
        .bind(has_subdirs as i32)
        .bind(i as i32)
        .execute(pool)
        .await?;

        let new_id = result.last_insert_rowid();

        if has_subdirs {
            scan_dir(app, pool, base_path, &path, Some(new_id)).await?;
        }
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
