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
            paths TEXT NOT NULL,
            format TEXT NOT NULL,
            portable INTEGER NOT NULL DEFAULT 0,
            db_filename TEXT NOT NULL,
            default_sort_mode TEXT NOT NULL DEFAULT 'alpha',
            managed INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    // Migrate: rename 'path' column to 'paths' and convert values to JSON arrays
    if sqlx::query("ALTER TABLE libraries RENAME COLUMN path TO paths")
        .execute(&pool)
        .await
        .is_ok()
    {
        // Convert bare path strings to JSON arrays
        sqlx::query(
            "UPDATE libraries SET paths = '[\"' || REPLACE(REPLACE(paths, '\\', '\\\\'), '\"', '\\\"') || '\"]' WHERE paths NOT LIKE '[%'",
        )
        .execute(&pool)
        .await?;
    }

    // Migrate: add player_path and player_args columns
    let _ = sqlx::query("ALTER TABLE libraries ADD COLUMN player_path TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE libraries ADD COLUMN player_args TEXT")
        .execute(&pool)
        .await;

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
        "video" => {
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS media_entry_type (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "INSERT OR IGNORE INTO media_entry_type (name) VALUES ('movie'), ('show'), ('collection')",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS media_entry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    parent_id INTEGER,
                    entry_type_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    folder_path TEXT NOT NULL,
                    sort_title TEXT NOT NULL DEFAULT '',
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    year TEXT,
                    end_year TEXT,
                    selected_cover TEXT,
                    FOREIGN KEY (parent_id) REFERENCES media_entry(id) ON DELETE CASCADE,
                    FOREIGN KEY (entry_type_id) REFERENCES media_entry_type(id)
                )",
            )
            .execute(&pool)
            .await?;

            // Lookup tables
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS genre (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS maturity_rating (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS person (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    image_path TEXT
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS studio (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS keyword (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE
                )",
            )
            .execute(&pool)
            .await?;

            // Movie table (1:1 with media_entry)
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS movie (
                    id INTEGER PRIMARY KEY,
                    tmdb_id TEXT,
                    imdb_id TEXT,
                    rotten_tomatoes_id TEXT,
                    plot TEXT,
                    tagline TEXT,
                    runtime INTEGER,
                    maturity_rating_id INTEGER,
                    FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE,
                    FOREIGN KEY (maturity_rating_id) REFERENCES maturity_rating(id)
                )",
            )
            .execute(&pool)
            .await?;

            // M2M junction tables
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS movie_genre (
                    movie_id INTEGER NOT NULL,
                    genre_id INTEGER NOT NULL,
                    PRIMARY KEY (movie_id, genre_id),
                    FOREIGN KEY (movie_id) REFERENCES movie(id) ON DELETE CASCADE,
                    FOREIGN KEY (genre_id) REFERENCES genre(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS movie_director (
                    movie_id INTEGER NOT NULL,
                    person_id INTEGER NOT NULL,
                    PRIMARY KEY (movie_id, person_id),
                    FOREIGN KEY (movie_id) REFERENCES movie(id) ON DELETE CASCADE,
                    FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS movie_cast (
                    movie_id INTEGER NOT NULL,
                    person_id INTEGER NOT NULL,
                    role TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (movie_id, person_id),
                    FOREIGN KEY (movie_id) REFERENCES movie(id) ON DELETE CASCADE,
                    FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS movie_crew (
                    movie_id INTEGER NOT NULL,
                    person_id INTEGER NOT NULL,
                    job TEXT,
                    PRIMARY KEY (movie_id, person_id, job),
                    FOREIGN KEY (movie_id) REFERENCES movie(id) ON DELETE CASCADE,
                    FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS movie_producer (
                    movie_id INTEGER NOT NULL,
                    person_id INTEGER NOT NULL,
                    PRIMARY KEY (movie_id, person_id),
                    FOREIGN KEY (movie_id) REFERENCES movie(id) ON DELETE CASCADE,
                    FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS movie_studio (
                    movie_id INTEGER NOT NULL,
                    studio_id INTEGER NOT NULL,
                    PRIMARY KEY (movie_id, studio_id),
                    FOREIGN KEY (movie_id) REFERENCES movie(id) ON DELETE CASCADE,
                    FOREIGN KEY (studio_id) REFERENCES studio(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS movie_keyword (
                    movie_id INTEGER NOT NULL,
                    keyword_id INTEGER NOT NULL,
                    PRIMARY KEY (movie_id, keyword_id),
                    FOREIGN KEY (movie_id) REFERENCES movie(id) ON DELETE CASCADE,
                    FOREIGN KEY (keyword_id) REFERENCES keyword(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS show (
                    id INTEGER PRIMARY KEY,
                    FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS collection (
                    id INTEGER PRIMARY KEY,
                    sort_mode TEXT NOT NULL DEFAULT 'alpha',
                    FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS season (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    show_id INTEGER NOT NULL,
                    title TEXT NOT NULL DEFAULT 'Season',
                    season_number INTEGER,
                    folder_path TEXT NOT NULL,
                    year TEXT,
                    end_year TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (show_id) REFERENCES show(id) ON DELETE CASCADE,
                    UNIQUE(show_id, season_number)
                )",
            )
            .execute(&pool)
            .await?;

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS episode (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    season_id INTEGER NOT NULL,
                    title TEXT NOT NULL DEFAULT 'Episode',
                    episode_number INTEGER,
                    file_path TEXT NOT NULL,
                    year TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (season_id) REFERENCES season(id) ON DELETE CASCADE,
                    UNIQUE(season_id, episode_number)
                )",
            )
            .execute(&pool)
            .await?;
        }
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
            return Err(sqlx::Error::Configuration(
                format!("Unsupported library format: {}", format).into(),
            ));
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
