use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::config_manager;
use crate::file_manager::{self, AutoSavePayload, AutoSaveResult, LoadedNote};

// ── State for pending update ──

pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

impl Default for PendingUpdate {
    fn default() -> Self {
        PendingUpdate(Mutex::new(None))
    }
}

// ── Response types ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveDirInfo {
    custom_dir: Option<String>,
    effective_dir: String,
    is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    title: String,
    content: String,
    file_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatusPayload {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ── Helpers ──

fn resolve_effective_dir(app: &AppHandle) -> PathBuf {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let default_dir = file_manager::get_auto_save_dir(&documents);
    config_manager::get_effective_auto_save_dir(app, &default_dir)
}

// ── Window commands ──

#[tauri::command]
pub fn cmd_window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn cmd_window_toggle_maximize(window: WebviewWindow) -> bool {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
        false
    } else {
        let _ = window.maximize();
        true
    }
}

#[tauri::command]
pub fn cmd_window_close(window: WebviewWindow) {
    let _ = window.close();
}

// ── Note commands ──

#[tauri::command]
pub fn cmd_note_save(file_path: String, content: String) -> Result<bool, String> {
    file_manager::save_markdown_file(std::path::Path::new(&file_path), &content)?;
    Ok(true)
}

#[tauri::command]
pub fn cmd_note_read(file_path: String) -> Result<String, String> {
    file_manager::read_markdown_file(std::path::Path::new(&file_path))
}

#[tauri::command]
pub fn cmd_note_list(dir_path: String) -> Result<Vec<String>, String> {
    file_manager::list_markdown_files(std::path::Path::new(&dir_path))
}

#[tauri::command]
pub fn cmd_note_auto_save(
    app: AppHandle,
    payload: AutoSavePayload,
) -> Result<AutoSaveResult, String> {
    let effective_dir = resolve_effective_dir(&app);
    file_manager::auto_save_markdown_note(&effective_dir, &payload)
}

#[tauri::command]
pub fn cmd_note_load_all(app: AppHandle) -> Result<Vec<LoadedNote>, String> {
    let effective_dir = resolve_effective_dir(&app);
    file_manager::load_markdown_notes(&effective_dir)
}

