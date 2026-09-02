//! Discord Rich Presence — "Listening to waverunner" / "Watching waverunner".
//!
//! Local IPC (SET_ACTIVITY) only, no Social SDK: activity type Listening (2)
//! for music, Watching (3) for video. The member list shows "♪ <artist>" /
//! "Watching <title>" via status_display_type; the profile card gets the
//! title/artist lines, art, and a progress bar from start+end timestamps.
//!
//! Art must be an HTTPS URL (Discord's proxy can't reach localhost, and IPC
//! can't carry bytes), so matched albums use Cover Art Archive by release-group
//! MBID and matched video uses a TMDB poster looked up (and cached) from the
//! stored tmdb_id. Everything else falls back to the uploaded "waverunner"
//! asset from the dev portal.
//!
//! One worker thread owns the socket. Hooks are fire-and-forget senders — the
//! player paths never block on Discord, and every failure (no Discord running,
//! no app id pasted yet) degrades to silence with a reconnect cooldown.
//! Updates flow even while the setting is off so toggling it on mid-track
//! shows the current song immediately; the worker just doesn't transmit.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use discord_rich_presence::activity::{
    Activity, ActivityType, Assets, Button, StatusDisplayType, Timestamps,
};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use sqlx::SqlitePool;

/// Discord application id (dev portal → General Information). The app's NAME
/// there is the header text: "Listening to waverunner".
const DISCORD_APP_ID: &str = "1544563144234500098";

/// Uploaded asset keys (dev portal → Rich Presence → Art Assets).
const ASSET_LOGO: &str = "waverunner"; // fallback large image + music badge
const ASSET_FILM: &str = "film"; // small badge on video activities

/// Discord allows ~5 activity updates per 20s; stay well under it.
const MIN_SEND_GAP: Duration = Duration::from_secs(2);
/// Re-assert the current state on a cadence: Discord (like Spotify's own
/// integration) sometimes drops an update, and a periodic re-send self-heals
/// it. Also doubles as the reconnect prober when Discord starts after us.
const HEARTBEAT: Duration = Duration::from_secs(10);
/// After a failed connect/send, leave Discord alone for a while.
const RECONNECT_COOLDOWN: Duration = Duration::from_secs(15);
/// A time-pos this far off the last-transmitted anchor is a seek.
const SEEK_DRIFT_SECS: f64 = 4.0;

static ENABLED: AtomicBool = AtomicBool::new(false);
static TX: OnceLock<mpsc::Sender<Msg>> = OnceLock::new();

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Music,
    Video,
}

pub struct Media {
    pub kind: Kind,
    /// Bold line (track / movie / show title).
    pub details: String,
    /// Second line (artist / year / SxEy — episode title).
    pub state: String,
    /// HTTPS art URL; None → uploaded logo asset.
    pub large_image: Option<String>,
    pub large_text: String,
    pub button: Option<(String, String)>, // (label, url)
    pub duration: f64,
    pub position: f64,
    pub paused: bool,
}

enum Msg {
    Set(Box<Media>),
    Tick(Kind, f64),
    Pause(Kind, bool),
    Duration(Kind, f64),
    /// keep-open hold at EOF — nothing is playing, so the card goes away
    /// (same rule as pause).
    SoftEnd(Kind),
    Stop(Kind),
    /// The setting flipped — the worker re-reads the ENABLED atomic.
    Enabled,
}

// ---------------------------------------------------------------------------
// Public API — called from lib.rs setup, set_setting, and the player hooks.
// ---------------------------------------------------------------------------

pub fn init(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    if TX.set(tx).is_ok() {
        std::thread::spawn(move || Worker::default().run(rx));
    }
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    send(Msg::Enabled);
}

fn send(msg: Msg) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(msg);
    }
}

pub(crate) fn tick(kind: Kind, position: f64) {
    send(Msg::Tick(kind, position));
}

pub(crate) fn pause_changed(kind: Kind, paused: bool) {
    send(Msg::Pause(kind, paused));
}

