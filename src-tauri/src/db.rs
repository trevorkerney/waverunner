use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::path::Path;

/// One schema change, applied exactly once and recorded.
///
/// `id` orders them and is the key — NOT the app version, because two
/// migrations can ship in one release and because "alpha.12.10" sorts before
/// "alpha.12.4" as a string. `app_version` is a label: it lands in the
/// schema_version row so the table reads as a history of what shipped when.
///
/// Statements run in order inside one transaction per migration. Keep them
/// additive where you can — an older build ignores an unknown column the same
/// as an unknown table, so an additive migration leaves a downgrade possible.
/// A DROP does not, which is what the pre-migration backup is for.
struct Migration {
    id: i64,
    app_version: &'static str,
    description: &'static str,
    /// Skip (and record as done) when this table isn't present. A migration
    /// that only moves data out of a table is vacuously complete on a database
    /// that never had it — which is the normal case for a table that only ever
    /// existed in development, and the reason this field exists.
    requires_table: Option<&'static str>,
    statements: &'static [&'static str],
}

/// Adding a column and emptying the old table are kept as SEPARATE migrations
/// on purpose: the column is needed by every database, the backfill only by
/// the ones that have something to backfill.
const MIGRATIONS: &[Migration] = &[
    Migration {
        id: 1,
        app_version: "1.0.0-alpha.12.5",
        description: "album.mb_release_group_id column",
        requires_table: None,
        statements: &["ALTER TABLE album ADD COLUMN mb_release_group_id TEXT"],
    },
    Migration {
        id: 2,
        app_version: "1.0.0-alpha.12.5",
        description: "move album_mb into album, drop it",
        requires_table: Some("album_mb"),
        statements: &[
            "UPDATE album SET mb_release_group_id =
                (SELECT mb_release_group_id FROM album_mb WHERE album_mb.album_id = album.id)
             WHERE EXISTS (SELECT 1 FROM album_mb WHERE album_mb.album_id = album.id)",
            "DROP TABLE album_mb",
        ],
    },
    Migration {
        id: 3,
        app_version: "1.0.0-alpha.12.5",
        description: "person.biography column",
        requires_table: None,
        statements: &["ALTER TABLE person ADD COLUMN biography TEXT"],
    },
    Migration {
        id: 4,
        app_version: "1.0.0-alpha.12.5",
        description: "move person_meta into person, drop it",
        requires_table: Some("person_meta"),
        statements: &[
            "UPDATE person SET biography =
                (SELECT biography FROM person_meta WHERE person_meta.person_id = person.id)
             WHERE EXISTS (SELECT 1 FROM person_meta WHERE person_meta.person_id = person.id)",
            "DROP TABLE person_meta",
        ],
    },
    Migration {
        id: 5,
        app_version: "1.0.0-alpha.12.5",
        description: "album_combine target_folder/source_name/target_name columns",
        requires_table: None,
        statements: &[
            "ALTER TABLE album_combine ADD COLUMN target_folder TEXT",
            "ALTER TABLE album_combine ADD COLUMN source_name TEXT",
            "ALTER TABLE album_combine ADD COLUMN target_name TEXT",
        ],
    },
    Migration {
        id: 6,
        app_version: "1.0.0-alpha.12.5",
        description: "move album_combine_meta into album_combine, drop it",
        requires_table: Some("album_combine_meta"),
        statements: &[
            "UPDATE album_combine SET
                target_folder = (SELECT target_folder FROM album_combine_meta m WHERE m.combine_id = album_combine.id),
                source_name   = (SELECT source_name   FROM album_combine_meta m WHERE m.combine_id = album_combine.id),
                target_name   = (SELECT target_name   FROM album_combine_meta m WHERE m.combine_id = album_combine.id)
             WHERE EXISTS (SELECT 1 FROM album_combine_meta m WHERE m.combine_id = album_combine.id)",
            "DROP TABLE album_combine_meta",
        ],
    },
    Migration {
        id: 7,
        app_version: "1.0.0-alpha.12.5",
        description: "carry existing MusicBrainz ids into field_override",
        requires_table: None,
        // Until now an album's matched RELEASE id lived only on its
        // album_release row, which every rescan deletes and rebuilds from file
        // tags — so matches quietly lost the one fact identifying what they
        // matched. Both ids move to the app-owned store here; without this,
        // every already-matched album would read as unmatched after the update.
        statements: &[
            "INSERT OR IGNORE INTO field_override (entity_id, field, tier, value)
             SELECT id, 'mb_release_group_id', 'mb', mb_release_group_id FROM album
             WHERE mb_release_group_id IS NOT NULL AND mb_release_group_id <> ''",
            "INSERT OR IGNORE INTO field_override (entity_id, field, tier, value)
             SELECT album_id, 'mb_release_id', 'mb', mb_release_id FROM album_release
             WHERE is_default = 1 AND mb_release_id IS NOT NULL AND mb_release_id <> ''",
            "INSERT OR IGNORE INTO field_override (entity_id, field, tier, value)
             SELECT id, 'mb_artist_id', 'mb', musicbrainz_id FROM artist
             WHERE musicbrainz_id IS NOT NULL AND musicbrainz_id <> ''",
        ],
    },
    Migration {
        id: 8,
        app_version: "1.0.0-alpha.12.5",
        description: "group mb_change_log rows into per-action batches",
        requires_table: None,
        // A match logs one row per KIND of change (credits, type, date), so
        // undoing "this album's match" meant undoing several entries. Rows are
        // grouped into the action that wrote them: a run of consecutive rows
        // sharing a target. Contiguity matters — two separate merges into the
        // same artist are two actions and must not collapse into one.
        statements: &[
            "ALTER TABLE mb_change_log ADD COLUMN batch_id INTEGER",
            "WITH marked AS (
                SELECT id,
                       CASE WHEN LAG(target_id) OVER (ORDER BY id) IS target_id
                                 AND kind <> 'artist_merge'
                            THEN 0 ELSE 1 END AS starts
                FROM mb_change_log
             ),
             grouped AS (
                SELECT id, SUM(starts) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS batch
                FROM marked
             )
             UPDATE mb_change_log
             SET batch_id = (SELECT batch FROM grouped WHERE grouped.id = mb_change_log.id)",
        ],
    },
    Migration {
        id: 9,
        app_version: "1.0.0-alpha.12.5",
        description: "split change batches that mix reverted and live rows",
        requires_table: None,
        // Batches were briefly inferred from row adjacency, which merged a
        // re-match into the batch of the match it replaced. An action is
        // either undone or it isn't, so a batch holding both is two actions:
        // the reverted rows move to a fresh id (max + old, so ordering is kept
        // and no new id can collide with an existing one).
        statements: &[
            "UPDATE mb_change_log
             SET batch_id = (SELECT MAX(batch_id) FROM mb_change_log) + batch_id
             WHERE undone = 1
               AND batch_id IN (
                 SELECT batch_id FROM mb_change_log
                 GROUP BY batch_id HAVING COUNT(DISTINCT undone) > 1
               )",
        ],
    },
    Migration {
        id: 10,
        app_version: "1.0.0-alpha.12.5",
        description: "music_scan_issue.is_sound",
        requires_table: None,
        statements: &["ALTER TABLE music_scan_issue ADD COLUMN is_sound INTEGER NOT NULL DEFAULT 0"],
    },
    Migration {
        id: 11,
        app_version: "1.0.0-alpha.12.5",
        description: "retry artist lookups that failed on punctuation",
        requires_table: None,
        // Artist names were compared byte-for-byte, so MusicBrainz's
        // typographic hyphens and apostrophes turned score-100 matches into
        // cached misses. The comparison now normalises; drop the poisoned
        // cache entries so those names get another look.
        statements: &["DELETE FROM mb_artist_lookup WHERE status = 'notfound'"],
    },
    Migration {
        id: 12,
        app_version: "1.0.0-alpha.12.5",
        description: "feat_join — comma-bearing artist names kept whole",
        requires_table: None,
        statements: &[
            "CREATE TABLE IF NOT EXISTS feat_join (
                library_id TEXT NOT NULL,
                name TEXT NOT NULL,
                PRIMARY KEY (library_id, name),
                FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
            )",
        ],
    },
    Migration {
        id: 13,
        app_version: "1.0.0-alpha.12.5",
        description: "credit rows carry artist_id; every album gets credit rows",
        requires_table: None,
        // Credits stop being resolved by name at read time: each row gets the
        // id of the artist it refers to, stamped once. Solo albums — which
        // carried no credit rows and were attributed through their folder
        // parent — get their one row here, so album↔artist membership has a
        // single source. The LOWER() backfill is ASCII-folding; the Rust
        // resolution pass re-stamps with proper Unicode casing on next scan.
        // No FOREIGN KEY on artist_id (soft reference — see CREATE TABLE).
        statements: &[
            "ALTER TABLE track_credit ADD COLUMN artist_id INTEGER",
            "ALTER TABLE album_artist_credit ADD COLUMN artist_id INTEGER",
            "UPDATE track_credit SET artist_id = (
                SELECT MIN(an.artist_id) FROM artist_names an
                JOIN media_entry ame ON ame.id = an.artist_id
                JOIN media_entry tme ON tme.id = track_credit.track_id
                WHERE ame.library_id = tme.library_id
                  AND LOWER(an.name) = LOWER(track_credit.name))",
            "UPDATE album_artist_credit SET artist_id = (
                SELECT MIN(an.artist_id) FROM artist_names an
                JOIN media_entry ame ON ame.id = an.artist_id
                JOIN media_entry alme ON alme.id = album_artist_credit.album_id
                WHERE ame.library_id = alme.library_id
                  AND LOWER(an.name) = LOWER(album_artist_credit.name))",
            "INSERT INTO album_artist_credit (album_id, position, name, artist_id)
             SELECT al.id, 0, a.title, a.id FROM album al
             JOIN media_entry me ON me.id = al.id
             JOIN artist a ON a.id = me.parent_id
             WHERE NOT EXISTS (SELECT 1 FROM album_artist_credit ac WHERE ac.album_id = al.id)
               AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
               AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)",
        ],
    },
    Migration {
        id: 14,
        app_version: "1.0.0-alpha.12.5",
        description: "retract name-derived artist matches",
        requires_table: None,
        // Every mb-tier artist id to date came from a name search that took
        // MusicBrainz's first exact-name hit — which is how "God" on Yeezus
        // matched a random artist named God. Identity now derives only from
        // matched albums' credits (which carry per-artist MBIDs) or from the
        // user. Retract the name-derived ids and the lookup cache; the next
        // matching pass re-stamps every artist a matched album vouches for.
        // User-tier matches (their decision) keep both the override and the
        // mirrored column value.
        statements: &[
            "DELETE FROM field_override WHERE field = 'mb_artist_id' AND tier = 'mb'",
            "UPDATE artist SET musicbrainz_id = NULL
             WHERE musicbrainz_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM field_override f
                               WHERE f.entity_id = artist.id AND f.field = 'mb_artist_id')",
            "DELETE FROM mb_artist_lookup",
        ],
    },
    Migration {
        id: 15,
        app_version: "1.0.0-alpha.12.5",
        description: "regenerate artist-match suggestions with exact-name candidates",
        requires_table: None,
        // The first cut of "Which artist is this?" picked candidates by MB
        // search score, which ranks famous partial-name matches above obscure
        // exact ones — "Castro" offered Cristian, Fidel, and Tommy Castro and
        // cut every artist literally named Castro. Unanswered (pending) and
        // silently-settled (notfound) rows regenerate under the exact-name
        // rule on the next pass; the user's accepted/rejected decisions are
        // answers and stand.
        statements: &[
            "DELETE FROM mb_suggestion
             WHERE kind = 'artist_match' AND status IN ('pending', 'notfound')",
        ],
    },
    Migration {
        id: 16,
        app_version: "1.0.0-alpha.12.5",
        description: "regenerate artist-match suggestions with alias-aware candidates",
        requires_table: None,
        // Candidate selection now counts an ALIAS hit as answering to the
        // name, not just the title — a renamed artist ("Hodgy Beats" →
        // "Hodgy") answers through their alias, and title-only matching
        // offered the bare duplicate while hiding the canonical entity.
        // Unanswered/silently-settled rows regenerate on the next pass;
        // answered ones stand.
        statements: &[
            "DELETE FROM mb_suggestion
             WHERE kind = 'artist_match' AND status IN ('pending', 'notfound')",
        ],
    },
    Migration {
        id: 17,
        app_version: "1.0.0-alpha.12.5",
        description: "regenerate artist-match suggestions from a deep search",
        requires_table: None,
        // The sweep searched MB with limit 10, and MB orders by FAME — an
        // exact-name obscure artist can sit at #12 behind famous partial
        // matches and never reach the filter ("Castro" showed two of its
        // three namesakes). The sweep now searches a page of 50. Same
        // regeneration rule as 15/16: answers stand.
        statements: &[
            "DELETE FROM mb_suggestion
             WHERE kind = 'artist_match' AND status IN ('pending', 'notfound')",
        ],
    },
    Migration {
        id: 18,
        app_version: "1.0.0-alpha.12.5",
        description: "regenerate artist-match suggestions with alias-field search",
        requires_table: None,
        // MB's artist: search field matches names only — entities answering
        // through an ALIAS were never returned at all, so a renamed artist's
        // canonical entity ("Hodgy", alias "Hodgy Beats") lost to its bare
        // duplicate by absence. The query now includes alias:. Same
        // regeneration rule as 15–17: answers stand; unanswered and
        // silently-settled rows re-ask on the next pass.
        statements: &[
            "DELETE FROM mb_suggestion
             WHERE kind = 'artist_match' AND status IN ('pending', 'notfound')",
        ],
    },
    Migration {
        id: 19,
        app_version: "1.0.0-alpha.12.5",
        description: "regenerate artist-match suggestions without the score floor",
        requires_table: None,
        // The OR alias: query dilutes lucene scores, and search_artists'
        // score>=50 floor silently cut obscure exact-name artists from the
        // lineups (Castro's namesakes vanished). The floor is gone — the
        // exact name/alias filter is the gatekeeper. Same regeneration rule
        // as 15–18: answers stand.
        statements: &[
            "DELETE FROM mb_suggestion
             WHERE kind = 'artist_match' AND status IN ('pending', 'notfound')",
        ],
    },
    Migration {
        id: 20,
        app_version: "1.0.0-alpha.12.5",
        description: "albums live on their credit rows — drop the artist parent",
        requires_table: Some("album_artist_credit"),
        // The artist→album parent edge is retired: membership on artist pages
        // is album_artist_credit alone. Backfill a solo credit row (stamped
        // with the parent's id) for any album that still lacks rows, then
        // null the parent on every real album. Loose containers KEEP their
        // parent — they're per-artist infrastructure, not credited albums.
        statements: &[
            "INSERT INTO album_artist_credit (album_id, position, name, artist_id)
             SELECT al.id, 0, a.title, a.id FROM album al
             JOIN media_entry me ON me.id = al.id
             JOIN artist a ON a.id = me.parent_id
             WHERE NOT EXISTS (SELECT 1 FROM album_artist_credit ac WHERE ac.album_id = al.id)
               AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id)
               AND NOT EXISTS (SELECT 1 FROM sound_album sa WHERE sa.album_id = al.id)",
            "UPDATE media_entry SET parent_id = NULL
             WHERE id IN (SELECT al.id FROM album al
                          JOIN media_entry me2 ON me2.id = al.id
                          WHERE me2.parent_id IS NOT NULL
                            AND NOT EXISTS (SELECT 1 FROM loose_album la WHERE la.album_id = al.id))",
        ],
    },
    Migration {
        id: 21,
        app_version: "1.0.0-alpha.12.5",
        description: "retract guessed images for unidentified artists",
        requires_table: Some("artist_image_fetch"),
        // The image sweep used to run for UNMATCHED artists too, where the
        // Deezer fallback is a name search — a same-named stranger's face on
        // an unidentified page. The sweep now requires an MBID; this clears
        // the guessed results (fetched rows + one-shot stamps) for artists
        // still unidentified, so they re-enter the queue the pass after
        // they're matched. A fetched image the user explicitly SELECTED is
        // kept — picking it made it a user choice, not a guess.
        statements: &[
            "DELETE FROM cached_images
             WHERE origin = 'fetched'
               AND entry_folder_path LIKE '_fetched/artists/%'
               AND EXISTS (SELECT 1 FROM artist a
                           WHERE a.id = CAST(SUBSTR(entry_folder_path, 18) AS INTEGER)
                             AND (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')
                             AND (a.selected_cover IS NULL
                                  OR a.selected_cover <> cached_images.source_filename))",
            "DELETE FROM artist_image_fetch
             WHERE status <> 'has-own'
               AND artist_id IN (SELECT a.id FROM artist a
                                 WHERE a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')",
        ],
    },
    Migration {
        id: 22,
        app_version: "1.0.0-alpha.12.5",
        description: "staged changes become undoable (kind/target/payload columns)",
        requires_table: Some("pending_change"),
        // Existing rows keep the defaults: kind '' marks a legacy row whose
        // directive can't be reverted from here — un-staging one only removes
        // the label.
        statements: &[
            "ALTER TABLE pending_change ADD COLUMN kind TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE pending_change ADD COLUMN target TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE pending_change ADD COLUMN payload TEXT NOT NULL DEFAULT '{}'",
        ],
    },
    Migration {
        id: 23,
        app_version: "1.0.0-alpha.12.5",
        description: "pending_pass queue — matches waiting for a matching pass, backfilled",
        requires_table: Some("album_artist_credit"),
        // The backfill derives what the queue would already contain had it
        // existed: matched albums whose credits still name an unidentified,
        // non-ignored artist — exactly the matches a pass has yet to cash in.
        statements: &[
            "CREATE TABLE IF NOT EXISTS pending_pass (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                library_id TEXT NOT NULL,
                target TEXT NOT NULL DEFAULT '',
                label TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
            )",
            "INSERT INTO pending_pass (library_id, target, label)
             SELECT me.library_id, CAST(al.id AS TEXT), 'Match \u{201c}' || al.title || '\u{201d}'
             FROM album al
             JOIN media_entry me ON me.id = al.id
             WHERE EXISTS (SELECT 1 FROM field_override o
                           WHERE o.entity_id = al.id
                             AND o.field IN ('mb_release_id', 'mb_release_group_id')
                             AND o.value IS NOT NULL AND o.value <> '')
               AND EXISTS (
                 SELECT 1 FROM artist a
                 WHERE (a.musicbrainz_id IS NULL OR a.musicbrainz_id = '')
                   AND NOT EXISTS (SELECT 1 FROM field_override oa
                                   WHERE oa.entity_id = a.id AND oa.field = 'mb_artist_id'
                                     AND oa.value IS NOT NULL AND oa.value <> '')
                   AND NOT EXISTS (SELECT 1 FROM field_override ig
                                   WHERE ig.entity_id = a.id AND ig.field = 'mb_ignored')
                   AND (a.id IN (SELECT ac.artist_id FROM album_artist_credit ac
                                 WHERE ac.album_id = al.id AND ac.artist_id IS NOT NULL)
                     OR a.id IN (SELECT tc.artist_id FROM track_credit tc
                                 JOIN media_entry tme ON tme.id = tc.track_id
                                 WHERE tme.parent_id = al.id AND tc.artist_id IS NOT NULL)))",
        ],
    },
    Migration {
        id: 24,
        app_version: "1.0.0-alpha.12.5",
        description: "track.audio_hash — content fingerprint for rescan identity migration",
        requires_table: Some("track"),
        // Backfilled by the next rescan (the scanner hashes every file it
        // reads); NULL until then just means no rescue hint yet.
        statements: &["ALTER TABLE track ADD COLUMN audio_hash TEXT"],
    },
    Migration {
        id: 25,
        app_version: "1.0.0-alpha.12.5",
        description: "movie/episode content fingerprints (+ size/mtime gate) for rescan identity",
        requires_table: Some("movie"),
        // Backfilled by the next video rescan. The size/mtime pair is the
        // gate: unchanged means the stored hash still describes the file, so
        // a rescan re-reads nothing and stays as fast as it is today.
        statements: &[
            "ALTER TABLE movie ADD COLUMN content_hash TEXT",
            "ALTER TABLE movie ADD COLUMN content_size INTEGER",
            "ALTER TABLE movie ADD COLUMN content_mtime INTEGER",
            "ALTER TABLE episode ADD COLUMN content_hash TEXT",
            "ALTER TABLE episode ADD COLUMN content_size INTEGER",
            "ALTER TABLE episode ADD COLUMN content_mtime INTEGER",
            "ALTER TABLE show ADD COLUMN content_hash TEXT",
            "ALTER TABLE show ADD COLUMN content_size INTEGER",
            "ALTER TABLE show ADD COLUMN content_mtime INTEGER",
        ],
    },
];

