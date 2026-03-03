use std::fs;
use std::path::{Path, PathBuf};
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


pub struct PendingOpenIntents(pub Mutex<Vec<String>>);

impl Default for PendingOpenIntents {
    fn default() -> Self {
        PendingOpenIntents(Mutex::new(Vec::new()))
    }
}

pub const OPEN_INTENT_EVENT: &str = "note:open-intent";

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    provider: Option<String>,
    effective_dir: String,
    files_copied: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    enabled: bool,
    provider: Option<String>,
    sync_folder: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudFolderMissingPayload {
    expected_path: String,
    fallback_path: String,
}

// ── Helpers ──

fn resolve_effective_dir(app: &AppHandle) -> PathBuf {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let default_dir = file_manager::get_auto_save_dir(&documents);
    let effective = config_manager::get_effective_auto_save_dir(app, &default_dir);

    // Detect cloud folder missing at runtime
    if config_manager::get_cloud_sync_provider(app).is_some() && !effective.exists() {
        tracing::warn!(
            "Cloud sync folder missing: {:?}, falling back to local: {:?}",
            effective, default_dir
        );
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(
                "cloud:folder-missing",
                CloudFolderMissingPayload {
                    expected_path: effective.to_string_lossy().to_string(),
                    fallback_path: default_dir.to_string_lossy().to_string(),
                },
            );
        }
        return default_dir;
    }

    effective
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
pub fn cmd_note_read_external_txt(file_path: String) -> Result<ImportedFile, String> {
    let normalized = file_manager::normalize_external_txt_path(&file_path, None)?;
    let content = file_manager::read_text_file(&normalized)?;
    let title = file_manager::title_from_filename(&normalized);

    Ok(ImportedFile {
        title,
        content,
        file_path: normalized.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn cmd_note_drain_open_intents(state: tauri::State<PendingOpenIntents>) -> Vec<String> {
    let mut queue = state.0.lock().unwrap();
    std::mem::take(&mut *queue)
}

pub fn enqueue_open_intent(state: &PendingOpenIntents, file_path: &Path) -> bool {
    let normalized = file_path.to_string_lossy().to_string();
    let mut queue = state.0.lock().unwrap();

    if queue
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&normalized))
    {
        return false;
    }

    queue.push(normalized);
    true
}

#[tauri::command]
pub fn cmd_note_pick_save_path(
    window: WebviewWindow,
    dialog_title: String,
    default_file_name: String,
    extension: String,
) -> Result<Option<String>, String> {
    let mut dialog = window
        .dialog()
        .file()
        .set_title(&dialog_title)
        .set_file_name(&default_file_name);

    if extension.eq_ignore_ascii_case("txt") {
        dialog = dialog.add_filter("Text Files", &["txt"]);
    } else {
        dialog = dialog.add_filter("Markdown Files", &["md"]);
    }
    dialog = dialog.add_filter("All Files", &["*"]);

    let result = dialog.blocking_save_file();
    match result {
        Some(path) => {
            let path_buf = path.into_path().map_err(|e| e.to_string())?;
            Ok(Some(path_buf.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
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

// ── Cloud sync commands ──

#[tauri::command]
pub fn cmd_cloud_detect_providers() -> Vec<config_manager::CloudProviderInfo> {
    config_manager::detect_cloud_providers()
}

#[tauri::command]
pub async fn cmd_cloud_sync_enable(
    app: AppHandle,
    provider: String,
) -> Result<CloudSyncResult, String> {
    let providers = config_manager::detect_cloud_providers();
    let info = providers
        .iter()
        .find(|p| p.id == provider)
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;

    if !info.available {
        return Err(format!("{} is not available", info.name));
    }

    let sync_folder = info
        .sync_folder
        .as_ref()
        .ok_or("Sync folder not detected")?;

    let cloud_notes_dir = PathBuf::from(sync_folder)
        .join("HwanNote")
        .join("Notes");

    // Create the cloud notes directory
    fs::create_dir_all(&cloud_notes_dir)
        .map_err(|e| format!("Failed to create cloud directory: {}", e))?;

    // Migrate notes from current effective dir to cloud dir
    let src = resolve_effective_dir(&app);
    let dst = cloud_notes_dir.clone();

    let migration_result = tauri::async_runtime::spawn_blocking(move || {
        file_manager::migrate_notes(&src, &dst)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Update config: set cloud provider first (so exists() check is bypassed)
    config_manager::set_cloud_sync_provider(&app, Some(&provider))?;
    config_manager::set_custom_auto_save_dir(&app, Some(&cloud_notes_dir.to_string_lossy()))?;

    let effective_dir = cloud_notes_dir.to_string_lossy().to_string();

    Ok(CloudSyncResult {
        provider: Some(provider),
        effective_dir,
        files_copied: migration_result.files_copied,
    })
}

#[tauri::command]
pub async fn cmd_cloud_sync_disable(app: AppHandle) -> Result<CloudSyncResult, String> {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let default_dir = file_manager::get_auto_save_dir(&documents);

    // Ensure default dir exists
    fs::create_dir_all(&default_dir)
        .map_err(|e| format!("Failed to create local directory: {}", e))?;

    // Migrate notes from cloud dir back to local
    let src = resolve_effective_dir(&app);
    let dst = default_dir.clone();

    let migration_result = tauri::async_runtime::spawn_blocking(move || {
        file_manager::migrate_notes(&src, &dst)
    })
    .await
    .map_err(|e| e.to_string())??;

    // Reset config
    config_manager::set_cloud_sync_provider(&app, None)?;
    config_manager::set_custom_auto_save_dir(&app, None)?;

    let effective_dir = default_dir.to_string_lossy().to_string();

    Ok(CloudSyncResult {
        provider: None,
        effective_dir,
        files_copied: migration_result.files_copied,
    })
}

#[tauri::command]
pub fn cmd_cloud_sync_status(app: AppHandle) -> CloudSyncStatus {
    let provider = config_manager::get_cloud_sync_provider(&app);
    let enabled = provider.is_some();

    let sync_folder = if enabled {
        let providers = config_manager::detect_cloud_providers();
        providers
            .into_iter()
            .find(|p| Some(&p.id) == provider.as_ref())
            .and_then(|p| p.sync_folder)
    } else {
        None
    };

    CloudSyncStatus {
        enabled,
        provider,
        sync_folder,
    }
}
