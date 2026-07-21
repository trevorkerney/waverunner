mod commands;
mod db;
pub mod interactive;
mod interactive_session;
mod watch;
mod mpv;
mod music;
mod music_art;
mod music_edit;
mod music_mb;
mod music_player;
mod player;
mod rt;
mod tmdb;
#[cfg(windows)]
mod win_maximize_fix;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use sqlx::SqlitePool;
use tauri::Manager;

pub struct AppState {
    pub app_data_dir: PathBuf,
    pub app_db: SqlitePool,
    pub cancel_creation: AtomicBool,
    pub player: Mutex<Option<Arc<player::PlayerInner>>>,
    pub thumbnailer: Mutex<Option<player::Thumbnailer>>,
    /// Live interactive-title session (branch-graph driver), if one is playing.
    pub interactive: Mutex<Option<Arc<interactive_session::Session>>>,
    /// Audio-only mpv behind the now-playing bar (created on first play).
    pub music_player: Mutex<Option<Arc<music_player::MusicInner>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let folder = if cfg!(debug_assertions) { "waverunner_dev" } else { "waverunner" };
            let app_data_dir = dirs::data_local_dir()
                .expect("failed to get local app data dir")
                .join(folder);
            std::fs::create_dir_all(&app_data_dir)
                .expect("failed to create app data dir");

            let db_path = app_data_dir.join("waverunner.db");
            let app_db = tauri::async_runtime::block_on(db::create_app_pool(&db_path))
                .expect("failed to create app database");

            // Clean up any incomplete libraries from a previous force-close
            tauri::async_runtime::block_on(
                commands::cleanup_incomplete_libraries(&app_data_dir, &app_db)
            ).unwrap_or_else(|e| eprintln!("cleanup failed: {e}"));

            app.manage(AppState {
                app_data_dir,
                app_db,
                cancel_creation: AtomicBool::new(false),
                player: Mutex::new(None),
                thumbnailer: Mutex::new(None),
                interactive: Mutex::new(None),
                music_player: Mutex::new(None),
            });

