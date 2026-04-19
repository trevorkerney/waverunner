mod commands;
mod db;
mod mpv;
mod player;
mod tmdb;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use sqlx::SqlitePool;
use tauri::Manager;

pub struct AppState {
    pub app_data_dir: PathBuf,
    pub app_db: SqlitePool,
    pub cancel_creation: AtomicBool,
    pub player: Mutex<Option<player::PlayerInner>>,
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
            });

            if cfg!(debug_assertions) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("waverunner_dev");
                }
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
            commands::check_entry_has_files,
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
            commands::apply_tmdb_show_metadata,
            commands::apply_tmdb_season_metadata,
            commands::apply_tmdb_episode_metadata,
            commands::apply_tmdb_season_episodes,
            commands::get_movie_file_path,
            commands::get_episode_file_path,
            commands::get_show_episodes,
            commands::get_people_in_library,
            commands::get_entries_for_person,
            commands::get_playlists,
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
            commands::add_playlist_cover,
            commands::add_playlist_collection_cover,
            commands::delete_playlist_cover,
            commands::delete_playlist_collection_cover,
            commands::set_playlist_cover,
            commands::set_playlist_collection_cover,
            commands::get_playlist_contents,
            player::init_player,
            player::set_player_region,
            player::destroy_player,
            player::play_file,
            player::player_command,
            player::set_player_property,
            player::get_player_tracks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