pub(crate) fn duration_changed(kind: Kind, duration: f64) {
    send(Msg::Duration(kind, duration));
}

pub(crate) fn soft_end(kind: Kind) {
    send(Msg::SoftEnd(kind));
}

pub(crate) fn stopped(kind: Kind) {
    send(Msg::Stop(kind));
}

// ---------------------------------------------------------------------------
// Metadata lookups — build a Media from what the DB knows about the item.
// ---------------------------------------------------------------------------

/// A music track just started (manual play or native gapless advance).
pub(crate) async fn music_started(pool: SqlitePool, track_id: i64) {
    let row: Option<(String, Option<String>, Option<String>, Option<i64>, Option<i64>)> =
        sqlx::query_as(
            "SELECT t.title, tm.artist_name, al.title, al.id, t.runtime
             FROM track t
             LEFT JOIN track_meta tm ON tm.track_id = t.id
             LEFT JOIN media_entry me ON me.id = t.id
             LEFT JOIN media_entry alme ON alme.id = me.parent_id
             LEFT JOIN album al ON al.id = alme.id
             WHERE t.id = ?",
        )
        .bind(track_id)
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten();
    let Some((title, artist_name, album_title, album_id, runtime)) = row else {
        return;
    };
    // The properly separated credits, not the raw tag string (which still
    // carries "A;B" separators). Falls back to the tag, then the album's
    // first credit row.
    let credit_names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM track_credit WHERE track_id = ? ORDER BY position",
    )
    .bind(track_id)
    .fetch_all(&pool)
    .await
    .unwrap_or_default();
    let artist = if !credit_names.is_empty() {
        credit_names.join(", ")
    } else {
        match artist_name.filter(|a| !a.is_empty()) {
            Some(a) => a,
            None => match album_id {
                // "The artist" = the album's first credit row.
                Some(al) => sqlx::query_scalar::<_, String>(
                    "SELECT name FROM album_artist_credit WHERE album_id = ? ORDER BY position LIMIT 1",
                )
                .bind(al)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
                .unwrap_or_default(),
                None => String::new(),
            },
        }
    };
    // Matched album → Cover Art Archive art + a MusicBrainz button. When the
    // track's own release is pinned to an MB release AND that release has
    // cover art, prefer the exact pressing's cover over the group's.
    let mut large_image = None;
    let mut button = None;
    if let Some(al) = album_id {
        if let Ok(Some((group_id, _))) =
            crate::music_mb::mb_id(&pool, al, crate::music_mb::MB_RELEASE_GROUP).await
        {
            large_image = Some(format!(
                "https://coverartarchive.org/release-group/{group_id}/front-250"
            ));
            button = Some((
                "View on MusicBrainz".to_string(),
                format!("https://musicbrainz.org/release-group/{group_id}"),
            ));
        }
        let release_id: Option<String> = sqlx::query_scalar(
            "SELECT rm.mb_release_id
             FROM track_release tr
             JOIN album_release ar ON ar.id = tr.release_id
             JOIN release_match rm ON rm.album_id = ar.album_id
                  AND rm.folder_path = ar.folder_path COLLATE NOCASE
             WHERE tr.track_id = ? AND rm.mb_release_id <> ''",
        )
        .bind(track_id)
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten();
        if let Some(release_id) = release_id {
            if let Some(url) = caa_release_cover(&release_id).await {
                large_image = Some(url);
            }
        }
    }
    send(Msg::Set(Box::new(Media {
        kind: Kind::Music,
        details: title,
        state: artist,
        large_image,
        large_text: album_title.unwrap_or_default(),
        button,
        duration: runtime.unwrap_or(0) as f64,
        position: 0.0,
        paused: false,
    })));
}