            if cfg!(debug_assertions) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("waverunner_dev");
                }
            }

            #[cfg(windows)]
            win_maximize_fix::install(app);

            // Windows: a maximize/restore cycle can wipe the DWM frame extension
            // that gives this undecorated window its border, shadow, and rounded
            // corners. Re-assert it (set_shadow → DwmExtendFrameIntoClientArea)
            // whenever the window returns to the normal state.
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                use std::sync::atomic::Ordering;
                let win = window.clone();
                let was_normal = AtomicBool::new(true);
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Resized(_) = event {
                        let normal = !win.is_maximized().unwrap_or(false)
                            && !win.is_fullscreen().unwrap_or(false)
                            && !win.is_minimized().unwrap_or(false);
                        let prev = was_normal.swap(normal, Ordering::Relaxed);
                        if normal && !prev {
                            let _ = win.set_shadow(true);
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_setting,
            commands::get_app_version,
            commands::get_file_size,
            commands::add_cover,
            commands::delete_cover,
            commands::check_for_update,
            commands::download_and_install_update,
            commands::create_library,
            commands::cancel_library_creation,
            commands::delete_library,
            commands::rename_library,
            commands::get_libraries,
            commands::get_entries,
            commands::search_entries,
            commands::get_movie_detail,
            commands::update_movie_detail,
            commands::set_sort_mode,
            commands::update_sort_order,
            commands::rename_entry,
            commands::move_entry,
            commands::create_collection,
            commands::set_cover,
            commands::rescan_library,
            commands::get_show_seasons,
            commands::get_season_episodes,
            commands::delete_entry,
            commands::search_tmdb_movie,
            commands::get_tmdb_movie_detail,
            commands::apply_tmdb_metadata,
            commands::download_tmdb_images,
            commands::get_show_detail,
            commands::get_season_detail_local,
            commands::get_episode_detail_local,
            commands::search_tmdb_show,
            commands::get_tmdb_show_detail,
            commands::get_tmdb_season_detail,
            commands::get_tmdb_episode_detail,
            commands::get_tmdb_bulk_targets,
            commands::get_ratings,
            commands::fetch_ratings,
            commands::set_manual_ratings,
            commands::set_rater_ids,
            commands::get_backdrops,
            commands::set_selected_backdrop,
            commands::set_person_favorite,
            commands::search_people_by_character,
            commands::search_persons,
            commands::get_extras,
            commands::get_extra_file_path,
            commands::populate_extras_metadata,
            commands::apply_tmdb_show_metadata,
            commands::apply_tmdb_season_metadata,
            commands::apply_tmdb_episode_metadata,
            commands::apply_tmdb_season_episodes,
            commands::get_movie_file_path,
            commands::get_episode_file_path,
            commands::get_show_episodes,
            commands::get_people_in_library,
            commands::get_library_counts,
            commands::get_genres_in_library,
            commands::get_entries_for_genre,
            commands::get_entries_for_person,
            commands::get_playlists,
            commands::reorder_playlists,
            commands::create_playlist,
            commands::delete_playlist,
            commands::rename_playlist,
            commands::rename_playlist_collection,
            commands::delete_playlist_collection,
            commands::create_playlist_collection,
            commands::add_media_link,
            commands::remove_media_link,
            commands::set_link_cover,
            commands::playlist_contains_target,
            commands::move_media_link,
            commands::move_playlist_collection,
            commands::set_playlist_sort_mode,
            commands::set_playlist_collection_sort_mode,
            commands::update_playlist_sort_order,
            commands::save_sort_preset,
            commands::get_sort_presets,
            commands::delete_sort_preset,
            commands::set_selected_preset,
            commands::add_playlist_cover,
            commands::add_playlist_collection_cover,
            commands::delete_playlist_cover,
            commands::delete_playlist_collection_cover,
            commands::set_playlist_cover,
            commands::set_playlist_collection_cover,
            commands::get_playlist_contents,
            watch::set_watch_target,
            watch::get_watch_state,
            watch::get_show_watch,
            watch::get_show_continue,
            watch::mark_watched,
            watch::mark_show_watched,
            watch::get_watch_flags,
            interactive_session::interactive_start,
            interactive_session::interactive_choose,
            interactive_session::interactive_status,
            interactive_session::interactive_stop,
            interactive_session::interactive_history,
            interactive_session::interactive_rewind,
            interactive_session::interactive_skip,
            interactive_session::interactive_debug,
            interactive_session::reset_interactive_story,
            music::get_artist_detail,
            music::get_album_detail,
            music::get_music_scan_issues,
            music::get_music_counts,
            music::get_recent_music_plays,
            music::get_music_tracks,
            music::get_music_tag_fallbacks,
            music_edit::get_track_edit,
            music_edit::set_track_fields,
            music_edit::reset_track_fields,
            music_edit::get_album_edit,
            music_edit::set_album_fields,
            music_edit::reset_album_fields,
            music_edit::get_artist_edit,
            music_edit::set_artist_fields,
            music_edit::reset_artist_fields,
            music_edit::write_track_tags,
            music_art::music_fetch_artist_image,
            commands::set_library_setup_stage,
            commands::complete_library_setup,
            music_mb::music_match_begin,
            music_mb::music_match_skip,
            music_mb::music_match_state,
            music_mb::mb_get_review,
            music_mb::mb_search_releases,
            music_mb::mb_apply_album_match,
            music_mb::mb_resolve_suggestion,
            music_mb::mb_undo_change,
            music_player::music_play_track,
            music_player::music_command,
            music_player::music_set_property,
            music_player::music_get_status,
            music_player::music_stop,
            player::init_player,
            player::get_player_stats,
            player::set_player_region,
            player::get_player_status,
            player::destroy_player,
            player::play_file,
            player::player_command,
            player::set_player_property,
            player::get_player_tracks,
            player::thumbnailer_start,
            player::thumbnail_at,
            player::thumbnailer_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
