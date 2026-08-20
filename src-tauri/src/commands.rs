use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::config_manager;
use crate::config_manager::{LibrarySource, LocalAutoSaveDirState};
use crate::file_manager::{
    self, AutoSavePayload, AutoSaveResult, FolderDeleteResult, LoadedNote, NoteLoadIssue,
    NoteLoadState,
};

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

pub struct CalendarWriteGuard(Mutex<HashSet<PathBuf>>);

impl Default for CalendarWriteGuard {
    fn default() -> Self {
        Self(Mutex::new(HashSet::new()))
    }
}

impl CalendarWriteGuard {
    fn blocked_paths(&self) -> MutexGuard<'_, HashSet<PathBuf>> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn block(&self, calendar_path: &Path) {
        self.blocked_paths().insert(calendar_path.to_path_buf());
    }

    fn confirm_loaded(&self, calendar_path: &Path) {
        self.blocked_paths().remove(calendar_path);
    }

    #[cfg(test)]
    fn is_blocked(&self, calendar_path: &Path) -> bool {
        self.blocked_paths().contains(calendar_path)
    }

    fn write_if_allowed<F>(&self, calendar_path: &Path, write: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let blocked_paths = self.blocked_paths();
        if blocked_paths.contains(calendar_path) {
            return Err(format!(
                "Calendar save rejected: {} is blocked after a calendar load failure. Back up and recover it, or explicitly reset the calendar first.",
                calendar_path.display()
            ));
        }

        write()
    }

    fn reset<F>(&self, calendar_path: &Path, write: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut blocked_paths = self.blocked_paths();
        write()?;
        blocked_paths.remove(calendar_path);
        Ok(())
    }
}

pub const OPEN_INTENT_EVENT: &str = "note:open-intent";

// ── Response types ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveDirInfo {
    custom_dir: Option<String>,
    effective_dir: Option<String>,
    is_default: bool,
    status: String,
    expected_dir: String,
    error: Option<String>,
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
    calendar_copied: bool,
    active_source: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    enabled: bool,
    provider: Option<String>,
    sync_folder: Option<String>,
    active_source: String,
    resolved_source: Option<String>,
    cloud_unavailable: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudFolderMissingPayload {
    expected_path: String,
    fallback_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolvedStorageSource {
    Local,
    Cloud,
    LocalFallback,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLoadResult {
    status: String,
    data: String,
    loaded_from: String,
    cloud_unavailable: bool,
    source_path: String,
    backup_path: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSavePayload {
    data: String,
    loaded_from: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarBackupPayload {
    data: String,
    loaded_from: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarConfirmLoadedPayload {
    data: Option<String>,
    loaded_from: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLoadResult {
    notes: Vec<LoadedNote>,
    folders: Vec<String>,
    loaded_from: String,
    cloud_unavailable: bool,
    load_state: NoteLoadState,
    issues: Vec<NoteLoadIssue>,
    index_source_path: Option<String>,
    index_backup_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAutoSavePayload {
    note_id: String,
    title: String,
    content: String,
    folder_path: Option<String>,
    is_title_manual: Option<bool>,
    #[serde(default)]
    is_pinned: Option<bool>,
    loaded_from: String,
}

// ── Helpers ──

const CUSTOM_AUTO_SAVE_DIR_UNAVAILABLE_ERROR: &str = "custom_auto_save_dir_unavailable";

fn configured_local_dir_unavailable_error(path: &Path) -> String {
    format!(
        "{}: {}",
        CUSTOM_AUTO_SAVE_DIR_UNAVAILABLE_ERROR,
        path.display()
    )
}

fn build_auto_save_dir_info(state: LocalAutoSaveDirState) -> AutoSaveDirInfo {
    let expected_dir = state.expected_dir().to_string_lossy().to_string();
    let custom_dir = state
        .configured_dir()
        .map(|path| path.to_string_lossy().to_string());
    let is_default = state.is_default();
    let status = match &state {
        LocalAutoSaveDirState::Unset(_) => "unset",
        LocalAutoSaveDirState::Available(_) => "available",
        LocalAutoSaveDirState::Unavailable(_) => "unavailable",
    }
    .to_string();
    let (effective_dir, error) = match &state {
        LocalAutoSaveDirState::Unset(path) | LocalAutoSaveDirState::Available(path) => {
            (Some(path.to_string_lossy().to_string()), None)
        }
        LocalAutoSaveDirState::Unavailable(_) => (
            None,
            Some(CUSTOM_AUTO_SAVE_DIR_UNAVAILABLE_ERROR.to_string()),
        ),
    };

    AutoSaveDirInfo {
        custom_dir,
        effective_dir,
        is_default,
        status,
        expected_dir,
        error,
    }
}

fn resolve_effective_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_calendar_dir(app)?.0)
}

fn resolve_calendar_dir(app: &AppHandle) -> Result<(PathBuf, ResolvedStorageSource), String> {
    resolve_storage_dir(app, true)
}

fn resolve_storage_dir(
    app: &AppHandle,
    emit_missing_event: bool,
) -> Result<(PathBuf, ResolvedStorageSource), String> {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let active_source = config_manager::get_cloud_sync_source(app);
    let cloud_dir = if active_source == LibrarySource::Cloud {
        config_manager::get_cloud_notes_dir(app)
    } else {
        None
    };
    let (path, source) = resolve_storage_dir_with_local_dir(
        || get_calendar_local_dir(app, &documents),
        cloud_dir.clone(),
        active_source,
    )?;

    if source == ResolvedStorageSource::LocalFallback {
        if let Some(cloud_dir) = cloud_dir {
            tracing::warn!(
                "Cloud sync folder missing: {:?}, falling back to local: {:?}",
                cloud_dir,
                path
            );
            if emit_missing_event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit(
                        "cloud:folder-missing",
                        CloudFolderMissingPayload {
                            expected_path: cloud_dir.to_string_lossy().to_string(),
                            fallback_path: path.to_string_lossy().to_string(),
                        },
                    );
                }
            }
        }
    }

    Ok((path, source))
}

fn resolve_storage_dir_with_local_dir<F>(
    local_dir: F,
    cloud_dir: Option<PathBuf>,
    active_source: LibrarySource,
) -> Result<(PathBuf, ResolvedStorageSource), String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    if active_source == LibrarySource::Cloud {
        if let Some(cloud_dir) = cloud_dir {
            if cloud_dir.is_dir() {
                return Ok((cloud_dir, ResolvedStorageSource::Cloud));
            }
        }

        return Ok((local_dir()?, ResolvedStorageSource::LocalFallback));
    }

    Ok((local_dir()?, ResolvedStorageSource::Local))
}

fn get_calendar_local_dir(app: &AppHandle, documents: &Path) -> Result<PathBuf, String> {
    let state = config_manager::get_local_auto_save_dir_state(
        app,
        &file_manager::get_auto_save_dir(documents),
    );
    match state {
        LocalAutoSaveDirState::Unset(path) | LocalAutoSaveDirState::Available(path) => Ok(path),
        LocalAutoSaveDirState::Unavailable(path) => {
            Err(configured_local_dir_unavailable_error(&path))
        }
    }
}

fn resolve_loaded_storage_dir(
    app: &AppHandle,
    loaded_from: ResolvedStorageSource,
) -> Result<PathBuf, String> {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let cloud_dir = config_manager::get_cloud_notes_dir(app);
    select_loaded_storage_dir(
        || get_calendar_local_dir(app, &documents),
        cloud_dir,
        loaded_from,
    )
}

fn select_loaded_storage_dir<F>(
    local_dir: F,
    cloud_dir: Option<PathBuf>,
    loaded_from: ResolvedStorageSource,
) -> Result<PathBuf, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    if !loaded_source_writes_to_cloud(loaded_from) {
        return local_dir();
    }

    let cloud_dir =
        cloud_dir.ok_or_else(|| "Cloud storage directory is not configured.".to_string())?;
    if cloud_dir.is_dir() {
        Ok(cloud_dir)
    } else {
        Err("Cloud storage directory is not available.".to_string())
    }
}

fn loaded_source_writes_to_cloud(source: ResolvedStorageSource) -> bool {
    source == ResolvedStorageSource::Cloud
}

fn library_source_to_str(source: LibrarySource) -> &'static str {
    match source {
        LibrarySource::Local => "local",
        LibrarySource::Cloud => "cloud",
    }
}

