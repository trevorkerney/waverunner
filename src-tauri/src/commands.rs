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

    // Determine DB location
    let db_path = if portable {
        lib_path.join(".waverunner.db")
    } else {
        let app_data = state.app_data_dir.clone();
        std::fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
        app_data.join(format!("{}.db", id))
    };

    // Create the library database and scan
    let pool = crate::db::create_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    // Clear any existing data (in case DB file persisted) and scan
    sqlx::query("DELETE FROM media").execute(&pool).await.map_err(|e| e.to_string())?;
    scan_folder(&app, &pool, &lib_path, None).await.map_err(|e| e.to_string())?;

    pool.close().await;

    let library = Library {
        id: id.clone(),
        name,
        path,
        format,
        portable,
    };

    // Save library to the app config
    let mut libs = state.libraries.lock().await;
    libs.push(library.clone());
    save_config(&state.app_data_dir, &libs).map_err(|e| e.to_string())?;

    Ok(library)
}

#[tauri::command]
pub async fn get_libraries(state: tauri::State<'_, AppState>) -> Result<Vec<Library>, String> {
    let libs = state.libraries.lock().await;
    Ok(libs.clone())
}

#[tauri::command]
pub async fn delete_library(
    state: tauri::State<'_, AppState>,
    library_id: String,
) -> Result<(), String> {
    let mut libs = state.libraries.lock().await;
    let lib = libs
        .iter()
        .find(|l| l.id == library_id)
        .ok_or("Library not found")?
        .clone();

    // Delete the DB file
    let db_path = if lib.portable {
        PathBuf::from(&lib.path).join(".waverunner.db")
    } else {
        state.app_data_dir.join(format!("{}.db", lib.id))
    };
    let db_deleted = if db_path.exists() {
        std::fs::remove_file(&db_path).is_ok()
    } else {
        true
    };

    libs.retain(|l| l.id != library_id);
    save_config(&state.app_data_dir, &libs).map_err(|e| e.to_string())?;

    if !db_deleted {
        return Err(format!("Library removed but the database file could not be deleted: {}", db_path.display()));
    }

    Ok(())
}

#[tauri::command]
pub async fn get_entries(
    state: tauri::State<'_, AppState>,
    library_id: String,
    parent_id: Option<i64>,
) -> Result<Vec<MediaEntry>, String> {
    let libs = state.libraries.lock().await;
    let lib = libs
        .iter()
        .find(|l| l.id == library_id)
        .ok_or("Library not found")?;

    let db_path = if lib.portable {
        PathBuf::from(&lib.path).join(".waverunner.db")
    } else {
        state.app_data_dir.join(format!("{}.db", lib.id))
    };

    let pool = crate::db::create_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let rows: Vec<(i64, String, Option<String>, String, Option<i64>, i32)> = match parent_id {
        Some(pid) => {
            sqlx::query_as(
                "SELECT id, title, year, folder_path, parent_id, is_collection FROM media WHERE parent_id = ? ORDER BY sort_order, title",
            )
            .bind(pid)
            .fetch_all(&pool)
            .await
        }
        None => {
            sqlx::query_as(
                "SELECT id, title, year, folder_path, parent_id, is_collection FROM media WHERE parent_id IS NULL ORDER BY sort_order, title",
            )
            .fetch_all(&pool)
            .await
        }
    }
    .map_err(|e| e.to_string())?;

    let lib_path = PathBuf::from(&lib.path);
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
    Ok(entries)
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

        // Determine if this is a collection (has subdirs that aren't covers/extras)
        let has_subdirs = std::fs::read_dir(&path)
            .map(|rd| {
                rd.filter_map(|e| e.ok()).any(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    e.path().is_dir() && n != "covers" && n != "extras" && !n.starts_with('.')
                })
            })
            .unwrap_or(false);

        // Parse title and year from folder name like "Movie Title (2024)"
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
    // Match "Title (Year)" pattern
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

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}", now)
}

pub fn save_config(app_data_dir: &PathBuf, libraries: &[Library]) -> Result<(), std::io::Error> {
    let config_path = app_data_dir.join("config.json");
    std::fs::create_dir_all(app_data_dir)?;
    let json = serde_json::to_string_pretty(libraries).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::Other, e)
    })?;
    std::fs::write(config_path, json)
}

pub fn load_config(app_data_dir: &PathBuf) -> Vec<Library> {
    let config_path = app_data_dir.join("config.json");
    if let Ok(data) = std::fs::read_to_string(config_path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    }
}