/// Copy the database beside itself before the first migration of a run
/// touches it. Cheap (a file copy) and the only real answer to a migration
/// that turns out to be wrong about production data.
fn backup_before_migrating(db_path: &Path, from: i64, to: i64) {
    let backup = db_path.with_extension(format!("v{from}-to-v{to}.bak"));
    if backup.exists() {
        return;
    }
    match std::fs::copy(db_path, &backup) {
        Ok(_) => eprintln!("[db] backed up to {}", backup.display()),
        Err(e) => eprintln!("[db] WARNING: backup failed ({e}) — migrating anyway"),
    }
}

/// Record every migration as applied without running any of it. For a
/// database created moments ago by the CREATE statements, which already
/// describe the post-migration shape.
async fn baseline_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    ensure_schema_version(pool).await?;
    for m in MIGRATIONS {
        sqlx::query(
            "INSERT OR IGNORE INTO schema_version (id, app_version, description)
             VALUES (?, ?, ?)",
        )
        .bind(m.id)
        .bind(m.app_version)
        .bind(m.description)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn ensure_schema_version(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_version (
            id INTEGER PRIMARY KEY,
            app_version TEXT NOT NULL,
            description TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Apply every migration above the recorded schema version, in order, each in
/// its own transaction so a failure leaves the database on the last good one.
async fn run_migrations(pool: &SqlitePool, db_path: &Path) -> Result<(), sqlx::Error> {
    ensure_schema_version(pool).await?;

    let current: i64 = sqlx::query_as::<_, (Option<i64>,)>("SELECT MAX(id) FROM schema_version")
        .fetch_one(pool)
        .await?
        .0
        .unwrap_or(0);

    // Sorted by id, not by position: a migration written into the wrong slot
    // in the array would otherwise run out of order, and a failure part-way
    // could strand a lower id behind a higher recorded version.
    let mut pending: Vec<&Migration> = MIGRATIONS.iter().filter(|m| m.id > current).collect();
    pending.sort_by_key(|m| m.id);
    let Some(last) = pending.last() else { return Ok(()) };
    backup_before_migrating(db_path, current, last.id);

    for m in pending {
        // Foreign keys are enforced per-connection; a migration that rebuilds
        // or drops a table must not trip them mid-flight.
        sqlx::query("PRAGMA foreign_keys = OFF").execute(pool).await?;
        let mut tx = pool.begin().await?;
        let applicable = match m.requires_table {
            None => true,
            Some(table) => {
                sqlx::query_as::<_, (i64,)>(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
                )
                .bind(table)
                .fetch_one(&mut *tx)
                .await?
                .0 != 0
            }
        };
        if applicable {
            for stmt in m.statements {
                sqlx::query(stmt).execute(&mut *tx).await?;
            }
        } else {
            eprintln!("[db] migration {} vacuous (no {}) — recording", m.id, m.requires_table.unwrap_or(""));
        }
        sqlx::query("INSERT INTO schema_version (id, app_version, description) VALUES (?, ?, ?)")
            .bind(m.id)
            .bind(m.app_version)
            .bind(m.description)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        sqlx::query("PRAGMA foreign_keys = ON").execute(pool).await?;
        eprintln!("[db] migration {} applied — {}", m.id, m.description);
    }
    Ok(())
}

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

    // A database with no tables yet is about to be created at the CURRENT
    // schema, so every migration is already true of it. It gets baselined
    // below rather than migrated — running migration 1 against it would try
    // to drop an album_mb that never existed.
    let fresh: bool = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_one(&pool)
    .await?
    .0 == 0;

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
            -- Was the person_meta side table until migration 2.
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
            -- MusicBrainz release group (the album as a work, across pressings).
            -- Was the album_mb side table until migration 1.
            mb_release_group_id TEXT,
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
            audio_hash TEXT,
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

    // ── Track artist credits ──────────────────────────────────────────
    // Ordered credit list per track, parsed from tags at scan time: main
    // artist(s) first, then features (from the artist tag's "feat." clause,
    // multi-value ARTISTS frames, and "(feat. …)" title parentheticals).
    // name is the as-credited text (what the tag said); artist_id is WHO that
    // is — stamped by resolve_credit_ids after every pass that changes
    // credits or artists. NULL = unresolved. Deliberately not a FOREIGN KEY:
    // artist deletes (sweeps, merges) must not be blocked by stale stamps,
    // which the next resolution pass heals.
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
            -- The action that wrote this row: one match logs several rows
            -- (credits, type, date) and the review list undoes the action, not
            -- its parts. Added by migration 8.
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
            side TEXT NOT NULL,
            disc INTEGER NOT NULL,
            position INTEGER NOT NULL,
            title TEXT NOT NULL,
            counterpart TEXT,
            PRIMARY KEY (album_id, side, disc, position),
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
    // Ordered album-level artist credits ("Drake · Future") — THE record of
    // whose album this is. Every album carries rows, solo included; the
    // media_entry parent is only where the album lives (folder position,
    // cascade), never attribution. Fed by artist splits, multi-value
    // album-artist tags, and MusicBrainz credits. artist_id as on
    // track_credit: stamped by resolve_credit_ids, soft reference on purpose.
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
    // scoped to one library. First key: 'online_metadata' ("on"/"off",
    // absent = on) — whether this library talks to online providers at all
    // (MusicBrainz for music, TMDB/OMDB for video).
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

    // Directives staged since the last rescan, one row per user action
    // (split, combine, separate). The directives themselves are permanent and
    // rescan-idempotent; these rows only record "written but not yet applied"
    // so the UI can show what a rescan will do instead of forcing a rescan
    // per action. Cleared when a rescan completes.
    // kind/target/payload make a staged row UNDOABLE: kind names the directive
    // family, target is the dedup key (staging the same split twice replaces
    // the row instead of stacking), payload carries what the revert needs.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pending_change (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            label TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT '',
            target TEXT NOT NULL DEFAULT '',
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await?;

    // Matches waiting for a matching pass to cash them in (stamp the artists
    // their credits prove). Enqueued when an album match applies, removed on
    // unmatch, cleared wholesale by a completed pass — the pass-side twin of
    // pending_change above.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pending_pass (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_id TEXT NOT NULL,
            target TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL,
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
    // ("JAY-Z & Kanye West" → [JAY-Z, Kanye West]). Applied on every scan —
    // members[0] becomes the canonical parent, the full list becomes the
    // album's artist credits, and matching track credits split the same way.
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

    // ── Album splitting (the inverse of album_combine) ────────────────
    // A folder whose tracks must NOT group with the album their tags would
    // put them in — the user pulled this edition out of a multi-edition
    // album. Keyed by the RELEASE's folder (editions are folder-derived), so
    // it survives rescans; the scanner gives such a folder its own album.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS album_release_split (
            library_id TEXT NOT NULL,
            folder_path TEXT NOT NULL,
            PRIMARY KEY (library_id, folder_path),
            FOREIGN KEY (library_id) REFERENCES library(id) ON DELETE CASCADE
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
            -- Which edition a merge pours into, plus the names as they read at
            -- combine time (for the undo chip). Was album_combine_meta until
            -- migration 3.
            target_folder TEXT,
            source_name TEXT,
            target_name TEXT,
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

    // ── Schema migrations ─────────────────────────────────────────────
    // The CREATE statements above are idempotent and describe the schema as
    // it is TODAY. Migrations carry existing databases up to that shape.
    if fresh {
        baseline_migrations(&pool).await?;
    } else {
        run_migrations(&pool, db_path).await?;
    }

    Ok(pool)
}
