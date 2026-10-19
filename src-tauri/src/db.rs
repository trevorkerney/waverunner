use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::path::Path;

/// The schema has NO migrations (user's call, 2026-10-15): the CREATE
/// statements below describe the database in full, and every table shape
/// change bumps this epoch. A database stamped with another epoch is from
/// before the change: it is moved aside (never deleted) and a fresh one
/// starts in its place — libraries get re-imported.
///
/// Epoch 1 = the tag-layer schema: waverunner's own tier of every tag
/// (field_override over the registry in tag_fields.rs), album identity by
/// grouping key, no staged directives (combines, splits and merges apply on
/// the spot through a scoped rescan).
pub const SCHEMA_EPOCH: i64 = 1;

async fn open_pool(db_url: &str) -> Result<SqlitePool, sqlx::Error> {
    SqlitePoolOptions::new()
        .max_connections(5)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("PRAGMA foreign_keys = ON")
                    .execute(&mut *conn)
                    .await?;
                // WAL: readers never block writers (the default rollback
                // journal made any big read — a center refresh — able to
                // fail a concurrent apply with "database is locked").
                // busy_timeout: when two WRITERS do collide, wait instead
                // of failing — 5s outlasts any single statement here.
                sqlx::query("PRAGMA journal_mode = WAL")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("PRAGMA busy_timeout = 5000")
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .connect(db_url)
        .await
}

/// Is this database's schema the current epoch? A database with tables but
/// no (or another) epoch stamp predates the reset.
async fn epoch_matches(pool: &SqlitePool) -> Result<Option<bool>, sqlx::Error> {
    let tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_one(pool)
    .await?;
    if tables == 0 {
        return Ok(None); // fresh
    }
    let has_epoch: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_epoch'",
    )
    .fetch_one(pool)
    .await?;
    if has_epoch == 0 {
        return Ok(Some(false));
    }
    let epoch: Option<i64> = sqlx::query_scalar("SELECT MAX(epoch) FROM schema_epoch")
        .fetch_one(pool)
        .await?;
    Ok(Some(epoch == Some(SCHEMA_EPOCH)))
}

/// Move a pre-reset database aside: `waverunner.db` → `waverunner.db.pre-epoch-N.bak`
/// (with its -wal/-shm siblings). Nothing is deleted.
fn move_aside(db_path: &Path) {
    let stamp = chrono_free_stamp();
    for suffix in ["", "-wal", "-shm"] {
        let from = db_path.with_file_name(format!(
            "{}{suffix}",
            db_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        ));
        if !from.exists() {
            continue;
        }
        let to = db_path.with_file_name(format!(
            "{}.pre-epoch-{SCHEMA_EPOCH}-{stamp}.bak{suffix}",
            db_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        ));
        match std::fs::rename(&from, &to) {
            Ok(()) => eprintln!("[db] moved pre-reset database aside: {}", to.display()),
            Err(e) => eprintln!("[db] WARNING: could not move {} aside: {e}", from.display()),
        }
    }
}

