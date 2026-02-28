mod commands;
mod config_manager;
mod file_manager;

use commands::*;

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            cmd_window_minimize,
            cmd_window_toggle_maximize,
            cmd_window_close,
            cmd_note_save,
            cmd_note_read,
            cmd_note_list,
            cmd_note_auto_save,
            cmd_note_load_all,
            cmd_note_delete,
            cmd_note_import_txt,
            cmd_note_save_txt,
            cmd_settings_browse_autosave_dir,
            cmd_settings_set_autosave_dir,
            cmd_settings_get_autosave_dir,
            cmd_updater_check,
            cmd_updater_download,
            cmd_updater_install,
            cmd_shell_open_external,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Migrate legacy Electron config on first launch
            if let Err(e) = config_manager::migrate_legacy_electron_config(&handle) {
                tracing::warn!("Failed to migrate legacy config: {}", e);
            }

            // Check for updates after 3-second delay (production only)
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if cfg!(not(debug_assertions)) {
                    tauri::async_runtime::block_on(commands::check_for_updates(handle));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
