mod commands;
mod db;

use std::path::PathBuf;
use sqlx::SqlitePool;
use tauri::Manager;

pub struct AppState {
    pub app_data_dir: PathBuf,
    pub app_db: SqlitePool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_data_dir = dirs::data_local_dir()
                .expect("failed to get local app data dir")
                .join("waverunner");
            std::fs::create_dir_all(&app_data_dir)
                .expect("failed to create app data dir");

            let db_path = app_data_dir.join("waverunner.db");
            let app_db = tauri::async_runtime::block_on(db::create_app_pool(&db_path))
                .expect("failed to create app database");

            app.manage(AppState {
                app_data_dir,
                app_db,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_setting,
            commands::get_app_version,
            commands::check_for_update,
            commands::download_and_install_update,
            commands::create_library,
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
            commands::set_cover,
            commands::rescan_library,
            commands::detect_players,
            commands::set_library_player,
            commands::play_movie,
            commands::get_show_seasons,
            commands::get_season_episodes,
            commands::play_episode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
