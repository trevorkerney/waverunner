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
            default_sort_mode TEXT NOT NULL DEFAULT 'alpha'
        )",
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

pub async fn create_library_pool(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            year TEXT,
            folder_path TEXT NOT NULL,
            parent_id INTEGER,
            is_collection INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            sort_mode TEXT NOT NULL DEFAULT 'alpha',
            FOREIGN KEY (parent_id) REFERENCES media(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}