/// The video player declared what it's about to play (set_watch_target).
pub(crate) async fn video_started(pool: SqlitePool, target: crate::watch::WatchTarget) {
    let media = match target {
        crate::watch::WatchTarget::Movie { entry_id } => {
            let row: Option<(String, Option<String>, Option<String>, Option<i64>)> =
                sqlx::query_as(
                    "SELECT title, release_date, tmdb_id, runtime FROM movie WHERE id = ?",
                )
                .bind(entry_id)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten();
            let Some((title, release_date, tmdb_id, runtime)) = row else {
                return;
            };
            let year = release_date
                .as_deref()
                .and_then(|d| d.get(..4))
                .unwrap_or("Movie")
                .to_string();
            let (large_image, button) = tmdb_art_and_button(&pool, "movie", tmdb_id).await;
            let large_text = format!("{title} ({year})");
            Media {
                kind: Kind::Video,
                details: title,
                state: year,
                large_image,
                large_text,
                button,
                // runtime is minutes from TMDB — mpv's duration property
                // corrects this within a second of playback starting.
                duration: runtime.unwrap_or(0) as f64 * 60.0,
                position: 0.0,
                paused: false,
            }
        }
        crate::watch::WatchTarget::Episode { episode_id } => {
            let row: Option<(String, Option<String>, Option<i64>, Option<i64>, Option<i64>, String, Option<i64>)> =
                sqlx::query_as(
                    "SELECT sh.title, sh.tmdb_id, se.season_number, e.episode_number,
                            e.episode_number_end, e.title, e.runtime
                     FROM episode e
                     JOIN season se ON se.id = e.season_id
                     JOIN show sh ON sh.id = se.show_id
                     WHERE e.id = ?",
                )
                .bind(episode_id)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten();
            let Some((show_title, tmdb_id, season, ep, ep_end, ep_title, runtime)) = row else {
                return;
            };
            let mut code = match (season, ep) {
                (Some(s), Some(e)) => format!("S{s:02}E{e:02}"),
                (None, Some(e)) => format!("E{e:02}"),
                _ => String::new(),
            };
            if let (Some(e), Some(end)) = (ep, ep_end) {
                if end > e {
                    code.push_str(&format!("-{end:02}"));
                }
            }
            let state = match (code.is_empty(), ep_title.is_empty()) {
                (false, false) => format!("{code} — {ep_title}"),
                (false, true) => code,
                (true, _) => ep_title,
            };
            let (large_image, button) = tmdb_art_and_button(&pool, "tv", tmdb_id).await;
            Media {
                kind: Kind::Video,
                details: show_title.clone(),
                state,
                large_image,
                large_text: show_title,
                button,
                duration: runtime.unwrap_or(0) as f64 * 60.0,
                position: 0.0,
                paused: false,
            }
        }
    };
    send(Msg::Set(Box::new(media)));
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("waverunner/1.0 (https://github.com/trevorkerney/waverunner)")
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default()
    })
}

/// The exact pressing's cover, if Cover Art Archive has one for this release.
/// Not every matched release has its own art — a blank card is worse than the
/// group cover — so existence is HEAD-checked once and cached per session.
async fn caa_release_cover(release_id: &str) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let url = format!("https://coverartarchive.org/release/{release_id}/front-250");
    if let Ok(map) = cache.lock() {
        if let Some(&exists) = map.get(release_id) {
            return exists.then(|| url);
        }
    }
    let exists = match http_client().head(&url).send().await {
        Ok(resp) => resp.status().is_success(),
        // Timeout/offline — fall back to the group cover but DON'T cache the
        // miss: the release may well have art once the network is back.
        Err(_) => return None,
    };
    if let Ok(mut map) = cache.lock() {
        map.insert(release_id.to_string(), exists);
    }
    exists.then(|| url)
}

/// Poster URL (via a cached TMDB detail fetch) + "View on TMDB" button for a
/// matched movie/show. `kind` is TMDB's path segment: "movie" or "tv".
async fn tmdb_art_and_button(
    pool: &SqlitePool,
    kind: &str,
    tmdb_id: Option<String>,
) -> (Option<String>, Option<(String, String)>) {
    let Some(id) = tmdb_id.filter(|t| !t.is_empty()) else {
        return (None, None);
    };
    let button = Some((
        "View on TMDB".to_string(),
        format!("https://www.themoviedb.org/{kind}/{id}"),
    ));
    (poster_url(pool, kind, &id).await, button)
}

