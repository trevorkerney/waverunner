use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::path::Path;

pub async fn create_app_pool(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS libraries (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            format TEXT NOT NULL,
            portable INTEGER NOT NULL DEFAULT 0,
            db_filename TEXT NOT NULL,
            default_sort_mode TEXT NOT NULL DEFAULT 'alpha',
            managed INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

pub async fn connect_library_pool(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
    SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
}

pub async fn create_library_pool(db_path: &Path, format: &str) -> Result<SqlitePool, sqlx::Error> {
    let pool = connect_library_pool(db_path).await?;

    match format {
        "tv" => {
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS shows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    year TEXT,
                    folder_path TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    sort_title TEXT NOT NULL DEFAULT '',
                    selected_cover TEXT
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS seasons (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    show_id INTEGER NOT NULL,
                    title TEXT NOT NULL DEFAULT 'Season',
                    season_number INTEGER,
                    folder_path TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE,
                    UNIQUE(show_id, season_number)
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS episodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    season_id INTEGER NOT NULL,
                    title TEXT NOT NULL DEFAULT 'Episode',
                    episode_number INTEGER,
                    file_path TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
                    UNIQUE(season_id, episode_number)
                )",
            )
            .execute(&pool)
            .await?;
        }
        "music" => {
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS artists (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    folder_path TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    sort_name TEXT NOT NULL DEFAULT '',
                    selected_cover TEXT
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS albums (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    artist_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    year TEXT,
                    folder_path TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    sort_title TEXT NOT NULL DEFAULT '',
                    selected_cover TEXT,
                    release_type TEXT NOT NULL DEFAULT 'album',
                    FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS songs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    album_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    track_number INTEGER,
                    file_path TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;
        }
        _ => {
            // movies
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS movie (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    year TEXT,
                    folder_path TEXT NOT NULL,
                    parent_id INTEGER,
                    is_collection INTEGER NOT NULL DEFAULT 0,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    sort_mode TEXT NOT NULL DEFAULT 'alpha',
                    selected_cover TEXT,
                    sort_title TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (parent_id) REFERENCES movie(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;
        }
    }

    // Cached images table — all formats
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS cached_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_folder_path TEXT NOT NULL,
            image_type TEXT NOT NULL,
            source_filename TEXT NOT NULL,
            cached_path TEXT NOT NULL,
            UNIQUE(entry_folder_path, image_type, source_filename)
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_cached_images_entry ON cached_images(entry_folder_path, image_type)",
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}
