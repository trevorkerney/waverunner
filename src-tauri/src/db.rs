use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::path::Path;

pub async fn create_app_pool(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("PRAGMA foreign_keys = ON")
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .connect(&db_url)
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
            tmdb_id INTEGER
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
            FOREIGN KEY (id) REFERENCES media_entry(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

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
    // SQL keyword). label NULL = the plain/unnamed version (loose files in
    // the album folder). Most albums have exactly one row. The album/track
    // tables shipped before this model, so version membership and MBIDs
    // live in side tables (no ALTER migrations).
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
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_album_release_album ON album_release(album_id)")
        .execute(&pool)
        .await?;

    // Which release a track belongs to (track shipped without a release_id
    // column; side table instead of ALTER).
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

    // Per-track tag payload the frozen track table has no columns for:
    // display artist (may differ from the album artist — features,
    // compilations), embedded MusicBrainz ids, and technical facts.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track_meta (
            track_id INTEGER PRIMARY KEY,
            artist_name TEXT,
            mb_recording_id TEXT,
            codec TEXT,
            bitrate_kbps INTEGER,
            sample_rate_hz INTEGER,
            FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // MusicBrainz release-group id for an album (album table is frozen).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_mb (
            album_id INTEGER PRIMARY KEY,
            mb_release_group_id TEXT,
            FOREIGN KEY (album_id) REFERENCES album(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // ── Track artist credits ──────────────────────────────────────────
    // Ordered credit list per track, parsed from tags at scan time: main
    // artist(s) first, then features (from the artist tag's "feat." clause,
    // multi-value ARTISTS frames, and "(feat. …)" title parentheticals).
    // Names are display strings; a future MusicBrainz pass can canonicalize
    // them and create artist entries for feature-only names.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track_credit (
            track_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
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

    // ── Artist aliases ────────────────────────────────────────────────
    // Alternate spellings that resolve to an artist ("J Cole" → "J. Cole").
    // Written by accepted/auto merges; credit rows keep their RAW scanned
    // names and resolve through this layer, so merges are reversible.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS artist_alias (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            artist_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            FOREIGN KEY (artist_id) REFERENCES artist(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS idx_artist_alias_unique ON artist_alias(artist_id, name)")
        .execute(&pool)
        .await?;

    // Every name an artist answers to (title + aliases) — the join surface
    // for credit → artist resolution.
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

    // Everything the MusicBrainz pass auto-applied, with before/after values —
    // the transparency log shown in the modal. Undo restores `before_json`
    // and writes an mb_suppression row so the pass doesn't reapply.
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

    // ── Music play history ────────────────────────────────────────────
    // One row per playback START, however brief — recently-played shows all
    // of these. `scrobbled` flips once the Last.fm rule trips (>=50% of the
    // track or >=4 minutes of accumulated listening, whichever comes first);
    // stats and "real listen" surfaces read only scrobbled rows. played_secs =
    // seconds actually listened (seek jumps credit nothing; rows written
    // before 2026-07-22 hold the old furthest-position metric). There is
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

    // ── Loved tracks ──────────────────────────────────────────────────
    // Presence of a row = the track is loved. Keyed on the track id, which
    // rescans preserve by file path — a loved track keeps its heart unless
    // its file moves out from under it (same durability as play history).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS track_loved (
            track_id INTEGER PRIMARY KEY,
            loved_at TEXT NOT NULL DEFAULT (datetime('now')),
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

    // ── Sounds domain (ambient/rain/etc inside a music library) ───────
    // library_path.kind has a baked CHECK ('movie','show','music') on existing
    // databases, so sounds bases are ordinary kind='music' rows plus a row
    // here. The scanner stamps albums found under these bases into
    // sound_album; music surfaces exclude sound-marked albums the same way
    // they exclude loose containers, and the Sounds node shows only them.
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

    // ── Album combine directives ──────────────────────────────────────
    // "These tag-albums are one album." Applied at scan time (both fresh
    // scans and rescans), so combines SURVIVE rescans — scans group strictly
    // by tags and would otherwise re-split them. Identities are lowercased
    // TAG values (album_artist + album), not DB titles, because that's what
    // the scanner groups by ('' artist = artist-less). mode: 'merge' (tracks
    // fold into the target's default release, keeping disc numbers) |
    // 'versions' (each source release becomes a version of the target).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_combine (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            source_artist TEXT NOT NULL,
            source_title TEXT NOT NULL,
            target_artist TEXT NOT NULL,
            target_title TEXT NOT NULL,
            mode TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
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

    // ── Per-field provenance overrides ────────────────────────────────
    // The user/external tiers of the field provenance model. The tag tier
    // lives in the regular columns (written by scans); effective value =
    // user override, else external override, else column. tier: 'user' |
    // 'external'. Scans never touch this table; external sources write only
    // the 'external' tier and only where the user elected them.
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

    // ── Cached images ─────────────────────────────────────────────────

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
    // Movies cache their RT slug in movie.rotten_tomatoes_id; the show table
    // predates ratings and has no such column, so shows use this side table
    // (no ALTER migrations).
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
    // Pinned to the top of alphabetical people views. Separate table (not a
    // column on person) so it needs no ALTER migrations.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS favorite_person (
            person_id INTEGER PRIMARY KEY,
            FOREIGN KEY (person_id) REFERENCES person(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

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
    // the names vary per pack). Separate table, not a movie column — no
    // ALTER migrations.
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
    // which rescans keep stable for unchanged paths (rename on disk = history
    // lost until file-hashing gives entries a durable identity).
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
    // Separate table (not a column on movie/show) so it needs no ALTER
    // migrations and covers any entry type that grows a backdrop later.
    // The path references cached_images.cached_path with image_type='backdrop'.
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

    Ok(pool)
}
