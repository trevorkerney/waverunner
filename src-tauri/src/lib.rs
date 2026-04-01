mod commands;
mod db;

use std::path::PathBuf;
use tauri::Manager;
use tokio::sync::Mutex;

pub struct AppState {
    pub app_data_dir: PathBuf,
    pub libraries: Mutex<Vec<commands::Library>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");

            let libraries = commands::load_config(&app_data_dir);

            app.manage(AppState {
                app_data_dir,
                libraries: Mutex::new(libraries),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_library,
            commands::delete_library,
            commands::get_libraries,
            commands::get_entries,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