fn resolved_storage_source_to_str(source: ResolvedStorageSource) -> &'static str {
    match source {
        ResolvedStorageSource::Local => "local",
        ResolvedStorageSource::Cloud => "cloud",
        ResolvedStorageSource::LocalFallback => "local_fallback",
    }
}

fn parse_resolved_storage_source(value: &str) -> Result<ResolvedStorageSource, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "local" => Ok(ResolvedStorageSource::Local),
        "cloud" => Ok(ResolvedStorageSource::Cloud),
        "localfallback" | "local_fallback" => Ok(ResolvedStorageSource::LocalFallback),
        _ => Err(format!("Invalid storage source: {}", value)),
    }
}

fn can_save_calendar(
    loaded_from: ResolvedStorageSource,
    current_source: ResolvedStorageSource,
) -> bool {
    match loaded_from {
        ResolvedStorageSource::Cloud => current_source == ResolvedStorageSource::Cloud,
        ResolvedStorageSource::Local | ResolvedStorageSource::LocalFallback => true,
    }
}

fn can_save_note(
    loaded_from: ResolvedStorageSource,
    current_source: ResolvedStorageSource,
) -> bool {
    can_save_calendar(loaded_from, current_source)
}

fn resolve_note_library_mutation_dir(
    app: &AppHandle,
    loaded_from: &str,
    operation: &str,
) -> Result<PathBuf, String> {
    let loaded_from = parse_resolved_storage_source(loaded_from)?;
    let (_, current_source) = resolve_calendar_dir(app)?;
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let cloud_dir = config_manager::get_cloud_notes_dir(app);

    select_note_library_mutation_dir(
        || get_calendar_local_dir(app, &documents),
        cloud_dir,
        loaded_from,
        current_source,
        operation,
    )
}

fn select_note_library_mutation_dir<F>(
    local_dir: F,
    cloud_dir: Option<PathBuf>,
    loaded_from: ResolvedStorageSource,
    current_source: ResolvedStorageSource,
    operation: &str,
) -> Result<PathBuf, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    if !can_save_note(loaded_from, current_source) {
        return Err(format!(
            "{} rejected: loaded from {}, but current storage resolves to {}.",
            operation,
            resolved_storage_source_to_str(loaded_from),
            resolved_storage_source_to_str(current_source)
        ));
    }

    select_loaded_storage_dir(local_dir, cloud_dir, loaded_from)
}

fn calendar_backup_candidate(calendar_path: &Path, sequence: u64) -> PathBuf {
    let file_name = calendar_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let backup_name = if sequence == 0 {
        format!("{}.bak", file_name)
    } else {
        format!("{}.bak.{}", file_name, sequence)
    };

    calendar_path.with_file_name(backup_name)
}

fn write_unique_calendar_backup(calendar_path: &Path, data: &[u8]) -> Result<PathBuf, String> {
    for sequence in 0_u64.. {
        let backup_path = calendar_backup_candidate(calendar_path, sequence);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup_path)
        {
            Ok(mut backup_file) => {
                if let Err(error) = backup_file
                    .write_all(data)
                    .and_then(|_| backup_file.sync_all())
                {
                    drop(backup_file);
                    let _ = fs::remove_file(&backup_path);
                    return Err(format!(
                        "Failed to write calendar backup {}: {}",
                        backup_path.display(),
                        error
                    ));
                }

                return Ok(backup_path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create calendar backup {}: {}",
                    backup_path.display(),
                    error
                ));
            }
        }
    }

    unreachable!("the calendar backup sequence is unbounded")
}

fn backup_calendar_file(calendar_path: &Path) -> Result<PathBuf, String> {
    let data = fs::read(calendar_path).map_err(|error| {
        format!(
            "Failed to read calendar data for backup {}: {}",
            calendar_path.display(),
            error
        )
    })?;

    write_unique_calendar_backup(calendar_path, &data)
}

fn calendar_recovery_copy_candidate(local_dir: &Path, sequence: u64) -> PathBuf {
    let base_name = format!("{}.local-recovery.bak", file_manager::CALENDAR_FILENAME);
    let file_name = if sequence == 0 {
        base_name
    } else {
        format!("{}.{}", base_name, sequence)
    };

    local_dir.join(file_name)
}

const MAX_CALENDAR_RECOVERY_COPY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CALENDAR_RECOVERY_COPY_COUNT: u64 = 16;
const MAX_CALENDAR_RECOVERY_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CALENDAR_RECOVERY_CREATE_ATTEMPTS: u8 = 3;

fn preserve_calendar_recovery_copy(local_dir: &Path, data: &str) -> Result<PathBuf, String> {
    let payload = data.as_bytes();
    let payload_len = u64::try_from(payload.len())
        .map_err(|_| "Calendar recovery copy rejected: payload size overflowed.".to_string())?;
    if payload_len > MAX_CALENDAR_RECOVERY_COPY_BYTES {
        return Err(format!(
            "Calendar recovery copy rejected: payload is {} bytes, exceeding the {} byte limit.",
            payload_len, MAX_CALENDAR_RECOVERY_COPY_BYTES
        ));
    }
    validate_calendar_data_for_confirmation(data)?;
    fs::create_dir_all(local_dir).map_err(|error| {
        format!(
            "Failed to create local calendar recovery directory {}: {}",
            local_dir.display(),
            error
        )
    })?;

    for attempt in 0..MAX_CALENDAR_RECOVERY_CREATE_ATTEMPTS {
        let mut first_available_path = None;
        let mut total_bytes = 0_u64;

        for sequence in 0..MAX_CALENDAR_RECOVERY_COPY_COUNT {
            let recovery_path = calendar_recovery_copy_candidate(local_dir, sequence);
            let metadata = match fs::symlink_metadata(&recovery_path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if first_available_path.is_none() {
                        first_available_path = Some(recovery_path);
                    }
                    continue;
                }
                Err(error) => {
                    return Err(format!(
                        "Failed to inspect local calendar recovery copy {}: {}",
                        recovery_path.display(),
                        error
                    ));
                }
            };

            if !metadata.file_type().is_file() {
                return Err(format!(
                    "Calendar recovery copy rejected: reserved path {} is not a regular file.",
                    recovery_path.display()
                ));
            }

            total_bytes = total_bytes.checked_add(metadata.len()).ok_or_else(|| {
                "Calendar recovery copy rejected: retained size overflowed.".to_string()
            })?;

            if metadata.len() == payload_len {
                let existing = fs::read(&recovery_path).map_err(|error| {
                    format!(
                        "Failed to compare local calendar recovery copy {}: {}",
                        recovery_path.display(),
                        error
                    )
                })?;
                if existing == payload {
                    return Ok(recovery_path);
                }
            }
        }

        let recovery_path = first_available_path.ok_or_else(|| {
            format!(
                "Calendar recovery copy rejected: the {}-copy retention limit was reached.",
                MAX_CALENDAR_RECOVERY_COPY_COUNT
            )
        })?;
        let next_total = total_bytes.checked_add(payload_len).ok_or_else(|| {
            "Calendar recovery copy rejected: retained size overflowed.".to_string()
        })?;
        if next_total > MAX_CALENDAR_RECOVERY_TOTAL_BYTES {
            return Err(format!(
                "Calendar recovery copy rejected: retained copies would exceed the {} byte limit.",
                MAX_CALENDAR_RECOVERY_TOTAL_BYTES
            ));
        }

        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&recovery_path)
        {
            Ok(mut recovery_file) => {
                if let Err(error) = recovery_file
                    .write_all(data.as_bytes())
                    .and_then(|_| recovery_file.sync_all())
                {
                    drop(recovery_file);
                    let _ = fs::remove_file(&recovery_path);
                    return Err(format!(
                        "Failed to write local calendar recovery copy {}: {}",
                        recovery_path.display(),
                        error
                    ));
                }

                return Ok(recovery_path);
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && attempt + 1 < MAX_CALENDAR_RECOVERY_CREATE_ATTEMPTS =>
            {
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to create local calendar recovery copy {}: {}",
                    recovery_path.display(),
                    error
                ));
            }
        }
    }

    Err("Calendar recovery copy rejected after repeated concurrent creation attempts.".to_string())
}