/// The poster path isn't stored locally (covers are files), so ask TMDB once
/// per title and cache in-memory for the session. Absent token or network →
/// None, and the card falls back to the logo asset.
async fn poster_url(pool: &SqlitePool, kind: &str, tmdb_id: &str) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = format!("{kind}:{tmdb_id}");
    if let Ok(map) = cache.lock() {
        if let Some(hit) = map.get(&key) {
            return hit.clone();
        }
    }
    let token: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tmdb_api_token'")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let mut url = None;
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        let resp = http_client()
            .get(format!("https://api.themoviedb.org/3/{kind}/{tmdb_id}"))
            .bearer_auth(&token)
            .send()
            .await;
        if let Ok(resp) = resp {
            if resp.status().is_success() {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    url = body["poster_path"]
                        .as_str()
                        .map(|p| format!("https://image.tmdb.org/t/p/w342{p}"));
                }
            }
        }
    }
    if let Ok(mut map) = cache.lock() {
        map.insert(key, url.clone());
    }
    url
}

// ---------------------------------------------------------------------------
// Worker — owns the IPC socket, coalesces updates, rate-limits sends.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Worker {
    client: Option<DiscordIpcClient>,
    desired: Option<Media>,
    /// Anchor of the last-transmitted progress bar, for seek detection.
    shown_start_ms: Option<i64>,
    showing: bool,
    dirty: bool,
    last_send: Option<Instant>,
    retry_after: Option<Instant>,
}

