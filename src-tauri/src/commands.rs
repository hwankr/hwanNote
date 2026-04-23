use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::config_manager;
use crate::config_manager::LibrarySource;
use crate::file_manager::{self, AutoSavePayload, AutoSaveResult, FolderDeleteResult, LoadedNote};

// ── State for pending update ──

pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

impl Default for PendingUpdate {
    fn default() -> Self {
        PendingUpdate(Mutex::new(None))
    }
}

struct DownloadedUpdatePayload {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
}

pub struct DownloadedUpdate(Mutex<Option<DownloadedUpdatePayload>>);

impl Default for DownloadedUpdate {
    fn default() -> Self {
        DownloadedUpdate(Mutex::new(None))
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
    files_copied: u32,
    active_source: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    enabled: bool,
    provider: Option<String>,
    sync_folder: Option<String>,
    active_source: String,
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
    let local_dir = config_manager::get_local_auto_save_dir(app, &file_manager::get_auto_save_dir(&documents));
    let provider = config_manager::get_cloud_sync_provider(app);
    let active_source = config_manager::get_cloud_sync_source(app);

    // Detect cloud folder missing at runtime
    if provider.is_some() && active_source == LibrarySource::Cloud {
        if let Some(cloud_dir) = config_manager::get_cloud_notes_dir(app) {
            if !cloud_dir.exists() {
                tracing::warn!(
                    "Cloud sync folder missing: {:?}, falling back to local: {:?}",
                    cloud_dir, local_dir
                );
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit(
                        "cloud:folder-missing",
                        CloudFolderMissingPayload {
                            expected_path: cloud_dir.to_string_lossy().to_string(),
                            fallback_path: local_dir.to_string_lossy().to_string(),
                        },
                    );
                }
                return local_dir;
            }
            return cloud_dir;
        }
    }

    local_dir
}

fn library_source_to_str(source: LibrarySource) -> &'static str {
    match source {
        LibrarySource::Local => "local",
        LibrarySource::Cloud => "cloud",
    }
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

#[tauri::command]
pub fn cmd_app_exit(app: AppHandle) {
    app.exit(0);
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
pub fn cmd_folder_list(app: AppHandle) -> Result<Vec<String>, String> {
    let effective_dir = resolve_effective_dir(&app);
    file_manager::list_folders(&effective_dir)
}

#[tauri::command]
pub fn cmd_folder_create(app: AppHandle, folder_path: String) -> Result<Vec<String>, String> {
    let effective_dir = resolve_effective_dir(&app);
    file_manager::create_folder(&effective_dir, &folder_path)
}

#[tauri::command]
pub fn cmd_folder_rename(app: AppHandle, from: String, to: String) -> Result<Vec<String>, String> {
    let effective_dir = resolve_effective_dir(&app);
    file_manager::rename_folder(&effective_dir, &from, &to)
}

#[tauri::command]
pub fn cmd_folder_delete(app: AppHandle, folder_path: String) -> Result<FolderDeleteResult, String> {
    let effective_dir = resolve_effective_dir(&app);
    file_manager::delete_folder(&effective_dir, &folder_path)
}

#[tauri::command]
pub async fn cmd_note_delete(app: AppHandle, note_id: String) -> Result<bool, String> {
    let effective_dir = resolve_effective_dir(&app);
    let file_path = match file_manager::resolve_note_file_path(&effective_dir, &note_id)? {
        Some(p) => p,
        None => return Ok(false),
    };

    match file_path
        .try_exists()
        .map_err(|e| format!("Failed to check note file before delete: {e}"))?
    {
        true => {
            let trash_result = tauri::async_runtime::spawn_blocking({
                let file_path = file_path.clone();
                move || trash::delete(&file_path).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?;

            trash_result?;
        }
        false => {}
    }

    let removed =
        file_manager::remove_note_from_index_if_path(&effective_dir, &note_id, &file_path)?;
    Ok(removed.is_some())
}

// ── Calendar commands ──

const CALENDAR_FILE: &str = "calendar.json";

#[tauri::command]
pub fn cmd_calendar_load(app: AppHandle) -> Result<String, String> {
    let dir = resolve_effective_dir(&app);
    let path = dir.join(CALENDAR_FILE);

    if !path.exists() {
        return Ok(String::new());
    }

    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) => {
            tracing::error!("Failed to read calendar.json: {}", e);
            // Create backup of corrupted file
            let bak = dir.join("calendar.json.bak");
            let _ = fs::copy(&path, &bak);
            Ok(String::new())
        }
    }
}

#[tauri::command]
pub fn cmd_calendar_save(app: AppHandle, data: String) -> Result<(), String> {
    let dir = resolve_effective_dir(&app);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }

    let path = dir.join(CALENDAR_FILE);
    let tmp_path = dir.join(".calendar.json.tmp");

    // Atomic write: write to temp file, then rename
    fs::write(&tmp_path, data.as_bytes()).map_err(|e| {
        tracing::error!("Failed to write calendar temp file: {}", e);
        e.to_string()
    })?;

    fs::rename(&tmp_path, &path).map_err(|e| {
        tracing::error!("Failed to rename calendar temp file: {}", e);
        // Clean up temp file on failure
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })?;

    Ok(())
}

// ── Session commands ──

const SESSION_FILE: &str = ".hwan-session.json";