fn verify_calendar_snapshot(
    calendar_path: &Path,
    expected_data: Option<&str>,
) -> Result<(), String> {
    match expected_data {
        Some(expected_data) => {
            let current_data = fs::read_to_string(calendar_path).map_err(|error| {
                format!(
                    "Calendar confirmation rejected because {} could not be read: {}",
                    calendar_path.display(),
                    error
                )
            })?;
            if current_data != expected_data {
                return Err(format!(
                    "Calendar confirmation rejected because {} changed after it was loaded.",
                    calendar_path.display()
                ));
            }
            Ok(())
        }
        None => match fs::metadata(calendar_path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err(format!(
                "Calendar confirmation rejected because {} appeared after the missing-file result.",
                calendar_path.display()
            )),
            Err(error) => Err(format!(
                "Calendar confirmation rejected because {} could not be inspected: {}",
                calendar_path.display(),
                error
            )),
        },
    }
}

fn validate_calendar_data_for_confirmation(data: &str) -> Result<(), String> {
    if data.trim().is_empty() {
        return Err("Calendar confirmation rejected because calendar.json is empty.".to_string());
    }

    let parsed: serde_json::Value = serde_json::from_str(data)
        .map_err(|error| format!("Calendar confirmation rejected: invalid JSON: {}", error))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| "Calendar confirmation rejected: root must be an object.".to_string())?;

    let require_object = |key: &str| -> Result<(), String> {
        if object
            .get(key)
            .and_then(serde_json::Value::as_object)
            .is_none()
        {
            return Err(format!(
                "Calendar confirmation rejected: {} must be an object.",
                key
            ));
        }
        Ok(())
    };
    let require_array = |key: &str| -> Result<(), String> {
        if object
            .get(key)
            .and_then(serde_json::Value::as_array)
            .is_none()
        {
            return Err(format!(
                "Calendar confirmation rejected: {} must be an array.",
                key
            ));
        }
        Ok(())
    };

    match object.get("version") {
        Some(version) => {
            let version = version.as_f64().ok_or_else(|| {
                "Calendar confirmation rejected: version must be an integer.".to_string()
            })?;
            if version.fract() != 0.0 {
                return Err(
                    "Calendar confirmation rejected: version must be an integer.".to_string(),
                );
            }
            let version = version as i64;
            if !(1..=4).contains(&version) {
                return Err(format!(
                    "Calendar confirmation rejected: unsupported version {}.",
                    version
                ));
            }
            require_object("todos")?;
            require_object("noteLinks")?;
            if version >= 3 {
                require_array("inbox")?;
            }
        }
        None if object.contains_key("todos") || object.contains_key("noteLinks") => {
            if object.contains_key("todos") {
                require_object("todos")?;
            }
            if object.contains_key("noteLinks") {
                require_object("noteLinks")?;
            }
        }
        None => {
            return Err(
                "Calendar confirmation rejected: supported version metadata is missing."
                    .to_string(),
            );
        }
    }

    Ok(())
}

fn validate_empty_calendar_reset(data: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(data)
        .map_err(|error| format!("Calendar reset payload is not valid JSON: {}", error))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| "Calendar reset payload must be a JSON object.".to_string())?;

    let is_empty_reset = object.len() == 4
        && object.get("version").and_then(serde_json::Value::as_u64) == Some(4)
        && object
            .get("todos")
            .and_then(serde_json::Value::as_object)
            .is_some_and(serde_json::Map::is_empty)
        && object
            .get("inbox")
            .and_then(serde_json::Value::as_array)
            .is_some_and(Vec::is_empty)
        && object
            .get("noteLinks")
            .and_then(serde_json::Value::as_object)
            .is_some_and(serde_json::Map::is_empty);

    if !is_empty_reset {
        return Err(
            "Calendar reset rejected: payload must be an empty version 4 calendar.".to_string(),
        );
    }

    Ok(())
}

fn create_unique_calendar_temp(dir: &Path) -> Result<(fs::File, PathBuf), String> {
    for sequence in 0_u64.. {
        let file_name = if sequence == 0 {
            ".calendar.json.tmp".to_string()
        } else {
            format!(".calendar.json.tmp.{}", sequence)
        };
        let temp_path = dir.join(file_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((file, temp_path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create calendar temp file {}: {}",
                    temp_path.display(),
                    error
                ));
            }
        }
    }

    unreachable!("the calendar temp-file sequence is unbounded")
}

fn write_calendar_data(dir: &Path, data: &str) -> Result<(), String> {
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }

    let path = dir.join(file_manager::CALENDAR_FILENAME);
    let (mut tmp_file, tmp_path) = create_unique_calendar_temp(dir)?;
    if let Err(error) = tmp_file
        .write_all(data.as_bytes())
        .and_then(|_| tmp_file.sync_all())
    {
        drop(tmp_file);
        let _ = fs::remove_file(&tmp_path);
        tracing::error!("Failed to write calendar temp file: {}", error);
        return Err(error.to_string());
    }
    drop(tmp_file);

    fs::rename(&tmp_path, &path).map_err(|error| {
        tracing::error!("Failed to rename calendar temp file: {}", error);
        let _ = fs::remove_file(&tmp_path);
        error.to_string()
    })?;

    Ok(())
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
    payload: NoteAutoSavePayload,
) -> Result<AutoSaveResult, String> {
    let loaded_from = parse_resolved_storage_source(&payload.loaded_from)?;
    let (_, current_source) = resolve_calendar_dir(&app)?;

    if !can_save_note(loaded_from, current_source) {
        return Err(format!(
            "Note save rejected: loaded from {}, but current storage resolves to {}.",
            resolved_storage_source_to_str(loaded_from),
            resolved_storage_source_to_str(current_source)
        ));
    }

    let target_dir = resolve_loaded_storage_dir(&app, loaded_from)?;
    let file_payload = AutoSavePayload {
        note_id: payload.note_id,
        title: payload.title,
        content: payload.content,
        folder_path: payload.folder_path,
        is_title_manual: payload.is_title_manual,
        is_pinned: payload.is_pinned,
    };

    file_manager::auto_save_markdown_note(&target_dir, &file_payload)
}