/// Seconds since the epoch, as a filename-safe stamp (no chrono dependency).
fn chrono_free_stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub async fn create_app_pool(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
    let mut pool = open_pool(&db_url).await?;

    // A database from before the schema reset is moved aside and replaced:
    // its tables no longer match the code, and there is no migration path by
    // design (see SCHEMA_EPOCH).
    let mut fresh = match epoch_matches(&pool).await? {
        None => true,
        Some(true) => false,
        Some(false) => {
            eprintln!(
                "[db] {} predates schema epoch {SCHEMA_EPOCH} — moving it aside and starting fresh",
                db_path.display()
            );
            pool.close().await;
            move_aside(db_path);
            pool = open_pool(&db_url).await?;
            true
        }
    };
    if !fresh {
        // Belt and braces: an epoch stamp with no tables behind it.
        let tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .fetch_one(&pool)
        .await?;
        fresh = tables <= 1;
    }

    // ── Schema epoch ──────────────────────────────────────────────────

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_epoch (
            epoch INTEGER PRIMARY KEY,
            app_version TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await?;

    // ── App-level tables ──────────────────────────────────────────────

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS library (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            format TEXT NOT NULL,
            -- source: where the library's content comes from. 'local' reads folders from
            -- disk; future values ('jellyfin', 'plex', ...) act as a client for a media
            -- server, configured via source_config (JSON, adapter-specific).
            source TEXT NOT NULL DEFAULT 'local',
            source_config TEXT,
            -- default_sort_mode: library-root sort for video libraries; artist-root sort for music libraries.
            -- movies_sort_mode / shows_sort_mode: per-view sort_mode for the video filtered views, so
            -- movies-only / shows-only / library-root are independent scopes for both the basic sort and presets.
            default_sort_mode TEXT NOT NULL DEFAULT 'alpha',
            movies_sort_mode TEXT NOT NULL DEFAULT 'alpha',
            shows_sort_mode TEXT NOT NULL DEFAULT 'alpha',
            library_root_selected_preset_id INTEGER,
            movies_only_selected_preset_id INTEGER,
            shows_only_selected_preset_id INTEGER,
            creating INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(&pool)
    .await?;

    // A library's source folders, each tagged movie/show so the scanner classifies by the
    // folder's kind instead of guessing from structure. Replaces the old library.paths JSON blob.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS library_path (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            path TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('movie', 'show', 'music')),
            sort_order INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
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

    // ── Entry type lookup ─────────────────────────────────────────────

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS media_entry_type (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO media_entry_type (name)
            VALUES ('movie'), ('show'), ('collection'), ('artist'), ('album'), ('track')",
    )
    .execute(&pool)
    .await?;

    // ── Core entry hierarchy ──────────────────────────────────────────

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS media_entry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            parent_id INTEGER,
            entry_type_id INTEGER NOT NULL,
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_id) REFERENCES media_entry(id) ON DELETE CASCADE,
            FOREIGN KEY (entry_type_id) REFERENCES media_entry_type(id)
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_media_entry_library ON media_entry(library_id)")
        .execute(&pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_media_entry_parent ON media_entry(parent_id)")
        .execute(&pool)
        .await?;

    // ── Shared lookup tables ──────────────────────────────────────────

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
            image_path TEXT,
            tmdb_id INTEGER,
            biography TEXT
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS person_image (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id INTEGER NOT NULL,
            filename TEXT NOT NULL,
            tmdb_path TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_person_image_unique ON person_image(person_id, tmdb_path)")
        .execute(&pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_person_image_person ON person_image(person_id)")
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

    // ── Video detail tables ───────────────────────────────────────────

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS movie (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            folder_path TEXT NOT NULL DEFAULT '',
            sort_title TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            release_date TEXT,
            selected_cover TEXT,
            tmdb_id TEXT,
            imdb_id TEXT,
            rotten_tomatoes_id TEXT,
            plot TEXT,
            tagline TEXT,
            runtime INTEGER,
            maturity_rating_id INTEGER,
            content_hash TEXT,
            content_size INTEGER,
            content_mtime INTEGER,
            FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE,
            FOREIGN KEY (maturity_rating_id) REFERENCES maturity_rating(id)
        )",
    )
    .execute(&pool)
    .await?;

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
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            movie_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
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
        "CREATE TABLE IF NOT EXISTS movie_composer (
            movie_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            PRIMARY KEY (movie_id, person_id),
            FOREIGN KEY (movie_id) REFERENCES movie(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_movie_composer_person ON movie_composer(person_id)")
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
            title TEXT NOT NULL DEFAULT '',
            folder_path TEXT NOT NULL DEFAULT '',
            sort_title TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            selected_cover TEXT,
            tmdb_id TEXT,
            imdb_id TEXT,
            plot TEXT,
            tagline TEXT,
            maturity_rating_id INTEGER,
            content_hash TEXT,
            content_size INTEGER,
            content_mtime INTEGER,
            FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE,
            FOREIGN KEY (maturity_rating_id) REFERENCES maturity_rating(id)
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS show_genre (
            show_id INTEGER NOT NULL,
            genre_id INTEGER NOT NULL,
            PRIMARY KEY (show_id, genre_id),
            FOREIGN KEY (show_id) REFERENCES show(id) ON DELETE CASCADE,
            FOREIGN KEY (genre_id) REFERENCES genre(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS show_creator (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            show_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            FOREIGN KEY (show_id) REFERENCES show(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS show_cast (
            show_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            role TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (show_id, person_id),
            FOREIGN KEY (show_id) REFERENCES show(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS show_composer (
            show_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            PRIMARY KEY (show_id, person_id),
            FOREIGN KEY (show_id) REFERENCES show(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_show_composer_person ON show_composer(person_id)")
        .execute(&pool)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS show_studio (
            show_id INTEGER NOT NULL,
            studio_id INTEGER NOT NULL,
            PRIMARY KEY (show_id, studio_id),
            FOREIGN KEY (show_id) REFERENCES show(id) ON DELETE CASCADE,
            FOREIGN KEY (studio_id) REFERENCES studio(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS show_keyword (
            show_id INTEGER NOT NULL,
            keyword_id INTEGER NOT NULL,
            PRIMARY KEY (show_id, keyword_id),
            FOREIGN KEY (show_id) REFERENCES show(id) ON DELETE CASCADE,
            FOREIGN KEY (keyword_id) REFERENCES keyword(id) ON DELETE CASCADE
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
            plot TEXT,
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
            -- For multi-episode files (e.g. \"S01E01-E02\"): the LAST episode number covered.
            -- NULL for ordinary single episodes. episode_number stays the FIRST number, so the
            -- UNIQUE(season_id, episode_number) constraint and number-based sorting still work.
            episode_number_end INTEGER,
            file_path TEXT NOT NULL,
            release_date TEXT,
            plot TEXT,
            runtime INTEGER,
            sort_order INTEGER NOT NULL DEFAULT 0,
            content_hash TEXT,
            content_size INTEGER,
            content_mtime INTEGER,
            FOREIGN KEY (season_id) REFERENCES season(id) ON DELETE CASCADE,
            UNIQUE(season_id, episode_number)
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS season_cast (
            season_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            role TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (season_id, person_id),
            FOREIGN KEY (season_id) REFERENCES season(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS episode_cast (
            episode_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            role TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (episode_id, person_id, role),
            FOREIGN KEY (episode_id) REFERENCES episode(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS episode_director (
            episode_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            PRIMARY KEY (episode_id, person_id),
            FOREIGN KEY (episode_id) REFERENCES episode(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_episode_director_person ON episode_director(person_id)")
        .execute(&pool)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS episode_composer (
            episode_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            PRIMARY KEY (episode_id, person_id),
            FOREIGN KEY (episode_id) REFERENCES episode(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_episode_composer_person ON episode_composer(person_id)")
        .execute(&pool)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS media_collection (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            folder_path TEXT NOT NULL DEFAULT '',
            sort_title TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            selected_cover TEXT,
            sort_mode TEXT NOT NULL DEFAULT 'alpha',
            selected_preset_id INTEGER,
            FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Music detail tables ───────────────────────────────────────────

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS artist (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            sort_title TEXT NOT NULL DEFAULT '',
            folder_path TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            selected_cover TEXT,
            biography TEXT,
            musicbrainz_id TEXT,
            FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // The album row's columns are a CACHE of resolved values (user > mb >
    // tags, see field_override) — rewritten by the scanner on every scan,
    // full or scoped, which is the one path that writes them.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            sort_title TEXT NOT NULL DEFAULT '',
            folder_path TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            selected_cover TEXT,
            release_date TEXT,
            album_type TEXT NOT NULL DEFAULT 'album',
            disc_count INTEGER,
            -- MusicBrainz release group the FILES carry (tag truth); the
            -- matched group lives in field_override.
            mb_release_group_id TEXT,
            FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Same cache rule as album: title, numbers and sort keys are the
    // resolved values the scanner wrote.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            sort_title TEXT NOT NULL DEFAULT '',
            file_path TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            track_number INTEGER,
            disc_number INTEGER,
            runtime INTEGER,
            audio_hash TEXT,
            -- Rescan gate: unchanged pair = stored hash still valid, the
            -- audio region is never re-read.
            content_size INTEGER,
            content_mtime INTEGER,
            FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS artist_genre (
            artist_id INTEGER NOT NULL,
            genre_id INTEGER NOT NULL,
            PRIMARY KEY (artist_id, genre_id),
            FOREIGN KEY (artist_id) REFERENCES artist(id) ON DELETE CASCADE,
            FOREIGN KEY (genre_id) REFERENCES genre(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_genre (
            album_id INTEGER NOT NULL,
            genre_id INTEGER NOT NULL,
            PRIMARY KEY (album_id, genre_id),
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE,
            FOREIGN KEY (genre_id) REFERENCES genre(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track_artist (
            track_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'primary',
            PRIMARY KEY (track_id, person_id, role),
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Music releases (versions of an album) ────────────────────────
    // One row per owned version of an album ("2011 Remaster", "Deluxe
    // Edition", ...). Our `album` = MusicBrainz "release group", our
    // `album_release` = MusicBrainz "release" (named to dodge the RELEASE
    // SQL keyword). label NULL = the plain/unnamed version. A release is a
    // folder by default; a track's release_key (tag layer) can put it in
    // another folder's release. Rebuilt with fresh ids on every scan.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_release (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            album_id INTEGER NOT NULL,
            label TEXT,
            folder_path TEXT NOT NULL,
            release_date TEXT,
            mb_release_id TEXT,
            is_default INTEGER NOT NULL DEFAULT 0,
            disc_count INTEGER NOT NULL DEFAULT 1,
            -- The release's OWN title: majority album tag (effective) of its
            -- tracks, so a combined-in source keeps its original name.
            title TEXT,
            -- A cue sheet in the release folder flags its tracks PRE (CD
            -- pre-emphasis left in the rip): playback de-emphasizes unless
            -- the user's pref says otherwise. Stamped by the scanner.
            cue_pre_emphasis INTEGER NOT NULL DEFAULT 0,
            -- Release-level facts cached from the tracks' effective tags
            -- (majority): the label and catalogue number the header shows.
            label_name TEXT,
            catalog_number TEXT,
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // User preferences for an album's releases — custom labels and the chosen
    // default. Keyed by FOLDER (the stable identity): album_release rows are
    // rebuilt with fresh ids on every rescan, and these get re-applied on top
    // (apply_release_prefs at each album's reconcile tail).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_release_pref (
            album_id INTEGER NOT NULL,
            folder_path TEXT NOT NULL,
            label TEXT,
            is_default INTEGER NOT NULL DEFAULT 0,
            -- The user's cover pick for THIS release (cached path), folder-
            -- keyed like label so it survives the release-row rebuild.
            cover TEXT,
            -- The user's word on pre-emphasis: 1 = de-emphasize on play,
            -- 0 = play as is, NULL = go by the cue sheet (cue_pre_emphasis).
            pre_emphasis INTEGER,
            PRIMARY KEY (album_id, folder_path),
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_album_release_album ON album_release(album_id)")
        .execute(&pool)
        .await?;

    // Which release a track belongs to.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track_release (
            track_id INTEGER PRIMARY KEY,
            release_id INTEGER NOT NULL,
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE,
            FOREIGN KEY (release_id) REFERENCES album_release(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_track_release_release ON track_release(release_id)")
        .execute(&pool)
        .await?;

    // Per-track payload the track table has no columns for: display artist
    // (may differ from the album artist — features, compilations), the
    // embedded MusicBrainz recording id, and technical facts.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track_meta (
            track_id INTEGER PRIMARY KEY,
            artist_name TEXT,
            mb_recording_id TEXT,
            codec TEXT,
            bitrate_kbps INTEGER,
            sample_rate_hz INTEGER,
            bitrate_mode TEXT,
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Track waveform peaks ──────────────────────────────────────────
    // Seekbar waveform cache: normalized peak bytes per track, computed
    // lazily by the first get_track_waveform call and stamped with
    // (size, mtime) so a changed file recomputes. Scans never touch it.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track_waveform (
            track_id INTEGER PRIMARY KEY,
            peaks BLOB NOT NULL,
            content_size INTEGER,
            content_mtime INTEGER,
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Track artist credits ──────────────────────────────────────────
    // Ordered credit list per track (the effective `credits` field): main
    // artist(s) first, then features. name is the as-credited text;
    // artist_id is WHO that is — stamped by resolve_credit_ids after every
    // pass that changes credits or artists. NULL = unresolved. Deliberately
    // not a FOREIGN KEY: artist deletes (sweeps, merges) must not be blocked
    // by stale stamps, which the next resolution pass heals.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track_credit (
            track_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            artist_id INTEGER,
            PRIMARY KEY (track_id, position),
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── MusicBrainz artist lookup cache ───────────────────────────────
    // One row per credit/artist name ever looked up (lowercased key), so the
    // rate-limited enrichment pass never re-queries settled names. status:
    // 'matched' (mbid set) | 'notfound'. Transient errors are not cached.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mb_artist_lookup (
            name TEXT PRIMARY KEY,
            mbid TEXT,
            status TEXT NOT NULL,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await?;

    // ── Artist discography cache (match dialog) ───────────────────────
    // One row per MB artist whose release groups the dialog has browsed:
    // served instantly on the next open, refreshed in the background on
    // every open (stale-while-revalidate — never on a schedule), and
    // evicted once the artist has no unmatched album left anywhere
    // (evict_artist_group_caches). Kilobytes per artist.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mb_artist_groups_cache (
            artist_mbid TEXT PRIMARY KEY,
            groups_json TEXT NOT NULL,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await?;

    // ── Band membership (membership.rs) ───────────────────────────────
    // MusicBrainz "member of band" relationships, by MBID: one row per
    // stint (a member who left and rejoined has two), attributes as a JSON
    // array. The fetch stamp per artist carries MusicBrainz's type and the
    // artist's life span — a group that has ended has no current members
    // even where its member rows carry no dates.
    for stmt in [
        "CREATE TABLE IF NOT EXISTS mb_membership (
            group_mbid TEXT NOT NULL,
            member_mbid TEXT NOT NULL,
            stint TEXT NOT NULL DEFAULT '',
            group_name TEXT NOT NULL,
            member_name TEXT NOT NULL,
            begin_date TEXT,
            end_date TEXT,
            ended INTEGER NOT NULL DEFAULT 0,
            attributes TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (group_mbid, member_mbid, stint)
        )",
        "CREATE INDEX IF NOT EXISTS idx_mb_membership_member ON mb_membership(member_mbid)",
        "CREATE TABLE IF NOT EXISTS mb_membership_fetch (
            artist_mbid TEXT PRIMARY KEY,
            artist_type TEXT,
            life_begin TEXT,
            life_end TEXT,
            life_ended INTEGER NOT NULL DEFAULT 0,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    ] {
        sqlx::query(stmt).execute(&pool).await?;
    }

    // ── Failed MusicBrainz requests (what the pass couldn't get through) ──
    // One row per item whose request failed on the pass's last try: the
    // queue banner lists them, the finish line counts them, a later success
    // (any pass, any path) clears the row, and each phase prunes rows for
    // items outside its current work when it starts. Nothing retries on
    // its own. See music_mb::record_fetch_failure.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mb_fetch_failure (
            library_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            target TEXT NOT NULL,
            label TEXT NOT NULL,
            phase TEXT NOT NULL,
            error TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 1,
            last_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (library_id, kind, target),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Release-group releases cache (match dialog's release picker) ──
    // Same rules as the artist cache: served instantly, refreshed in the
    // background on open, evicted once no album in the group still has an
    // unresolved release. Filled on demand and by the prefetch job.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mb_group_releases_cache (
            group_id TEXT PRIMARY KEY,
            releases_json TEXT NOT NULL,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await?;

    // ── Artist name redirects ─────────────────────────────────────────
    // Former spellings that must keep resolving to an artist: names absorbed
    // by merges and pre-rename titles ("J Cole" → "J. Cole"). Despite the
    // table name these are NOT "also known as" credits — nothing records an
    // artist being credited under another name here. Consulted by
    // resolve_credit_ids when stamping credit artist_ids (the scanner's
    // dictionary), not by display queries.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS artist_alias (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            artist_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            -- Who wrote the redirect — the Sources view's tier vocabulary:
            -- 'mb' (a MusicBrainz match adopted the canonical name and the
            -- old spelling lives on here) or 'user' (a rename, merge or
            -- link by hand).
            source TEXT NOT NULL DEFAULT 'user',
            FOREIGN KEY (artist_id) REFERENCES artist(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_artist_alias_unique ON artist_alias(artist_id, name)")
        .execute(&pool)
        .await?;

    // Every name an artist answers to (title + redirects) — the lookup
    // surface for stamping credit artist_ids at resolution time. Display
    // paths read the stamped ids; only the raw track_meta.artist_name string
    // still prettifies through here.
    sqlx::query(
        "CREATE VIEW IF NOT EXISTS artist_names AS
         SELECT id AS artist_id, title AS name FROM artist
         UNION
         SELECT artist_id, name FROM artist_alias",
    )
    .execute(&pool)
    .await?;

    // ── MusicBrainz review queue ──────────────────────────────────────
    // Suggestions the auto pass could not settle: uncertain album matches,
    // heuristic-only artist merges, field conflicts. Resolved via the
    // Match-to-MusicBrainz modal. target_key dedupes per subject; status:
    // 'pending' | 'accepted' | 'rejected' (rejections double as "never ask
    // again" and as merge suppression).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mb_suggestion (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            target_key TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (library_id, kind, target_key),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Everything the MusicBrainz pass auto-applied — and every decision the
    // user made, tag-layer edits included — with before/after values: the
    // History list. Undo restores `before_json` (and, for machine changes,
    // writes an mb_suppression row so the pass doesn't reapply).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mb_change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            target_id INTEGER NOT NULL,
            label TEXT NOT NULL,
            before_json TEXT,
            after_json TEXT,
            undone INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            -- The action that wrote this row: one match logs several rows
            -- (credits, type, date) and the review list undoes the action, not
            -- its parts.
            batch_id INTEGER,
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_mb_change_log_library ON mb_change_log(library_id, created_at)")
        .execute(&pool)
        .await?;

    // Undone changes must stay undone: the auto pass checks here first.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mb_suppression (
            kind TEXT NOT NULL,
            target_id INTEGER NOT NULL,
            PRIMARY KEY (kind, target_id)
        )",
    )
    .execute(&pool)
    .await?;

    // Per-album stamp for the MusicBrainz credit fetch (release-level artist
    // credits — features the tags don't spell out). status: 'matched' |
    // 'notfound'. Transient errors are not stamped, so they retry.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mb_credit_fetch (
            album_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Artist names that contain a comma and must survive feature-clause
    // splitting. "(feat. Tyler, The Creator)" is ONE guest, but the splitter
    // can't know that — MusicBrainz confirms it and the name is recorded here,
    // so every later scan rejoins the pair instead of inventing an artist.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS feat_join (
            library_id TEXT NOT NULL,
            name TEXT NOT NULL,
            PRIMARY KEY (library_id, name),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Where a matched album and its MusicBrainz release disagree about the
    // track list. `side` says who has the track the other one lacks: 'ours' =
    // in the library, 'mb' = on the release. `counterpart` is the title MB has
    // at that same disc/track when the slot exists but the titles differ —
    // exactly the case where MB's credits are NOT applied, which is otherwise
    // invisible. Rewritten whole on every match/re-check; dismissing deletes.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_match_gap (
            album_id INTEGER NOT NULL,
            -- Which release of the album this diff belongs to (folder-keyed,
            -- like every per-release store — release row ids don't survive
            -- rescans).
            folder_path TEXT NOT NULL DEFAULT '',
            side TEXT NOT NULL,
            disc INTEGER NOT NULL,
            position INTEGER NOT NULL,
            title TEXT NOT NULL,
            counterpart TEXT,
            -- Same-slot title disagreement whose lengths disagree too (beyond
            -- two seconds): probably a different song, no Accept offered.
            length_off INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (album_id, folder_path, side, disc, position),
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Per-release MusicBrainz match: WHICH pressing each release of an album
    // is. The group id stays album-level (the card IS the group); every
    // release can pin its own pressing. Folder-keyed because album_release
    // rows are rebuilt with fresh ids on every rescan. title: the pinned
    // pressing's own MB title — for the per-tier view; the album's title
    // always comes from the group. The pressing's medium titles go to the
    // tracks' disc_subtitle mb tier (tag_fields), not here.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS release_match (
            album_id INTEGER NOT NULL,
            folder_path TEXT NOT NULL,
            mb_release_id TEXT NOT NULL,
            tier TEXT NOT NULL DEFAULT 'mb',
            title TEXT,
            PRIMARY KEY (album_id, folder_path),
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Disc names as resolved per track (the effective disc_subtitle field:
    // user rename, else the pinned pressing's medium title, else the
    // DISCSUBTITLE tag), rebuilt with the release rows they hang off.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS release_disc_subtitle (
            release_id INTEGER NOT NULL,
            disc_no INTEGER NOT NULL,
            title TEXT NOT NULL,
            PRIMARY KEY (release_id, disc_no),
            FOREIGN KEY (release_id) REFERENCES album_release(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // The user's note on ONE version of an album ("this pressing has the
    // short Music Box Blues") — folder-keyed like the pin, so it rides
    // combines, splits and folder moves with its version. The card-wide
    // note is entry_note. See notes.rs.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_release_note (
            album_id INTEGER NOT NULL,
            folder_path TEXT NOT NULL,
            text TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (album_id, folder_path),
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Music play history ────────────────────────────────────────────
    // One row per playback START, however brief — recently-played shows all
    // of these. `scrobbled` flips once the Last.fm rule trips (>=50% of the
    // track or >=4 minutes of accumulated listening, whichever comes first);
    // stats and "real listen" surfaces read only scrobbled rows. played_secs =
    // seconds actually listened (seek jumps credit nothing). There is
    // deliberately no resume for music.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS music_play (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            track_id INTEGER NOT NULL,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            played_secs REAL NOT NULL DEFAULT 0,
            duration_secs REAL,
            scrobbled INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_music_play_track ON music_play(track_id)")
        .execute(&pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_music_play_started ON music_play(started_at)")
        .execute(&pool)
        .await?;

    // Ordered album-level artist credits ("Drake · Future") — THE record of
    // whose album this is, written by the scanner from the tracks' effective
    // album_artists. Every album carries rows, solo included; the media_entry
    // parent is only where the album lives (folder position, cascade), never
    // attribution. artist_id as on track_credit: stamped by
    // resolve_credit_ids, soft reference on purpose.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_artist_credit (
            album_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            artist_id INTEGER,
            PRIMARY KEY (album_id, position),
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Per-library settings — key/value like the app-wide `settings` table,
    // scoped to one library. Keys: 'online_metadata' ("on"/"off", absent =
    // on), 'tag_writing' ("on"/"off"), 'mb_pass_ran' ("1").
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS library_setting (
            library_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (library_id, key),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Matches waiting for a matching pass to cash them in (stamp the artists
    // their credits prove). Enqueued when an album match applies, removed on
    // unmatch, cleared wholesale by a completed pass.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pending_pass (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            target TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL,
            -- The History batch whose change put this row here (a merge or
            -- link), when exactly one did — the queue's Undo runs it.
            batch_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Personas: independent artist identities linked back to the human
    // behind them (kiLL edward → J. Cole). NOT a merge — both pages live on
    // with their own credits/matching (the persona may have its own MBID, or
    // none: God). One parent per persona, one level deep. Distinct from
    // artist_alias, which is spellings of a SINGLE identity.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS artist_persona (
            persona_id INTEGER PRIMARY KEY,
            parent_id INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    // Derivation exhaustion: "this evidence was walked to completion and did
    // not prove this entity" — the pass's memory, so it stops re-fetching the
    // same groups/searches every run. Keys: an artist + the group/release id
    // whose credits were walked, or an album + 'arid:<mbid>' for the
    // artist-scoped notfound retry. Rows are deleted when the facts change
    // (merge/alias renames the artist, unmatch restarts the album) so the
    // walk earns exactly one retry per new fact. Failed fetches never write
    // a row — the retry shield stays.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mb_derive_exhausted (
            entity_id INTEGER NOT NULL,
            evidence_key TEXT NOT NULL,
            PRIMARY KEY (entity_id, evidence_key)
        )",
    )
    .execute(&pool)
    .await?;

    // User directive: this album-artist STRING is really several artists
    // ("JAY-Z & Kanye West" → [JAY-Z, Kanye West]). A standing RULE applied
    // on every scan (files not yet scanned included) — members[0] becomes
    // the canonical parent, the full list becomes the album's artist
    // credits, and matching track credits split the same way. Applied on
    // the spot through a scoped rescan when written.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS artist_split (
            library_id TEXT NOT NULL,
            source_name TEXT NOT NULL COLLATE NOCASE,
            members TEXT NOT NULL,
            PRIMARY KEY (library_id, source_name),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track_loved (
            track_id INTEGER PRIMARY KEY,
            loved_at TEXT NOT NULL DEFAULT (datetime('now')),
            level TEXT NOT NULL DEFAULT 'liked',
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Recently-listened dismissals ──────────────────────────────────
    // "Remove from Recently listened to": hides a track's plays UP TO the
    // dismissal moment from recency surfaces without deleting the play log
    // (scrobble stats keep everything). A newer play resurfaces the track.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS music_listen_dismiss (
            track_id INTEGER PRIMARY KEY,
            dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Album scanner identity ────────────────────────────────────────
    // The grouping key the scanner filed each album under — "key:<album
    // artist>\x1f<album>" (lowercased tags), "rg:<MusicBrainz release group>"
    // when its releases carry one (tagged or matched), or "id:<token>" when
    // the user's identity_key layer field set one apart (a separated
    // edition, a combine). The rescan's row claim matches on this first;
    // artist/title are the display pair at that scan, for the record.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_identity (
            album_id INTEGER PRIMARY KEY,
            key TEXT NOT NULL,
            artist TEXT NOT NULL,
            title TEXT NOT NULL,
            FOREIGN KEY (album_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Sounds domain (ambient/rain/etc inside a music library) ───────
    // library_path.kind has a baked CHECK ('movie','show','music'), so sounds
    // bases are ordinary kind='music' rows plus a row here. The scanner
    // stamps albums found under these bases into sound_album; music surfaces
    // exclude sound-marked albums the same way they exclude loose containers,
    // and the Sounds node shows only them.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sound_path (
            library_id TEXT NOT NULL,
            path TEXT NOT NULL,
            PRIMARY KEY (library_id, path),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Presence of a row = the album (or loose container) is a SOUND album.
    // Rebuilt by scan/rescan from folder placement; retyping a folder flips
    // its albums on the next rescan.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sound_album (
            album_id INTEGER PRIMARY KEY,
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Virtual sound COLLECTIONS: the user-facing grouping for sounds. A row
    // marks an album entry as a collection — never folder-claimed by rescans,
    // never swept, lives until the user deletes it. Folder-mimicked at first
    // scan (folder_path kept for cover art), user-created afterwards.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sound_collection (
            album_id INTEGER PRIMARY KEY,
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Where a sound track lives, decided once by folder-mimicking or by the
    // user. album_id NULL = explicitly loose. NO row = never placed — the
    // scan folder-mimics it (this is how new files auto-organize and how a
    // pre-collections library migrates). Reapplied after every scan/rescan,
    // so source moves/renames never override a user's placement.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sound_track_home (
            track_id INTEGER PRIMARY KEY,
            album_id INTEGER,
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE,
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE SET NULL
        )",
    )
    .execute(&pool)
    .await?;

    // ── Music scan issues ─────────────────────────────────────────────
    // Only files the scanner literally could not read (corrupt/undecodable)
    // land here — under-tagged files import via fallbacks instead. Surfaced
    // in the metadata center. Cleared and rebuilt on every scan/rescan.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS music_scan_issue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            reason TEXT NOT NULL,
            -- Came from a sounds-typed base. file_path is relative to whichever
            -- base was scanned, so nothing in the path itself can tell you.
            -- Sounds are excluded from the metadata center: they may carry tags
            -- but are never expected to.
            is_sound INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_music_scan_issue_library ON music_scan_issue(library_id)")
        .execute(&pool)
        .await?;

    // ── Import wizard state ───────────────────────────────────────────
    // A library under construction: which wizard stage it is at. Rows exist
    // only while setup is unfinished — completing the wizard DELETEs the row,
    // and its absence is what makes the library fully visible. Abandoned
    // setups persist here so the sidebar can show "Finish setup…" and resume.
    // stage: 'scan' | 'match' | 'review'.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS library_setup (
            library_id TEXT PRIMARY KEY,
            stage TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Duplicate-album dismissals ────────────────────────────────────
    // "Keep both" on a File-problems duplicate card. The key is a digest of
    // the albums' sorted track content hashes — the thing that made them
    // duplicates — so it survives rescans, retags and moves.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_duplicate_dismiss (
            library_id TEXT NOT NULL,
            key TEXT NOT NULL,
            dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (library_id, key),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Shape hints ───────────────────────────────────────────────────
    // Albums that look like ONE album (music_shape.rs): recomputed at the
    // end of every scan, read by the Albums page. Keyed on the member set
    // (a digest of the sorted album ids), so a "keep apart" answers exactly
    // that group and a changed group is a new question.
    // A cache, recomputed whole at every scan (and on the page's first
    // visit): when its shape is behind the code, it's dropped and rebuilt
    // rather than altered — nothing in it is the person's.
    let shape_cols: Vec<(i64, String, String, i64, Option<String>, i64)> =
        sqlx::query_as("PRAGMA table_info(album_shape_hint)").fetch_all(&pool).await?;
    let shape_current = ["title", "disc_map"].iter().all(|want| shape_cols.iter().any(|c| &c.1 == want));
    if !shape_cols.is_empty() && !shape_current {
        sqlx::query("DROP TABLE album_shape_hint").execute(&pool).await?;
    }
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_shape_hint (
            library_id TEXT NOT NULL,
            key TEXT NOT NULL,
            kind TEXT NOT NULL,
            mode TEXT NOT NULL,
            confidence TEXT NOT NULL,
            reason TEXT NOT NULL,
            album_artist TEXT,
            title TEXT,
            disc_map TEXT,
            folder TEXT NOT NULL DEFAULT '',
            member_ids TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (library_id, key),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_shape_dismiss (
            library_id TEXT NOT NULL,
            key TEXT NOT NULL,
            dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (library_id, key),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── TMDB match attempts ───────────────────────────────────────────
    // Outcome of the last automatic TMDB match try for a movie/show entry
    // that DIDN'T settle it: 'notfound' (no results) or 'ambiguous' (results
    // but no confident winner). Feeds the video metadata center so unmatched
    // entries persist past the matching pass instead of evaporating with the
    // dialog. Applying a match (auto or manual) deletes the row.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tmdb_match_attempt (
            entry_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL,
            detail TEXT,
            attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (entry_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Loose-track containers ────────────────────────────────────────
    // Album entries marked here are invisible placeholder containers holding
    // tracks that have no album tag (per-artist), or no artist at all
    // (per-library, parented at the root). They keep the
    // artist→album→release→track chain uniform for playback/history/rescan
    // while the UI renders their tracks as loose tracks and excludes the
    // container from album grids and counts.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS loose_album (
            album_id INTEGER PRIMARY KEY,
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Artist image fetch stamps ─────────────────────────────────────
    // One row per settled fetch attempt (wikidata | deezer | notfound |
    // has-own). Transient errors are not stamped, so they retry on the next
    // pass. Deleting the row (the editor's re-fetch) re-runs the fetch.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS artist_image_fetch (
            artist_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (artist_id) REFERENCES artist(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── The tiered value store ────────────────────────────────────────
    // Every value waverunner holds for a field of an entity, by who said it:
    // 'tag' (what the file says — written by the scanner for every track
    // field of tag_fields.rs and the album's derived fields), 'mb' (what a
    // MusicBrainz match said), 'user' (what the user set). The effective
    // value is user, else a non-empty mb, else tag; the entity rows' columns
    // CACHE it, and the scanner (full or scoped) is what writes the cache —
    // every edit runs one. A track's upper tiers are the user's own layer of
    // tags: they go into the scan BEFORE grouping, so album membership,
    // release membership and every derived fact see them.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS field_override (
            entity_id INTEGER NOT NULL,
            field TEXT NOT NULL,
            tier TEXT NOT NULL,
            value TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (entity_id, field, tier),
            FOREIGN KEY (entity_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_field_override_tier ON field_override(tier, field)")
        .execute(&pool)
        .await?;

    // ── Playlist tables ───────────────────────────────────────────────

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS media_playlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            title TEXT NOT NULL,
            sort_title TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            sort_mode TEXT NOT NULL DEFAULT 'custom',
            selected_cover TEXT,
            selected_preset_id INTEGER,
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS media_playlist_collection (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            sort_title TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            sort_mode TEXT NOT NULL DEFAULT 'custom',
            selected_cover TEXT,
            selected_preset_id INTEGER,
            parent_playlist_id INTEGER,
            parent_collection_id INTEGER,
            FOREIGN KEY (parent_playlist_id) REFERENCES media_playlist(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_collection_id) REFERENCES media_playlist_collection(id) ON DELETE CASCADE,
            CHECK (
                (parent_playlist_id IS NOT NULL AND parent_collection_id IS NULL)
                OR (parent_playlist_id IS NULL AND parent_collection_id IS NOT NULL)
            )
        )",
    )
    .execute(&pool)
    .await?;

    // ── Saved custom sort presets ─────────────────────────────────────
    // scope_key identifies the sortable location (see sort_scope::scope_key_for on the frontend).
    // items is a JSON array — shape depends on scope: library scopes carry {kind:"entry",id},
    // playlist scopes carry {kind:"link",id} | {kind:"collection",id}.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sort_preset (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_key TEXT NOT NULL,
            name TEXT NOT NULL,
            items TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (scope_key, name)
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sort_preset_scope ON sort_preset(scope_key)",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS media_link (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_entry_id INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            selected_cover TEXT,
            parent_playlist_id INTEGER,
            parent_collection_id INTEGER,
            FOREIGN KEY (target_entry_id) REFERENCES media_entry(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_playlist_id) REFERENCES media_playlist(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_collection_id) REFERENCES media_playlist_collection(id) ON DELETE CASCADE,
            CHECK (
                (parent_playlist_id IS NOT NULL AND parent_collection_id IS NULL)
                OR (parent_playlist_id IS NULL AND parent_collection_id IS NOT NULL)
            )
        )",
    )
    .execute(&pool)
    .await?;

    // ── Third-party ratings (OMDB: IMDb, Rotten Tomatoes, Metacritic) ─
    // Fetched lazily the first time a detail page wants them, then cached.
    // source 'none' is a sentinel marking "fetch attempted, nothing found" so
    // we don't hammer OMDB for unrated/unknown titles on every page view.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS rating (
            entry_id INTEGER NOT NULL,
            source TEXT NOT NULL,
            value TEXT NOT NULL,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (entry_id, source),
            FOREIGN KEY (entry_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Extras (featurettes, trailers, webisodes, ...) ───────────────
    // Bonus videos found in reserved subfolders of a movie/show folder. Owned by
    // the media_entry, categorized by the folder they came from. Deliberately NOT
    // seasons/episodes: they never affect season counts, autoplay, or grids.
    // plot/release_date/runtime are TMDB-populated where a source exists
    // (webisodes match against the show's TMDB season 0).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS extra (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            file_path TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            plot TEXT,
            release_date TEXT,
            runtime INTEGER,
            FOREIGN KEY (owner_id) REFERENCES media_entry(id) ON DELETE CASCADE,
            UNIQUE (owner_id, file_path)
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_extra_owner ON extra(owner_id, kind)")
        .execute(&pool)
        .await?;

    // ── Rotten Tomatoes slug cache for shows ──────────────────────────
    // Movies cache their RT slug in movie.rotten_tomatoes_id; shows use this
    // side table.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS rt_slug (
            entry_id INTEGER PRIMARY KEY,
            slug TEXT NOT NULL,
            FOREIGN KEY (entry_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Favorite people ───────────────────────────────────────────────
    // Pinned to the top of alphabetical people views.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS favorite_person (
            person_id INTEGER PRIMARY KEY,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Notes ─────────────────────────────────────────────────────────
    // The user's free-text note on anything with a page of its own (a
    // playlist calls it a description). One table per id space, each
    // cascading with its owner. App data only: never written to files,
    // never seeded from tags. See notes.rs.
    for stmt in [
        "CREATE TABLE IF NOT EXISTS entry_note (
            entry_id INTEGER PRIMARY KEY,
            text TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (entry_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS person_note (
            person_id INTEGER PRIMARY KEY,
            text TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS playlist_note (
            playlist_id INTEGER PRIMARY KEY,
            text TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (playlist_id) REFERENCES media_playlist(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS playlist_collection_note (
            collection_id INTEGER PRIMARY KEY,
            text TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (collection_id) REFERENCES media_playlist_collection(id) ON DELETE CASCADE
        )",
    ] {
        sqlx::query(stmt).execute(&pool).await?;
    }

    // ── TMDB fetch stamps per season ──────────────────────────────────
    // Which TMDB passes have run for a season ('season' metadata pass,
    // 'episodes' pass). The bulk-match dialog counts only unstamped work —
    // without this, seasons TMDB has sparse data for (no overview, undated
    // episodes) would show as pending and refetch on every run.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tmdb_season_fetch (
            season_id INTEGER NOT NULL,
            pass TEXT NOT NULL,
            PRIMARY KEY (season_id, pass),
            FOREIGN KEY (season_id) REFERENCES season(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Interactive titles (Netflix-style branching video) ───────────
    // Sidecar marking a movie entry as interactive: the scanner found a
    // matched manifest + info JSON pair next to the video. Filenames are
    // stored relative to the entry folder (detection is content-based, so
    // the names vary per pack).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS interactive_title (
            entry_id INTEGER PRIMARY KEY,
            manifest_file TEXT NOT NULL,
            info_file TEXT NOT NULL,
            FOREIGN KEY (entry_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Persistent story state per interactive title (the format's
    // 'persistentState' scope — "remembers your choices" across playthroughs).
    // JSON object of key -> value. Deleted by \"Reset story\".
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS interactive_state (
            entry_id INTEGER PRIMARY KEY,
            persistent_json TEXT NOT NULL,
            FOREIGN KEY (entry_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Watch history ─────────────────────────────────────────────────
    // Progress + watched state, written by the player event loop every ~5s of
    // playback. position_secs is the resume point — NULL when there isn't one
    // (finished, or never got past the 30s noise floor). watched flips at
    // ≥95% or ≤60s remaining and is sticky across rewatches. Keyed on ids,
    // which rescans keep stable for unchanged paths (and, with file hashing,
    // for renamed/moved files too).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS movie_watch (
            entry_id INTEGER PRIMARY KEY,
            position_secs REAL,
            duration_secs REAL,
            watched INTEGER NOT NULL DEFAULT 0,
            watched_at TEXT,
            last_played_at TEXT,
            FOREIGN KEY (entry_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS episode_watch (
            episode_id INTEGER PRIMARY KEY,
            position_secs REAL,
            duration_secs REAL,
            watched INTEGER NOT NULL DEFAULT 0,
            watched_at TEXT,
            last_played_at TEXT,
            FOREIGN KEY (episode_id) REFERENCES episode(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Mid-story resume for interactive titles (percent-complete is meaningless
    // there). JSON payload: current segment + offset, story clock, both state
    // scopes, and the traversal/snapshot stack — written by the interactive
    // driver, cleared when an ending is reached (which sets movie_watch.watched).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS interactive_resume (
            entry_id INTEGER PRIMARY KEY,
            resume_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (entry_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Selected backdrop per entry ───────────────────────────────────
    // Covers any entry type that grows a backdrop. The path references
    // cached_images.cached_path with image_type='backdrop'.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS selected_backdrop (
            entry_id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            FOREIGN KEY (entry_id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS cached_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            entry_folder_path TEXT NOT NULL,
            image_type TEXT NOT NULL,
            source_filename TEXT NOT NULL,
            cached_path TEXT NOT NULL,
            -- origin: 'library' = image found inside the (read-only) media folders;
            -- 'app' = image added through waverunner, original stored in app-data.
            -- Cache syncs are scoped per-origin so one source never clobbers the other.
            origin TEXT NOT NULL DEFAULT 'library',
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE,
            UNIQUE(library_id, entry_folder_path, image_type, source_filename)
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_cached_images_entry
            ON cached_images(library_id, entry_folder_path, image_type)",
    )
    .execute(&pool)
    .await?;

    // ── Convenience view ──────────────────────────────────────────────

    sqlx::query(
        "CREATE VIEW IF NOT EXISTS media_entry_full AS
         SELECT me.id, me.library_id, me.parent_id, me.entry_type_id, met.name as entry_type,
             COALESCE(m.title, s.title, c.title, ar.title, al.title, t.title) as title,
             COALESCE(m.folder_path, s.folder_path, c.folder_path, ar.folder_path, al.folder_path) as folder_path,
             COALESCE(m.sort_title, s.sort_title, c.sort_title, ar.sort_title, al.sort_title, t.sort_title) as sort_title,
             COALESCE(m.sort_order, s.sort_order, c.sort_order, ar.sort_order, al.sort_order, t.sort_order) as sort_order,
             COALESCE(m.release_date, al.release_date) as release_date,
             COALESCE(m.selected_cover, s.selected_cover, c.selected_cover, ar.selected_cover, al.selected_cover) as selected_cover,
             t.file_path as track_file_path,
             t.track_number,
             t.disc_number
         FROM media_entry me
         JOIN media_entry_type met ON me.entry_type_id = met.id
         LEFT JOIN movie m ON me.id = m.id
         LEFT JOIN show s ON me.id = s.id
         LEFT JOIN media_collection c ON me.id = c.id
         LEFT JOIN artist ar ON me.id = ar.id
         LEFT JOIN album al ON me.id = al.id
         LEFT JOIN track t ON me.id = t.id",
    )
    .execute(&pool)
    .await?;

    // ── Epoch stamp ───────────────────────────────────────────────────
    // Written once, when the database is born at this schema.
    if fresh {
        sqlx::query("INSERT OR IGNORE INTO schema_epoch (epoch, app_version) VALUES (?, ?)")
            .bind(SCHEMA_EPOCH)
            .bind(env!("CARGO_PKG_VERSION"))
            .execute(&pool)
            .await?;
    }

    Ok(pool)
}