impl Worker {
    fn run(mut self, rx: mpsc::Receiver<Msg>) {
        loop {
            match rx.recv_timeout(HEARTBEAT) {
                Ok(msg) => self.apply(msg),
                Err(RecvTimeoutError::Timeout) => {
                    // Heartbeat: re-send whatever we're showing (or should
                    // be). transmit() no-ops when there's nothing to show.
                    if self.desired.is_some() {
                        self.dirty = true;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
            // Coalesce the burst, then honor the send gap while still
            // absorbing whatever arrives during the wait.
            loop {
                loop {
                    match rx.try_recv() {
                        Ok(msg) => self.apply(msg),
                        Err(_) => break,
                    }
                }
                let elapsed = self.last_send.map(|t| t.elapsed());
                let wait = match elapsed {
                    Some(e) if e < MIN_SEND_GAP => MIN_SEND_GAP - e,
                    _ => break,
                };
                match rx.recv_timeout(wait) {
                    Ok(msg) => self.apply(msg),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        self.transmit();
                        return;
                    }
                }
            }
            self.transmit();
        }
    }

    fn apply(&mut self, msg: Msg) {
        match msg {
            Msg::Set(media) => {
                self.desired = Some(*media);
                self.dirty = true;
            }
            Msg::Tick(kind, pos) => {
                if let Some(m) = self.desired.as_mut().filter(|m| m.kind == kind) {
                    m.position = pos;
                    if !m.paused {
                        // Only a real seek moves the bar — normal playback
                        // matches the anchor and needs no re-send.
                        if let Some(start) = self.shown_start_ms {
                            let expected = (now_ms() - start) as f64 / 1000.0;
                            if (pos - expected).abs() > SEEK_DRIFT_SECS {
                                self.dirty = true;
                            }
                        }
                    }
                }
            }
            Msg::Pause(kind, paused) => {
                if let Some(m) = self.desired.as_mut().filter(|m| m.kind == kind) {
                    if m.paused != paused {
                        m.paused = paused;
                        self.dirty = true;
                    }
                }
            }
            Msg::Duration(kind, dur) => {
                if let Some(m) = self.desired.as_mut().filter(|m| m.kind == kind) {
                    if dur > 0.0 && (dur - m.duration).abs() > 2.0 {
                        m.duration = dur;
                        self.dirty = true;
                    }
                }
            }
            Msg::SoftEnd(kind) => {
                if let Some(m) = self.desired.as_mut().filter(|m| m.kind == kind) {
                    if !m.paused {
                        m.paused = true; // transmit treats paused as hidden
                        self.dirty = true;
                    }
                }
            }
            Msg::Stop(kind) => {
                if self.desired.as_ref().is_some_and(|m| m.kind == kind) {
                    self.desired = None;
                    self.dirty = true;
                }
            }
            Msg::Enabled => self.dirty = true,
        }
    }

    fn transmit(&mut self) {
        if !self.dirty {
            return;
        }
        if DISCORD_APP_ID.starts_with("PASTE") {
            self.dirty = false; // not configured — never touch the pipe
            return;
        }
        if self.retry_after.is_some_and(|t| Instant::now() < t) {
            return; // stay dirty; the next tick retries after the cooldown
        }
        let enabled = ENABLED.load(Ordering::SeqCst);
        // Paused (or queue-ended) playback shows NOTHING — the presence is
        // "what's playing right now", and resume brings it straight back.
        let show = enabled && self.desired.as_ref().is_some_and(|m| !m.paused);
        if !show {
            if self.showing {
                if let Some(client) = self.client.as_mut() {
                    if client.clear_activity().is_err() {
                        self.drop_client();
                    }
                }
                self.showing = false;
                self.shown_start_ms = None;
                self.last_send = Some(Instant::now());
            }
            self.dirty = false;
            return;
        }
        if self.client.is_none() {
            let mut client = DiscordIpcClient::new(DISCORD_APP_ID);
            if client.connect().is_err() {
                self.retry_after = Some(Instant::now() + RECONNECT_COOLDOWN);
                return; // Discord not running — stay dirty, retry later
            }
            self.client = Some(client);
        }
        let media = self.desired.as_ref().unwrap();
        let start_ms = (!media.paused && media.duration > 0.0)
            .then(|| now_ms() - (media.position * 1000.0) as i64);

        // Discord rejects 1-char strings; pad rather than drop the field.
        let pad = |s: &str| if s.len() == 1 { format!("{s} ") } else { s.to_string() };
        let details = pad(&media.details);
        let state = pad(&media.state);
        let large_image = media.large_image.as_deref().unwrap_or(ASSET_LOGO);
        let small_image = match media.kind {
            Kind::Music => ASSET_LOGO,
            Kind::Video => ASSET_FILM,
        };

        let mut activity = Activity::new()
            .activity_type(match media.kind {
                Kind::Music => ActivityType::Listening,
                Kind::Video => ActivityType::Watching,
            })
            // Member list: "♪ <artist>" for music, "Watching <title>" for video.
            .status_display_type(match media.kind {
                Kind::Music => StatusDisplayType::State,
                Kind::Video => StatusDisplayType::Details,
            });
        if !details.is_empty() {
            activity = activity.details(details.as_str());
        }
        if !state.is_empty() {
            activity = activity.state(state.as_str());
        }
        let mut assets = Assets::new().large_image(large_image).small_image(small_image).small_text("waverunner");
        if !media.large_text.is_empty() {
            assets = assets.large_text(media.large_text.as_str());
        }
        activity = activity.assets(assets);
        if let Some(start) = start_ms {
            activity = activity
                .timestamps(Timestamps::new().start(start).end(start + (media.duration * 1000.0) as i64));
        }
        if let Some((label, url)) = media.button.as_ref() {
            activity = activity.buttons(vec![Button::new(label.as_str(), url.as_str())]);
        }

        let client = self.client.as_mut().unwrap();
        match client.set_activity(activity) {
            Ok(()) => {
                self.showing = true;
                self.shown_start_ms = start_ms;
                self.last_send = Some(Instant::now());
                self.dirty = false;
                self.retry_after = None;
            }
            Err(_) => {
                // Discord quit or the pipe broke — reconnect on a cooldown.
                self.drop_client();
                self.retry_after = Some(Instant::now() + RECONNECT_COOLDOWN);
            }
        }
    }

    fn drop_client(&mut self) {
        if let Some(mut client) = self.client.take() {
            let _ = client.close();
        }
        self.showing = false;
        self.shown_start_ms = None;
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