#[tauri::command]
pub fn cmd_note_load_all(app: AppHandle) -> Result<NoteLoadResult, String> {
    let (effective_dir, loaded_from) = resolve_calendar_dir(&app)?;
    let library = file_manager::load_markdown_library(&effective_dir);

    Ok(NoteLoadResult {
        notes: library.notes,
        folders: library.folders,
        loaded_from: resolved_storage_source_to_str(loaded_from).to_string(),
        cloud_unavailable: loaded_from == ResolvedStorageSource::LocalFallback,
        load_state: library.load_state,
        issues: library.issues,
        index_source_path: library.index_source_path,
        index_backup_path: library.index_backup_path,
    })
}

#[tauri::command]
pub fn cmd_folder_list(app: AppHandle) -> Result<Vec<String>, String> {
    let effective_dir = resolve_effective_dir(&app)?;
    file_manager::list_folders(&effective_dir)
}

#[tauri::command]
pub fn cmd_folder_create(
    app: AppHandle,
    folder_path: String,
    loaded_from: String,
) -> Result<Vec<String>, String> {
    let target_dir = resolve_note_library_mutation_dir(&app, &loaded_from, "Folder creation")?;
    file_manager::create_folder(&target_dir, &folder_path)
}

#[tauri::command]
pub fn cmd_folder_rename(
    app: AppHandle,
    from: String,
    to: String,
    loaded_from: String,
) -> Result<Vec<String>, String> {
    let target_dir = resolve_note_library_mutation_dir(&app, &loaded_from, "Folder rename")?;
    file_manager::rename_folder(&target_dir, &from, &to)
}

#[tauri::command]
pub fn cmd_folder_delete(
    app: AppHandle,
    folder_path: String,
    loaded_from: String,
) -> Result<FolderDeleteResult, String> {
    let target_dir = resolve_note_library_mutation_dir(&app, &loaded_from, "Folder deletion")?;
    file_manager::delete_folder(&target_dir, &folder_path)
}

