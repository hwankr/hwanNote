mod commands;
mod config_manager;
mod file_manager;

use std::collections::HashSet;
use std::path::PathBuf;

use commands::*;
use tauri::{Emitter, Manager};

fn collect_txt_open_intents(argv: &[String], cwd: Option<&str>) -> Vec<PathBuf> {
    let base_dir = cwd.map(PathBuf::from);
    let mut seen = HashSet::new();
    let mut intents = Vec::new();

    for arg in argv.iter().skip(1) {
        let normalized = match file_manager::normalize_external_txt_path(arg, base_dir.as_deref()) {
            Ok(path) => path,
            Err(_) => continue,
        };

        let key = normalized.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            intents.push(normalized);
        }
    }

    intents
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn enqueue_open_intents(app: &tauri::AppHandle, paths: Vec<PathBuf>, emit_event: bool) {
    let state = app.state::<PendingOpenIntents>();

    for path in paths {
        let inserted = enqueue_open_intent(&state, path.as_path());
        if inserted && emit_event {
            let _ = app.emit(OPEN_INTENT_EVENT, path.to_string_lossy().to_string());
        }
    }
}

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            focus_main_window(app);
            let intents = collect_txt_open_intents(&argv, Some(cwd.as_str()));
            enqueue_open_intents(app, intents, true);
        }))
        .manage(PendingUpdate::default())
        .manage(DownloadedUpdate::default())
        .manage(PendingOpenIntents::default())
        .invoke_handler(tauri::generate_handler![
            cmd_window_minimize,
            cmd_window_toggle_maximize,
            cmd_window_close,
            cmd_app_exit,
            cmd_note_save,
            cmd_note_read,
            cmd_note_list,
            cmd_note_auto_save,
            cmd_note_load_all,
            cmd_note_delete,
            cmd_folder_list,
            cmd_folder_create,
            cmd_folder_rename,
            cmd_folder_delete,
            cmd_note_import_txt,
            cmd_note_read_external_txt,
            cmd_note_drain_open_intents,
            cmd_note_pick_save_path,
            cmd_note_save_txt,
            cmd_settings_browse_autosave_dir,
            cmd_settings_set_autosave_dir,
            cmd_settings_get_autosave_dir,
            cmd_updater_check,
            cmd_updater_download,
            cmd_updater_install,
            cmd_shell_open_external,
            cmd_cloud_detect_providers,
            cmd_cloud_sync_enable,
            cmd_cloud_sync_disable,
            cmd_cloud_sync_status,
            cmd_cloud_sync_set_active_source,
            cmd_calendar_load,
            cmd_calendar_save,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Migrate legacy Electron config on first launch
            if let Err(e) = config_manager::migrate_legacy_electron_config(&handle) {
                tracing::warn!("Failed to migrate legacy config: {}", e);
            }
            if let Err(e) = config_manager::migrate_legacy_cloud_sync_config(&handle) {
                tracing::warn!("Failed to migrate legacy cloud sync config: {}", e);
            }

            let startup_args: Vec<String> = std::env::args().collect();
            let startup_intents = collect_txt_open_intents(&startup_args, None);
            enqueue_open_intents(&handle, startup_intents, false);

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