#[tauri::command]
pub async fn cmd_note_delete(app: AppHandle, note_id: String) -> Result<bool, String> {
    let effective_dir = resolve_effective_dir(&app);
    let file_path = match file_manager::remove_note_from_index(&effective_dir, &note_id)? {
        Some(p) => p,
        None => return Ok(false),
    };

    // trash::delete() is synchronous — dispatch to blocking thread
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = trash::delete(&file_path) {
            tracing::warn!("Failed to trash file {:?}: {}", file_path, e);
            // File may already be missing; index entry was already removed
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(true)
}

#[tauri::command]
pub fn cmd_note_import_txt(window: WebviewWindow) -> Result<Option<Vec<ImportedFile>>, String> {
    let result = window
        .dialog()
        .file()
        .set_title("텍스트 파일 가져오기")
        .add_filter("Text Files", &["txt"])
        .add_filter("All Files", &["*"])
        .blocking_pick_files();

    let paths = match result {
        Some(paths) => paths,
        None => return Ok(None),
    };

    let mut imported = Vec::new();
    for file_response in paths {
        let path_buf = file_response.into_path().map_err(|e| e.to_string())?;
        let content = file_manager::read_text_file(&path_buf)?;
        let title = file_manager::title_from_filename(&path_buf);
        imported.push(ImportedFile {
            title,
            content,
            file_path: path_buf.to_string_lossy().to_string(),
        });
    }

    Ok(Some(imported))
}

#[tauri::command]
pub fn cmd_note_save_txt(file_path: String, content: String) -> Result<bool, String> {
    file_manager::save_text_file(std::path::Path::new(&file_path), &content)?;
    Ok(true)
}

// ── Settings commands ──

#[tauri::command]
pub fn cmd_settings_browse_autosave_dir(
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    let result = window.dialog().file().blocking_pick_folder();

    match result {
        Some(path) => {
            let path_buf = path.into_path().map_err(|e| e.to_string())?;
            Ok(Some(path_buf.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn cmd_settings_set_autosave_dir(
    app: AppHandle,
    dir: Option<String>,
) -> Result<AutoSaveDirInfo, String> {
    config_manager::set_custom_auto_save_dir(&app, dir.as_deref())?;

    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let default_dir = file_manager::get_auto_save_dir(&documents);
    let effective_dir = config_manager::get_effective_auto_save_dir(&app, &default_dir);
    let custom_dir = config_manager::get_custom_auto_save_dir(&app);

    Ok(AutoSaveDirInfo {
        custom_dir: custom_dir.clone(),
        effective_dir: effective_dir.to_string_lossy().to_string(),
        is_default: custom_dir.is_none(),
    })
}

#[tauri::command]
pub fn cmd_settings_get_autosave_dir(app: AppHandle) -> AutoSaveDirInfo {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let default_dir = file_manager::get_auto_save_dir(&documents);
    let effective_dir = config_manager::get_effective_auto_save_dir(&app, &default_dir);
    let custom_dir = config_manager::get_custom_auto_save_dir(&app);

    AutoSaveDirInfo {
        custom_dir: custom_dir.clone(),
        effective_dir: effective_dir.to_string_lossy().to_string(),
        is_default: custom_dir.is_none(),
    }
}

// ── Updater commands ──

#[tauri::command]
pub async fn cmd_updater_check(app: AppHandle) {
    check_for_updates(app).await;
}

pub async fn check_for_updates(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    let emit = |payload: UpdateStatusPayload| {
        let _ = window.emit("updater:status", &payload);
    };

    emit(UpdateStatusPayload {
        status: "checking".to_string(),
        version: None,
        progress: None,
        error: None,
    });

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            emit(UpdateStatusPayload {
                status: "error".to_string(),
                version: None,
                progress: None,
                error: Some(e.to_string()),
            });
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            emit(UpdateStatusPayload {
                status: "available".to_string(),
                version: Some(version),
                progress: None,
                error: None,
            });
            // Store update handle for download step
            app.state::<PendingUpdate>()
                .0
                .lock()
                .unwrap()
                .replace(update);
        }
        Ok(None) => {
            emit(UpdateStatusPayload {
                status: "not-available".to_string(),
                version: None,
                progress: None,
                error: None,
            });
        }
        Err(e) => {
            tracing::warn!("Update check failed: {}", e);
            emit(UpdateStatusPayload {
                status: "error".to_string(),
                version: None,
                progress: None,
                error: Some(e.to_string()),
            });
        }
    }
}

#[tauri::command]
pub async fn cmd_updater_download(app: AppHandle) {
    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    let update = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .unwrap()
        .take();

    if let Some(update) = update {
        let mut downloaded: usize = 0;
        let win_progress = window.clone();

        let result = update
            .download_and_install(
                move |chunk_length, content_length| {
                    downloaded += chunk_length;
                    if let Some(total) = content_length {
                        let progress = ((downloaded as f64 / total as f64) * 100.0) as u32;
                        let _ = win_progress.emit(
                            "updater:status",
                            UpdateStatusPayload {
                                status: "downloading".to_string(),
                                version: None,
                                progress: Some(progress.min(100)),
                                error: None,
                            },
                        );
                    }
                },
                || { /* download finished */ },
            )
            .await;

        match result {
            Ok(_) => {
                let _ = window.emit(
                    "updater:status",
                    UpdateStatusPayload {
                        status: "downloaded".to_string(),
                        version: None,
                        progress: None,
                        error: None,
                    },
                );
            }
            Err(e) => {
                let _ = window.emit(
                    "updater:status",
                    UpdateStatusPayload {
                        status: "error".to_string(),
                        version: None,
                        progress: None,
                        error: Some(e.to_string()),
                    },
                );
            }
        }
    }
}

#[tauri::command]
pub fn cmd_updater_install(app: AppHandle) {
    app.restart();
}

// ── Shell commands ──

#[tauri::command]
pub fn cmd_shell_open_external(app: AppHandle, url: String) -> Result<(), String> {
    // Validate URL protocol
    let allowed_schemes = ["http:", "https:", "mailto:"];
    let has_valid_scheme = allowed_schemes
        .iter()
        .any(|scheme| url.starts_with(scheme));

    if !has_valid_scheme {
        return Err("Unsupported URL scheme".to_string());
    }

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}