#[tauri::command]
pub async fn cmd_note_delete(
    app: AppHandle,
    note_id: String,
    loaded_from: String,
) -> Result<bool, String> {
    let target_dir = resolve_note_library_mutation_dir(&app, &loaded_from, "Note deletion")?;
    tauri::async_runtime::spawn_blocking(move || {
        file_manager::delete_note_file_and_index(&target_dir, &note_id, |path| {
            trash::delete(path).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Calendar commands ──

#[tauri::command]
pub fn cmd_calendar_load(app: AppHandle) -> Result<CalendarLoadResult, String> {
    let (dir, loaded_from) = resolve_calendar_dir(&app)?;
    let path = dir.join(file_manager::CALENDAR_FILENAME);
    let source_path = path.to_string_lossy().to_string();
    let cloud_unavailable = loaded_from == ResolvedStorageSource::LocalFallback;
    let loaded_from = resolved_storage_source_to_str(loaded_from).to_string();

    match fs::read_to_string(&path) {
        Ok(content) => {
            app.state::<CalendarWriteGuard>().block(&path);
            Ok(CalendarLoadResult {
                status: "ok".to_string(),
                data: content,
                loaded_from,
                cloud_unavailable,
                source_path,
                backup_path: None,
                error: None,
            })
        }
        Err(read_error) if read_error.kind() == std::io::ErrorKind::NotFound => {
            Ok(CalendarLoadResult {
                status: "missing".to_string(),
                data: String::new(),
                loaded_from,
                cloud_unavailable,
                source_path,
                backup_path: None,
                error: None,
            })
        }
        Err(read_error) => {
            let read_error = format!("Failed to read calendar.json: {}", read_error);
            tracing::error!("{}", read_error);
            app.state::<CalendarWriteGuard>().block(&path);
            let (backup_path, error) = match backup_calendar_file(&path) {
                Ok(backup_path) => (Some(backup_path.to_string_lossy().to_string()), read_error),
                Err(backup_error) => {
                    tracing::error!(
                        "Failed to back up unreadable calendar.json: {}",
                        backup_error
                    );
                    (
                        None,
                        format!("{} Backup failed: {}", read_error, backup_error),
                    )
                }
            };

            Ok(CalendarLoadResult {
                status: "read_error".to_string(),
                data: String::new(),
                loaded_from,
                cloud_unavailable,
                source_path,
                backup_path,
                error: Some(error),
            })
        }
    }
}

#[tauri::command]
pub fn cmd_calendar_backup(
    app: AppHandle,
    payload: CalendarBackupPayload,
) -> Result<String, String> {
    let loaded_from = parse_resolved_storage_source(&payload.loaded_from)?;
    let dir = resolve_loaded_storage_dir(&app, loaded_from)?;
    let calendar_path = dir.join(file_manager::CALENDAR_FILENAME);
    app.state::<CalendarWriteGuard>().block(&calendar_path);

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    }

    let backup_path = write_unique_calendar_backup(&calendar_path, payload.data.as_bytes())?;
    Ok(backup_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cmd_calendar_preserve_recovery_copy(app: AppHandle, data: String) -> Result<String, String> {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let local_dir = get_calendar_local_dir(&app, &documents)?;
    let recovery_path = preserve_calendar_recovery_copy(&local_dir, &data)?;
    Ok(recovery_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cmd_calendar_confirm_loaded(
    app: AppHandle,
    payload: CalendarConfirmLoadedPayload,
) -> Result<(), String> {
    let loaded_from = parse_resolved_storage_source(&payload.loaded_from)?;
    let dir = resolve_loaded_storage_dir(&app, loaded_from)?;
    let calendar_path = dir.join(file_manager::CALENDAR_FILENAME);
    let write_guard = app.state::<CalendarWriteGuard>();
    write_guard.block(&calendar_path);
    if let Some(data) = payload.data.as_deref() {
        validate_calendar_data_for_confirmation(data)?;
    }
    verify_calendar_snapshot(&calendar_path, payload.data.as_deref())?;
    write_guard.confirm_loaded(&calendar_path);
    Ok(())
}

#[tauri::command]
pub fn cmd_calendar_save(app: AppHandle, payload: CalendarSavePayload) -> Result<(), String> {
    let loaded_from = parse_resolved_storage_source(&payload.loaded_from)?;
    let (_, current_source) = resolve_calendar_dir(&app)?;

    if !can_save_calendar(loaded_from, current_source) {
        return Err(format!(
            "Calendar save rejected: loaded from {}, but current storage resolves to {}.",
            resolved_storage_source_to_str(loaded_from),
            resolved_storage_source_to_str(current_source)
        ));
    }

    let dir = resolve_loaded_storage_dir(&app, loaded_from)?;
    let calendar_path = dir.join(file_manager::CALENDAR_FILENAME);
    app.state::<CalendarWriteGuard>()
        .write_if_allowed(&calendar_path, || write_calendar_data(&dir, &payload.data))
}

#[tauri::command]
pub fn cmd_calendar_reset(app: AppHandle, payload: CalendarSavePayload) -> Result<(), String> {
    validate_empty_calendar_reset(&payload.data)?;
    let loaded_from = parse_resolved_storage_source(&payload.loaded_from)?;
    let (_, current_source) = resolve_calendar_dir(&app)?;

    if !can_save_calendar(loaded_from, current_source) {
        return Err(format!(
            "Calendar reset rejected: loaded from {}, but current storage resolves to {}.",
            resolved_storage_source_to_str(loaded_from),
            resolved_storage_source_to_str(current_source)
        ));
    }

    let dir = resolve_loaded_storage_dir(&app, loaded_from)?;
    let calendar_path = dir.join(file_manager::CALENDAR_FILENAME);
    app.state::<CalendarWriteGuard>()
        .reset(&calendar_path, || write_calendar_data(&dir, &payload.data))
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
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
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
pub fn cmd_settings_browse_autosave_dir(window: WebviewWindow) -> Result<Option<String>, String> {
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
    let state = config_manager::get_local_auto_save_dir_state(
        &app,
        &file_manager::get_auto_save_dir(&documents),
    );

    Ok(build_auto_save_dir_info(state))
}

#[tauri::command]
pub fn cmd_settings_get_autosave_dir(app: AppHandle) -> AutoSaveDirInfo {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let state = config_manager::get_local_auto_save_dir_state(
        &app,
        &file_manager::get_auto_save_dir(&documents),
    );

    build_auto_save_dir_info(state)
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

    let update = app.state::<PendingUpdate>().0.lock().unwrap().take();

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

    let downloaded = app.state::<DownloadedUpdate>().0.lock().unwrap().take();

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
    }

    #[cfg(not(target_os = "windows"))]
    app.restart();
}

// ── Shell commands ──

#[tauri::command]
pub fn cmd_shell_open_external(app: AppHandle, url: String) -> Result<(), String> {
    // Validate URL protocol
    let allowed_schemes = ["http:", "https:", "mailto:"];
    let has_valid_scheme = allowed_schemes.iter().any(|scheme| url.starts_with(scheme));

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

    let cloud_notes_dir = PathBuf::from(sync_folder).join("HwanNote").join("Notes");

    // Create the cloud notes directory
    fs::create_dir_all(&cloud_notes_dir)
        .map_err(|e| format!("Failed to create cloud directory: {}", e))?;

    let (migration_result, calendar_copied) = if copy_existing {
        let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
        let src = get_calendar_local_dir(&app, &documents)?;
        let dst = cloud_notes_dir.clone();

        tauri::async_runtime::spawn_blocking(move || {
            let migration_result = file_manager::migrate_notes(&src, &dst)?;
            let calendar_copied = file_manager::migrate_calendar_file(&src, &dst)?;
            Ok::<_, String>((migration_result, calendar_copied))
        })
        .await
        .map_err(|e| e.to_string())??
    } else {
        (
            file_manager::MigrationResult {
                files_copied: 0,
                index_copied: false,
            },
            false,
        )
    };

    config_manager::set_cloud_sync_provider(&app, Some(&provider))?;
    config_manager::set_cloud_sync_source(&app, LibrarySource::Cloud)?;

    Ok(CloudSyncResult {
        provider: Some(provider),
        files_copied: migration_result.files_copied,
        calendar_copied,
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
        calendar_copied: false,
        active_source: library_source_to_str(LibrarySource::Local).to_string(),
    })
}

#[tauri::command]
pub fn cmd_cloud_sync_status(app: AppHandle) -> CloudSyncStatus {
    let provider = config_manager::get_cloud_sync_provider(&app);
    let enabled = provider.is_some();
    let active_source = config_manager::get_cloud_sync_source(&app);
    let resolved_source = resolve_storage_dir(&app, false)
        .ok()
        .map(|(_, source)| source);
    let cloud_unavailable = active_source == LibrarySource::Cloud
        && config_manager::get_cloud_notes_dir(&app).is_none_or(|path| !path.is_dir());

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
        resolved_source: resolved_source
            .map(|source| resolved_storage_source_to_str(source).to_string()),
        cloud_unavailable,
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

#[cfg(test)]
mod tests {
    use super::{
        backup_calendar_file, build_auto_save_dir_info, calendar_recovery_copy_candidate,
        can_save_calendar, can_save_note, configured_local_dir_unavailable_error,
        create_unique_calendar_temp, loaded_source_writes_to_cloud,
        preserve_calendar_recovery_copy, resolve_storage_dir_with_local_dir,
        select_loaded_storage_dir, select_note_library_mutation_dir,
        validate_calendar_data_for_confirmation, validate_empty_calendar_reset,
        verify_calendar_snapshot, write_calendar_data, write_unique_calendar_backup,
        CalendarWriteGuard, CloudSyncStatus, ResolvedStorageSource,
        MAX_CALENDAR_RECOVERY_COPY_BYTES, MAX_CALENDAR_RECOVERY_COPY_COUNT,
    };
    use crate::config_manager::{LibrarySource, LocalAutoSaveDirState};
    use crate::file_manager::{self, AutoSavePayload};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "hwan-note-command-test-{}-{}-{}",
            name,
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn note_payload(content: &str) -> AutoSavePayload {
        AutoSavePayload {
            note_id: "shared-note".to_string(),
            title: "Shared note".to_string(),
            content: content.to_string(),
            folder_path: None,
            is_title_manual: Some(true),
            is_pinned: Some(false),
        }
    }

    #[test]
    fn calendar_save_allows_local_fallback_after_cloud_returns() {
        assert!(can_save_calendar(
            ResolvedStorageSource::LocalFallback,
            ResolvedStorageSource::Cloud
        ));
    }

    #[test]
    fn calendar_save_allows_cloud_to_cloud() {
        assert!(can_save_calendar(
            ResolvedStorageSource::Cloud,
            ResolvedStorageSource::Cloud
        ));
    }

    #[test]
    fn calendar_save_allows_local_fallback_to_local_fallback() {
        assert!(can_save_calendar(
            ResolvedStorageSource::LocalFallback,
            ResolvedStorageSource::LocalFallback
        ));
    }

    #[test]
    fn calendar_save_rejects_cloud_loaded_data_when_cloud_is_missing() {
        assert!(!can_save_calendar(
            ResolvedStorageSource::Cloud,
            ResolvedStorageSource::LocalFallback
        ));
    }

    #[test]
    fn calendar_backups_are_unique_and_preserve_each_payload() {
        let root = make_temp_dir("calendar-backup-unique");
        let calendar_path = root.join(file_manager::CALENDAR_FILENAME);

        let first_backup = write_unique_calendar_backup(&calendar_path, b"first payload").unwrap();
        let second_backup =
            write_unique_calendar_backup(&calendar_path, b"second payload").unwrap();

        assert_ne!(first_backup, second_backup);
        assert_eq!(first_backup.parent(), Some(root.as_path()));
        assert_eq!(second_backup.parent(), Some(root.as_path()));
        assert_eq!(fs::read(first_backup).unwrap(), b"first payload");
        assert_eq!(fs::read(second_backup).unwrap(), b"second payload");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_text_calendar_backup_is_byte_for_byte() {
        let root = make_temp_dir("calendar-backup-bytes");
        let calendar_path = root.join(file_manager::CALENDAR_FILENAME);
        let invalid_utf8 = b"{\"title\": \xff\xfe}\0";
        fs::write(&calendar_path, invalid_utf8).unwrap();

        let backup_path = backup_calendar_file(&calendar_path).unwrap();

        assert_eq!(fs::read(backup_path).unwrap(), invalid_utf8);
        assert!(fs::read_to_string(&calendar_path).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn calendar_recovery_copies_are_unique_and_never_overwrite_existing_files() {
        let root = make_temp_dir("calendar-recovery-unique");
        let calendar_path = root.join(file_manager::CALENDAR_FILENAME);
        let existing_recovery_path = root.join("calendar.json.local-recovery.bak");
        fs::write(&calendar_path, b"canonical calendar sentinel").unwrap();
        fs::write(&existing_recovery_path, b"existing recovery sentinel").unwrap();

        let first_data = r#"{"version":4,"todos":{},"inbox":[],"noteLinks":{},"copy":1}"#;
        let second_data = r#"{"version":4,"todos":{},"inbox":[],"noteLinks":{},"copy":2}"#;
        let first_copy = preserve_calendar_recovery_copy(&root, first_data).unwrap();
        let second_copy = preserve_calendar_recovery_copy(&root, second_data).unwrap();

        assert_eq!(first_copy, root.join("calendar.json.local-recovery.bak.1"));
        assert_eq!(second_copy, root.join("calendar.json.local-recovery.bak.2"));
        assert_eq!(
            fs::read(&calendar_path).unwrap(),
            b"canonical calendar sentinel"
        );
        assert_eq!(
            fs::read(&existing_recovery_path).unwrap(),
            b"existing recovery sentinel"
        );
        assert_eq!(fs::read(first_copy).unwrap(), first_data.as_bytes());
        assert_eq!(fs::read(second_copy).unwrap(), second_data.as_bytes());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn calendar_recovery_copy_creates_directory_and_preserves_utf8_bytes() {
        let root = make_temp_dir("calendar-recovery-bytes");
        let local_dir = root.join("configured").join("nested");
        let data = "{\r\n  \"version\": 4,\r\n  \"todos\": {},\r\n  \"inbox\": [],\r\n  \"noteLinks\": {},\r\n  \"label\": \"복구 사본\"\r\n}\r\n";

        let recovery_path = preserve_calendar_recovery_copy(&local_dir, data).unwrap();

        assert_eq!(
            recovery_path,
            local_dir.join("calendar.json.local-recovery.bak")
        );
        assert_eq!(fs::read(recovery_path).unwrap(), data.as_bytes());

        let invalid_dir = root.join("invalid");
        assert!(preserve_calendar_recovery_copy(&invalid_dir, "{}").is_err());
        assert!(!invalid_dir.exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identical_calendar_recovery_payload_reuses_the_existing_copy() {
        let root = make_temp_dir("calendar-recovery-deduplicated");
        let data = r#"{"version":4,"todos":{},"inbox":[],"noteLinks":{},"label":"same"}"#;

        let first_copy = preserve_calendar_recovery_copy(&root, data).unwrap();
        let repeated_copy = preserve_calendar_recovery_copy(&root, data).unwrap();

        assert_eq!(first_copy, repeated_copy);
        assert!(!calendar_recovery_copy_candidate(&root, 1).exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_calendar_recovery_payload_is_rejected_before_creating_a_directory() {
        let root = make_temp_dir("calendar-recovery-oversized");
        let local_dir = root.join("not-created");
        let oversized_label = "x".repeat(MAX_CALENDAR_RECOVERY_COPY_BYTES as usize);
        let data = format!(
            r#"{{"version":4,"todos":{{}},"inbox":[],"noteLinks":{{}},"label":"{}"}}"#,
            oversized_label
        );

        let error = preserve_calendar_recovery_copy(&local_dir, &data).unwrap_err();

        assert!(error.contains("exceeding"));
        assert!(!local_dir.exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn calendar_recovery_copy_limit_fails_closed_without_overwriting() {
        let root = make_temp_dir("calendar-recovery-limit");
        for sequence in 0..MAX_CALENDAR_RECOVERY_COPY_COUNT {
            fs::write(
                calendar_recovery_copy_candidate(&root, sequence),
                format!("retained copy {}", sequence),
            )
            .unwrap();
        }
        let data = r#"{"version":4,"todos":{},"inbox":[],"noteLinks":{},"label":"new"}"#;

        let error = preserve_calendar_recovery_copy(&root, data).unwrap_err();

        assert!(error.contains("retention limit"));
        for sequence in 0..MAX_CALENDAR_RECOVERY_COPY_COUNT {
            assert_eq!(
                fs::read_to_string(calendar_recovery_copy_candidate(&root, sequence)).unwrap(),
                format!("retained copy {}", sequence)
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn non_file_in_calendar_recovery_namespace_is_rejected() {
        let root = make_temp_dir("calendar-recovery-reserved-path");
        let reserved_path = calendar_recovery_copy_candidate(&root, 0);
        fs::create_dir(&reserved_path).unwrap();
        let data = r#"{"version":4,"todos":{},"inbox":[],"noteLinks":{}}"#;

        let error = preserve_calendar_recovery_copy(&root, data).unwrap_err();

        assert!(error.contains("not a regular file"));
        assert!(reserved_path.is_dir());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn blocked_calendar_rejects_normal_write_until_confirmed() {
        let guard = CalendarWriteGuard::default();
        let blocked_path = PathBuf::from("blocked/calendar.json");
        let other_path = PathBuf::from("other/calendar.json");
        guard.block(&blocked_path);

        let blocked_write = guard.write_if_allowed(&blocked_path, || {
            panic!("blocked calendar write must not run")
        });

        assert!(blocked_write.is_err());
        assert!(guard.is_blocked(&blocked_path));
        assert!(guard.write_if_allowed(&other_path, || Ok(())).is_ok());

        guard.confirm_loaded(&blocked_path);

        assert!(!guard.is_blocked(&blocked_path));
        assert!(guard.write_if_allowed(&blocked_path, || Ok(())).is_ok());
    }

    #[test]
    fn reset_clears_block_only_after_successful_write() {
        let guard = CalendarWriteGuard::default();
        let root = make_temp_dir("calendar-reset-guard");
        let calendar_path = root.join(file_manager::CALENDAR_FILENAME);
        fs::write(&calendar_path, "corrupt data").unwrap();
        guard.block(&calendar_path);

        let failed_reset = guard.reset(&calendar_path, || Err("write failed".to_string()));

        assert!(failed_reset.is_err());
        assert!(guard.is_blocked(&calendar_path));
        assert!(guard.write_if_allowed(&calendar_path, || Ok(())).is_err());

        let reset_data = r#"{"version":4,"todos":{},"inbox":[],"noteLinks":{}}"#;
        assert!(guard
            .reset(&calendar_path, || write_calendar_data(&root, reset_data))
            .is_ok());
        assert!(!guard.is_blocked(&calendar_path));
        assert_eq!(fs::read_to_string(&calendar_path).unwrap(), reset_data);
        assert!(guard.write_if_allowed(&calendar_path, || Ok(())).is_ok());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn calendar_confirmation_rejects_changed_or_unexpected_files() {
        let root = make_temp_dir("calendar-confirm-snapshot");
        let calendar_path = root.join(file_manager::CALENDAR_FILENAME);
        fs::write(&calendar_path, "loaded data").unwrap();

        assert!(verify_calendar_snapshot(&calendar_path, Some("loaded data")).is_ok());
        assert!(verify_calendar_snapshot(&calendar_path, Some("stale data")).is_err());
        assert!(verify_calendar_snapshot(&calendar_path, None).is_err());

        fs::remove_file(&calendar_path).unwrap();
        assert!(verify_calendar_snapshot(&calendar_path, None).is_ok());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn calendar_confirmation_validates_the_frontend_parse_contract() {
        assert!(validate_calendar_data_for_confirmation(
            r#"{"version":4,"todos":{},"inbox":[],"noteLinks":{}}"#
        )
        .is_ok());
        assert!(validate_calendar_data_for_confirmation(r#"{"todos":{},"noteLinks":{}}"#).is_ok());
        assert!(validate_calendar_data_for_confirmation("").is_err());
        assert!(validate_calendar_data_for_confirmation("{").is_err());
        assert!(validate_calendar_data_for_confirmation(
            r#"{"version":4,"todos":[],"inbox":[],"noteLinks":{}}"#
        )
        .is_err());
        assert!(validate_calendar_data_for_confirmation(
            r#"{"version":999,"todos":{},"inbox":[],"noteLinks":{}}"#
        )
        .is_err());
    }

    #[test]
    fn calendar_reset_accepts_only_the_empty_current_schema() {
        assert!(validate_empty_calendar_reset(
            r#"{"version":4,"todos":{},"inbox":[],"noteLinks":{}}"#
        )
        .is_ok());
        assert!(validate_empty_calendar_reset(
            r#"{"version":4,"todos":{"2026-08-11":{"items":[]}},"inbox":[],"noteLinks":{}}"#
        )
        .is_err());
        assert!(validate_empty_calendar_reset(
            r#"{"version":3,"todos":{},"inbox":[],"noteLinks":{}}"#
        )
        .is_err());
    }

    #[test]
    fn calendar_write_does_not_reuse_an_existing_temp_path() {
        let root = make_temp_dir("calendar-temp-exclusive");
        let first_temp_path = root.join(".calendar.json.tmp");
        fs::write(&first_temp_path, "sentinel").unwrap();

        let (temp_file, selected_path) = create_unique_calendar_temp(&root).unwrap();
        drop(temp_file);

        assert_ne!(selected_path, first_temp_path);
        assert_eq!(fs::read_to_string(&first_temp_path).unwrap(), "sentinel");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn note_save_allows_fallback_origin_after_cloud_returns() {
        assert!(can_save_note(
            ResolvedStorageSource::LocalFallback,
            ResolvedStorageSource::Cloud
        ));
    }

    #[test]
    fn local_fallback_loaded_notes_never_target_cloud_storage() {
        assert!(!loaded_source_writes_to_cloud(
            ResolvedStorageSource::LocalFallback
        ));
        assert!(loaded_source_writes_to_cloud(ResolvedStorageSource::Cloud));
    }

    #[test]
    fn fallback_loaded_note_write_leaves_same_id_cloud_file_unchanged() {
        let root = make_temp_dir("fallback-target");
        let local_dir = root.join("local");
        let cloud_dir = root.join("cloud");
        fs::create_dir_all(&local_dir).unwrap();
        fs::create_dir_all(&cloud_dir).unwrap();

        file_manager::auto_save_markdown_note(&cloud_dir, &note_payload("# Cloud\n")).unwrap();
        let target_dir = select_loaded_storage_dir(
            || Ok(local_dir.clone()),
            Some(cloud_dir.clone()),
            ResolvedStorageSource::LocalFallback,
        )
        .unwrap();
        file_manager::auto_save_markdown_note(&target_dir, &note_payload("# Local fallback\n"))
            .unwrap();

        let cloud_notes = file_manager::load_markdown_notes(&cloud_dir).unwrap();
        let local_notes = file_manager::load_markdown_notes(&local_dir).unwrap();
        assert_eq!(cloud_notes.len(), 1);
        assert_eq!(cloud_notes[0].markdown, "# Cloud\n");
        assert_eq!(local_notes.len(), 1);
        assert_eq!(local_notes[0].markdown, "# Local fallback\n");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn note_save_rejects_cloud_loaded_data_when_cloud_is_missing() {
        assert!(!can_save_note(
            ResolvedStorageSource::Cloud,
            ResolvedStorageSource::LocalFallback
        ));
    }

    #[test]
    fn missing_cloud_target_never_falls_back_for_cloud_loaded_note() {
        let local_dir = make_temp_dir("missing-cloud-target");
        let result =
            select_loaded_storage_dir(|| Ok(local_dir.clone()), None, ResolvedStorageSource::Cloud);

        assert!(result.is_err());
        assert!(file_manager::load_markdown_notes(&local_dir)
            .unwrap()
            .is_empty());

        fs::remove_dir_all(local_dir).unwrap();
    }

    #[test]
    fn cloud_loaded_mutation_is_rejected_without_touching_local_same_id_note() {
        let root = make_temp_dir("cloud-mutation-fallback");
        let local_dir = root.join("local");
        let missing_cloud_dir = root.join("missing-cloud");
        fs::create_dir_all(&local_dir).unwrap();
        file_manager::auto_save_markdown_note(&local_dir, &note_payload("# Local\n")).unwrap();

        let result = select_note_library_mutation_dir(
            || Ok(local_dir.clone()),
            Some(missing_cloud_dir),
            ResolvedStorageSource::Cloud,
            ResolvedStorageSource::LocalFallback,
            "Note deletion",
        );

        assert!(result.is_err());
        let local_notes = file_manager::load_markdown_notes(&local_dir).unwrap();
        assert_eq!(local_notes.len(), 1);
        assert_eq!(local_notes[0].markdown, "# Local\n");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fallback_loaded_delete_targets_local_after_cloud_returns() {
        let root = make_temp_dir("fallback-delete-target");
        let local_dir = root.join("local");
        let cloud_dir = root.join("cloud");
        fs::create_dir_all(&local_dir).unwrap();
        fs::create_dir_all(&cloud_dir).unwrap();
        file_manager::auto_save_markdown_note(&local_dir, &note_payload("# Local\n")).unwrap();
        file_manager::auto_save_markdown_note(&cloud_dir, &note_payload("# Cloud\n")).unwrap();

        let target_dir = select_note_library_mutation_dir(
            || Ok(local_dir.clone()),
            Some(cloud_dir.clone()),
            ResolvedStorageSource::LocalFallback,
            ResolvedStorageSource::Cloud,
            "Note deletion",
        )
        .unwrap();
        let deleted =
            file_manager::delete_note_file_and_index(&target_dir, "shared-note", |path| {
                fs::remove_file(path).map_err(|error| error.to_string())
            })
            .unwrap();

        assert!(deleted);
        assert!(file_manager::load_markdown_notes(&local_dir)
            .unwrap()
            .is_empty());
        let cloud_notes = file_manager::load_markdown_notes(&cloud_dir).unwrap();
        assert_eq!(cloud_notes.len(), 1);
        assert_eq!(cloud_notes[0].markdown, "# Cloud\n");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fallback_loaded_folder_changes_leave_cloud_folder_unchanged() {
        let root = make_temp_dir("fallback-folder-target");
        let local_dir = root.join("local");
        let cloud_dir = root.join("cloud");
        fs::create_dir_all(&local_dir).unwrap();
        fs::create_dir_all(&cloud_dir).unwrap();
        let mut local_payload = note_payload("# Local\n");
        local_payload.folder_path = Some("alpha".to_string());
        let mut cloud_payload = note_payload("# Cloud\n");
        cloud_payload.folder_path = Some("alpha".to_string());
        file_manager::auto_save_markdown_note(&local_dir, &local_payload).unwrap();
        file_manager::auto_save_markdown_note(&cloud_dir, &cloud_payload).unwrap();

        let target_dir = select_note_library_mutation_dir(
            || Ok(local_dir.clone()),
            Some(cloud_dir.clone()),
            ResolvedStorageSource::LocalFallback,
            ResolvedStorageSource::Cloud,
            "Folder rename",
        )
        .unwrap();
        file_manager::rename_folder(&target_dir, "alpha", "beta").unwrap();

        assert_eq!(
            file_manager::list_folders(&local_dir).unwrap(),
            vec!["beta"]
        );
        assert_eq!(
            file_manager::list_folders(&cloud_dir).unwrap(),
            vec!["alpha"]
        );
        let cloud_notes = file_manager::load_markdown_notes(&cloud_dir).unwrap();
        assert_eq!(cloud_notes.len(), 1);
        assert_eq!(cloud_notes[0].folder_path, "alpha");
        assert_eq!(cloud_notes[0].markdown, "# Cloud\n");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn auto_save_dir_info_marks_only_unset_state_as_default() {
        let default_info = build_auto_save_dir_info(LocalAutoSaveDirState::Unset(PathBuf::from(
            "C:/Users/test/Documents/HwanNote/Notes",
        )));
        let custom_info = build_auto_save_dir_info(LocalAutoSaveDirState::Available(
            PathBuf::from("D:/Library"),
        ));

        assert!(default_info.is_default);
        assert_eq!(default_info.status, "unset");
        assert_eq!(default_info.custom_dir, None);
        assert_eq!(
            default_info.effective_dir.as_deref(),
            Some("C:/Users/test/Documents/HwanNote/Notes")
        );
        assert_eq!(
            default_info.expected_dir,
            "C:/Users/test/Documents/HwanNote/Notes"
        );
        assert_eq!(default_info.error, None);

        assert!(!custom_info.is_default);
        assert_eq!(custom_info.status, "available");
        assert_eq!(custom_info.custom_dir.as_deref(), Some("D:/Library"));
        assert_eq!(custom_info.effective_dir.as_deref(), Some("D:/Library"));
        assert_eq!(custom_info.expected_dir, "D:/Library");
        assert_eq!(custom_info.error, None);
    }

    #[test]
    fn auto_save_dir_info_reports_unavailable_custom_directory_without_switching_to_default() {
        let unavailable_path = PathBuf::from("Z:/DetachedLibrary");
        let info =
            build_auto_save_dir_info(LocalAutoSaveDirState::Unavailable(unavailable_path.clone()));

        assert!(!info.is_default);
        assert_eq!(info.status, "unavailable");
        assert_eq!(info.custom_dir.as_deref(), Some("Z:/DetachedLibrary"));
        assert_eq!(info.effective_dir, None);
        assert_eq!(info.expected_dir, "Z:/DetachedLibrary");
        assert_eq!(
            info.error.as_deref(),
            Some("custom_auto_save_dir_unavailable")
        );
    }

    #[test]
    fn storage_resolution_uses_default_only_when_the_local_directory_is_unset() {
        let default_dir = PathBuf::from("C:/Users/test/Documents/HwanNote/Notes");
        let resolved = resolve_storage_dir_with_local_dir(
            || Ok(default_dir.clone()),
            None,
            LibrarySource::Local,
        )
        .unwrap();

        assert_eq!(resolved, (default_dir, ResolvedStorageSource::Local));
    }

    #[test]
    fn storage_resolution_blocks_local_loads_and_writes_when_the_custom_directory_is_missing() {
        let root = make_temp_dir("missing-custom-blocks-local");
        let default_dir = root.join("default-must-not-be-created");
        let error = resolve_storage_dir_with_local_dir(
            || {
                Err(configured_local_dir_unavailable_error(
                    PathBuf::from("Z:/DetachedLibrary").as_path(),
                ))
            },
            None,
            LibrarySource::Local,
        )
        .unwrap_err();

        assert!(error.contains("custom_auto_save_dir_unavailable"));
        assert!(error.contains("Z:/DetachedLibrary"));
        assert!(!default_dir.exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_loaded_write_rejects_an_unavailable_custom_directory() {
        let error = select_loaded_storage_dir(
            || {
                Err(configured_local_dir_unavailable_error(
                    PathBuf::from("Z:/DetachedLibrary").as_path(),
                ))
            },
            None,
            ResolvedStorageSource::Local,
        )
        .unwrap_err();

        assert!(error.contains("custom_auto_save_dir_unavailable"));
        assert!(error.contains("Z:/DetachedLibrary"));
    }

    #[test]
    fn available_cloud_does_not_evaluate_an_unavailable_custom_local_directory() {
        let cloud_dir = make_temp_dir("available-cloud-with-missing-custom");
        let resolved = resolve_storage_dir_with_local_dir(
            || panic!("available cloud storage must not evaluate the local directory"),
            Some(cloud_dir.clone()),
            LibrarySource::Cloud,
        )
        .unwrap();

        assert_eq!(resolved, (cloud_dir.clone(), ResolvedStorageSource::Cloud));

        fs::remove_dir_all(cloud_dir).unwrap();
    }

    #[test]
    fn cloud_loaded_write_does_not_evaluate_an_unavailable_custom_local_directory() {
        let cloud_dir = make_temp_dir("cloud-write-with-missing-custom");
        let target = select_loaded_storage_dir(
            || panic!("cloud-loaded writes must not evaluate the local directory"),
            Some(cloud_dir.clone()),
            ResolvedStorageSource::Cloud,
        )
        .unwrap();

        assert_eq!(target, cloud_dir.clone());

        fs::remove_dir_all(cloud_dir).unwrap();
    }

    #[test]
    fn missing_cloud_uses_local_fallback_only_when_local_directory_is_available() {
        let root = make_temp_dir("missing-cloud-fallback-check");
        let local_dir = root.join("local");
        let missing_cloud_dir = root.join("missing-cloud");
        fs::create_dir(&local_dir).unwrap();
        let resolved = resolve_storage_dir_with_local_dir(
            || Ok(local_dir.clone()),
            Some(missing_cloud_dir),
            LibrarySource::Cloud,
        )
        .unwrap();

        assert_eq!(resolved, (local_dir, ResolvedStorageSource::LocalFallback));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_cloud_and_unavailable_custom_local_directory_return_custom_error() {
        let root = make_temp_dir("missing-cloud-custom-error");
        let missing_cloud_dir = root.join("missing-cloud");
        let error = resolve_storage_dir_with_local_dir(
            || {
                Err(configured_local_dir_unavailable_error(
                    PathBuf::from("Z:/DetachedLibrary").as_path(),
                ))
            },
            Some(missing_cloud_dir),
            LibrarySource::Cloud,
        )
        .unwrap_err();

        assert!(error.contains("custom_auto_save_dir_unavailable"));
        assert!(!error.contains("local_fallback"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cloud_status_can_report_an_unresolved_storage_source_without_hiding_cloud_state() {
        let status = CloudSyncStatus {
            enabled: true,
            provider: Some("google_drive".to_string()),
            sync_folder: None,
            active_source: "cloud".to_string(),
            resolved_source: None,
            cloud_unavailable: true,
        };

        let serialized = serde_json::to_value(status).unwrap();

        assert_eq!(serialized["provider"], "google_drive");
        assert_eq!(serialized["activeSource"], "cloud");
        assert_eq!(serialized["resolvedSource"], serde_json::Value::Null);
        assert_eq!(serialized["cloudUnavailable"], true);
    }
}