#[derive(Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    pub open_tab_ids: Vec<String>,
    pub active_tab_id: Option<String>,
}

fn get_session_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."))
}

#[tauri::command]
pub fn cmd_session_save(app: AppHandle, payload: SessionData) -> Result<(), String> {
    let dir = get_session_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = dir.join(SESSION_FILE);
    let tmp_path = dir.join(".hwan-session.json.tmp");

    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;

    fs::write(&tmp_path, json.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })?;

    Ok(())
}

#[tauri::command]
pub fn cmd_session_load(app: AppHandle) -> SessionData {
    let dir = get_session_dir(&app);
    let path = dir.join(SESSION_FILE);

    if !path.exists() {
        return SessionData::default();
    }

    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => SessionData::default(),
    }
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
    let local_dir = config_manager::get_local_auto_save_dir(&app, &file_manager::get_auto_save_dir(&documents));
    let custom_dir = config_manager::get_custom_auto_save_dir(&app);

    Ok(AutoSaveDirInfo {
        custom_dir: custom_dir.clone(),
        effective_dir: local_dir.to_string_lossy().to_string(),
        is_default: custom_dir.is_none(),
    })
}

#[tauri::command]
pub fn cmd_settings_get_autosave_dir(app: AppHandle) -> AutoSaveDirInfo {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let local_dir = config_manager::get_local_auto_save_dir(&app, &file_manager::get_auto_save_dir(&documents));
    let custom_dir = config_manager::get_custom_auto_save_dir(&app);

    AutoSaveDirInfo {
        custom_dir: custom_dir.clone(),
        effective_dir: local_dir.to_string_lossy().to_string(),
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
            app.state::<DownloadedUpdate>().0.lock().unwrap().take();
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
            .download(
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
            Ok(bytes) => {
                app.state::<DownloadedUpdate>()
                    .0
                    .lock()
                    .unwrap()
                    .replace(DownloadedUpdatePayload { update, bytes });
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
                app.state::<PendingUpdate>()
                    .0
                    .lock()
                    .unwrap()
                    .replace(update);
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
    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    let downloaded = app
        .state::<DownloadedUpdate>()
        .0
        .lock()
        .unwrap()
        .take();

    let Some(downloaded) = downloaded else {
        let _ = window.emit(
            "updater:status",
            UpdateStatusPayload {
                status: "error".to_string(),
                version: None,
                progress: None,
                error: Some("No downloaded update is ready to install.".to_string()),
            },
        );
        return;
    };

    let DownloadedUpdatePayload { update, bytes } = downloaded;
    let result = update.install(bytes.clone());

    if let Err(error) = result {
        app.state::<DownloadedUpdate>()
            .0
            .lock()
            .unwrap()
            .replace(DownloadedUpdatePayload { update, bytes });
        let _ = window.emit(
            "updater:status",
            UpdateStatusPayload {
                status: "error".to_string(),
                version: None,
                progress: None,
                error: Some(error.to_string()),
            },
        );
        return;
    }

    #[cfg(not(target_os = "windows"))]
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
    copy_existing: bool,
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

    let migration_result = if copy_existing {
        let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
        let src = config_manager::get_local_auto_save_dir(&app, &file_manager::get_auto_save_dir(&documents));
        let dst = cloud_notes_dir.clone();

        tauri::async_runtime::spawn_blocking(move || file_manager::migrate_notes(&src, &dst))
            .await
            .map_err(|e| e.to_string())??
    } else {
        file_manager::MigrationResult {
            files_copied: 0,
            index_copied: false,
        }
    };

    config_manager::set_cloud_sync_provider(&app, Some(&provider))?;
    config_manager::set_cloud_sync_source(&app, LibrarySource::Cloud)?;

    Ok(CloudSyncResult {
        provider: Some(provider),
        files_copied: migration_result.files_copied,
        active_source: library_source_to_str(LibrarySource::Cloud).to_string(),
    })
}

#[tauri::command]
pub async fn cmd_cloud_sync_disable(app: AppHandle) -> Result<CloudSyncResult, String> {
    config_manager::set_cloud_sync_provider(&app, None)?;
    config_manager::set_cloud_sync_source(&app, LibrarySource::Local)?;

    Ok(CloudSyncResult {
        provider: None,
        files_copied: 0,
        active_source: library_source_to_str(LibrarySource::Local).to_string(),
    })
}

#[tauri::command]
pub fn cmd_cloud_sync_status(app: AppHandle) -> CloudSyncStatus {
    let provider = config_manager::get_cloud_sync_provider(&app);
    let enabled = provider.is_some();
    let active_source = config_manager::get_cloud_sync_source(&app);

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
        active_source: library_source_to_str(active_source).to_string(),
    }
}

#[tauri::command]
pub fn cmd_cloud_sync_set_active_source(
    app: AppHandle,
    source: String,
) -> Result<CloudSyncStatus, String> {
    let normalized = source.trim().to_ascii_lowercase();
    let next_source = match normalized.as_str() {
        "local" => LibrarySource::Local,
        "cloud" => {
            if config_manager::get_cloud_sync_provider(&app).is_none() {
                return Err("Cloud sync is not enabled.".to_string());
            }
            LibrarySource::Cloud
        }
        _ => return Err("Invalid library source.".to_string()),
    };

    config_manager::set_cloud_sync_source(&app, next_source)?;
    Ok(cmd_cloud_sync_status(app))
}
