use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
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
    pub path: String,
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
    pub folder_path: String,
    pub parent_id: Option<i64>,
    pub is_collection: bool,
    pub covers: Vec<String>,
    pub selected_cover: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EntriesResponse {
    pub entries: Vec<MediaEntry>,
    pub sort_mode: String,
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
    managed: bool,
) -> Result<Library, String> {
    let lib_path = PathBuf::from(&path);
    if !lib_path.exists() {
        return Err("Path does not exist".to_string());
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
            path: path.clone(),
            format: format.clone(),
            portable,
            db_filename: db_filename.clone(),
            default_sort_mode: "alpha".to_string(),
            managed,
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
        managed,
    };

    sqlx::query(
        "INSERT INTO libraries (id, name, path, format, portable, db_filename, default_sort_mode, managed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&library.id)
    .bind(&library.name)
    .bind(&library.path)
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
        "SELECT id, name, path, format, portable, db_filename, default_sort_mode, managed FROM libraries ORDER BY name",
    )
    .fetch_all(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, name, path, format, portable, db_filename, default_sort_mode, managed)| Library {
            id,
            name,
            path,
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
        "year" => "ORDER BY year ASC, sort_title ASC",
        "custom" => "ORDER BY sort_order ASC, sort_title ASC",
        _ => "ORDER BY sort_title ASC",
    };

    let query_str = match parent_id {
        Some(_) => format!(
            "SELECT id, title, year, folder_path, parent_id, is_collection, selected_cover FROM media WHERE parent_id = ? {}",
            order_clause
        ),
        None => format!(
            "SELECT id, title, year, folder_path, parent_id, is_collection, selected_cover FROM media WHERE parent_id IS NULL {}",
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

    let lib_path = PathBuf::from(&path);
    let entries: Vec<MediaEntry> = rows
        .into_iter()
        .map(|(id, title, year, folder_path, parent_id, is_collection, selected_cover)| {
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
                selected_cover,
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

#[tauri::command]
pub async fn rename_entry(
    state: tauri::State<'_, AppState>,
    library_id: String,
    entry_id: i64,
    new_title: String,
) -> Result<(), String> {
    let row: Option<(String, i32, String, i32)> = sqlx::query_as(
        "SELECT path, portable, db_filename, managed FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (lib_path, portable, db_filename, managed) = row.ok_or("Library not found")?;

    let db_path = if portable != 0 {
        PathBuf::from(&lib_path).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::create_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    // If managed, rename the actual folder on disk and update folder_path + children
    if managed != 0 {
        let entry_row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT folder_path, year FROM media WHERE id = ?",
        )
        .bind(entry_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?;

        let (folder_path, year) = entry_row.ok_or("Entry not found")?;

        let lib_base = PathBuf::from(&lib_path);
        let old_full_path = lib_base.join(&folder_path);

        // Build new folder name: "Title (Year)" or just "Title", stripping invalid FS chars
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

            // Update this entry's folder_path
            let new_rel_path = new_full_path
                .strip_prefix(&lib_base)
                .unwrap_or(&new_full_path)
                .to_string_lossy()
                .to_string();

            let old_rel_prefix = format!("{}\\", folder_path);
            let new_rel_prefix = format!("{}\\", new_rel_path);

            sqlx::query("UPDATE media SET folder_path = ? WHERE id = ?")
                .bind(&new_rel_path)
                .bind(entry_id)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;

            // Update all descendant folder_paths that start with the old prefix
            sqlx::query(
                "UPDATE media SET folder_path = ? || SUBSTR(folder_path, ?) WHERE folder_path LIKE ? AND id != ?",
            )
            .bind(&new_rel_prefix)
            .bind((old_rel_prefix.len() + 1) as i32)
            .bind(format!("{}%", old_rel_prefix))
            .bind(entry_id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    let sort_title = generate_sort_title(&new_title, "en");

    sqlx::query("UPDATE media SET title = ?, sort_title = ? WHERE id = ?")
        .bind(&new_title)
        .bind(&sort_title)
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

    sqlx::query("UPDATE media SET selected_cover = ? WHERE id = ?")
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
    let row: Option<(String, i32, String)> = sqlx::query_as(
        "SELECT path, portable, db_filename FROM libraries WHERE id = ?",
    )
    .bind(&library_id)
    .fetch_optional(&state.app_db)
    .await
    .map_err(|e| e.to_string())?;

    let (lib_path, portable, db_filename) = row.ok_or("Library not found")?;

    let db_path = if portable != 0 {
        PathBuf::from(&lib_path).join(".waverunner.db")
    } else {
        state.app_data_dir.join(&db_filename)
    };

    let pool = crate::db::create_library_pool(&db_path)
        .await
        .map_err(|e| e.to_string())?;

    let base_path = PathBuf::from(&lib_path);

    // Collect all folder relative paths currently on disk
    let mut disk_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    collect_disk_paths(&base_path, &base_path, &mut disk_paths)
        .map_err(|e| e.to_string())?;

    // Get all existing folder_paths from DB
    let db_rows: Vec<(i64, String, Option<i64>)> = sqlx::query_as(
        "SELECT id, folder_path, parent_id FROM media",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    let db_paths: std::collections::HashSet<String> =
        db_rows.iter().map(|(_, p, _)| p.clone()).collect();

    // Delete entries whose folders no longer exist on disk
    // Delete from deepest first to respect foreign keys even without cascade
    let mut to_delete: Vec<(i64, String)> = db_rows
        .iter()
        .filter(|(_, p, _)| !disk_paths.contains(p))
        .map(|(id, p, _)| (*id, p.clone()))
        .collect();
    // Sort by depth (deepest first) so children are deleted before parents
    to_delete.sort_by(|a, b| b.1.matches('\\').count().cmp(&a.1.matches('\\').count())
        .then_with(|| b.1.matches('/').count().cmp(&a.1.matches('/').count())));

    for (id, _) in &to_delete {
        sqlx::query("DELETE FROM media WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Find new paths that aren't in the DB yet
    let mut new_paths: Vec<String> = disk_paths
        .iter()
        .filter(|p| !db_paths.contains(*p))
        .cloned()
        .collect();
    // Sort by depth (shallowest first) so parents are created before children
    new_paths.sort_by(|a, b| {
        let depth_a = a.matches('\\').count() + a.matches('/').count();
        let depth_b = b.matches('\\').count() + b.matches('/').count();
        depth_a.cmp(&depth_b).then_with(|| a.cmp(b))
    });

    for rel_path in &new_paths {
        let full_path = base_path.join(rel_path);
        let folder_name = full_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let _ = app.emit("scan-progress", &folder_name);

        let (title, year) = parse_folder_name(&folder_name);

        // Determine parent_id by looking up the parent's folder_path
        let parent_rel = full_path
            .parent()
            .and_then(|p| p.strip_prefix(&base_path).ok())
            .map(|p| p.to_string_lossy().to_string());

        let parent_id: Option<i64> = if let Some(ref parent_path) = parent_rel {
            if parent_path.is_empty() {
                None
            } else {
                let row: Option<(i64,)> = sqlx::query_as(
                    "SELECT id FROM media WHERE folder_path = ?",
                )
                .bind(parent_path)
                .fetch_optional(&pool)
                .await
                .map_err(|e| e.to_string())?;
                row.map(|(id,)| id)
            }
        } else {
            None
        };

        let has_subdirs = std::fs::read_dir(&full_path)
            .map(|rd| {
                rd.filter_map(|e| e.ok()).any(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    e.path().is_dir() && n != "covers" && n != "extras" && !n.starts_with('.')
                })
            })
            .unwrap_or(false);

        // Get sort_order: place after existing siblings
        let max_order: Option<(i32,)> = if let Some(pid) = parent_id {
            sqlx::query_as("SELECT COALESCE(MAX(sort_order), -1) FROM media WHERE parent_id = ?")
                .bind(pid)
                .fetch_optional(&pool)
                .await
                .map_err(|e| e.to_string())?
        } else {
            sqlx::query_as(
                "SELECT COALESCE(MAX(sort_order), -1) FROM media WHERE parent_id IS NULL",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|e| e.to_string())?
        };
        let sort_order = max_order.map(|(v,)| v + 1).unwrap_or(0);

        let sort_title = generate_sort_title(&title, "en");

        sqlx::query(
            "INSERT INTO media (title, year, folder_path, parent_id, is_collection, sort_order, sort_title) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&title)
        .bind(&year)
        .bind(rel_path)
        .bind(parent_id)
        .bind(has_subdirs as i32)
        .bind(sort_order)
        .bind(&sort_title)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    // Update is_collection for existing entries that may have gained or lost children
    let all_entries: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, folder_path FROM media",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    for (id, rel_path) in &all_entries {
        let full_path = base_path.join(rel_path);
        let has_subdirs = std::fs::read_dir(&full_path)
            .map(|rd| {
                rd.filter_map(|e| e.ok()).any(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    e.path().is_dir() && n != "covers" && n != "extras" && !n.starts_with('.')
                })
            })
            .unwrap_or(false);

        sqlx::query("UPDATE media SET is_collection = ? WHERE id = ?")
            .bind(has_subdirs as i32)
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    pool.close().await;
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
        if entry.path().is_dir() && name != "covers" && name != "extras" && !name.starts_with('.') {
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

        let sort_title = generate_sort_title(&title, "en");

        let result = sqlx::query(
            "INSERT INTO media (title, year, folder_path, parent_id, is_collection, sort_order, sort_title) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
