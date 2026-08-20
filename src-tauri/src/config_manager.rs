use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_save_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud_sync_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud_sync_source: Option<LibrarySource>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibrarySource {
    Local,
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustomAutoSaveDirState {
    Unset,
    Available(PathBuf),
    Unavailable(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalAutoSaveDirState {
    Unset(PathBuf),
    Available(PathBuf),
    Unavailable(PathBuf),
}

impl LocalAutoSaveDirState {
    pub fn expected_dir(&self) -> &Path {
        match self {
            Self::Unset(path) | Self::Available(path) | Self::Unavailable(path) => path,
        }
    }

    pub fn configured_dir(&self) -> Option<&Path> {
        match self {
            Self::Unset(_) => None,
            Self::Available(path) | Self::Unavailable(path) => Some(path),
        }
    }

    pub fn is_default(&self) -> bool {
        matches!(self, Self::Unset(_))
    }
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("config.json")
}

fn read_config(app: &AppHandle) -> AppConfig {
    let config_path = get_config_path(app);
    match fs::read_to_string(&config_path) {
        Ok(raw) => serde_json::from_str::<AppConfig>(&raw).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

fn write_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let config_path = get_config_path(app);
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&config_path, json).map_err(|e| e.to_string())
}

fn normalize_path_for_compare(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn get_cloud_provider_root(provider: &str) -> Option<String> {
    detect_cloud_providers()
        .into_iter()
        .find(|info| info.id == provider)
        .and_then(|info| info.sync_folder)
}

fn get_cloud_hwan_dir_for_provider(provider: &str) -> Option<PathBuf> {
    get_cloud_provider_root(provider).map(|root| PathBuf::from(root).join("HwanNote"))
}

fn get_cloud_notes_dir_for_provider(provider: &str) -> Option<PathBuf> {
    get_cloud_hwan_dir_for_provider(provider).map(|dir| dir.join("Notes"))
}

fn is_cloud_notes_dir_for_provider(provider: &str, dir: &str) -> bool {
    get_cloud_notes_dir_for_provider(provider)
        .map(|cloud_dir| {
            normalize_path_for_compare(cloud_dir.to_string_lossy().as_ref())
                == normalize_path_for_compare(dir)
        })
        .unwrap_or(false)
}

#[cfg(any(test, windows))]
fn classify_legacy_cloud_sync_dir(
    dir: &str,
    providers: &[CloudProviderInfo],
) -> Option<(String, LibrarySource)> {
    let normalized_dir = normalize_path_for_compare(dir);

    for provider in providers {
        let Some(root) = provider.sync_folder.as_deref() else {
            continue;
        };
        let hwan_dir = PathBuf::from(root).join("HwanNote");
        let notes_dir = hwan_dir.join("Notes");

        let normalized_hwan_dir = normalize_path_for_compare(hwan_dir.to_string_lossy().as_ref());
        if normalized_dir == normalized_hwan_dir {
            return Some((provider.id.clone(), LibrarySource::Local));
        }

        let normalized_notes_dir = normalize_path_for_compare(notes_dir.to_string_lossy().as_ref());
        if normalized_dir == normalized_notes_dir {
            return Some((provider.id.clone(), LibrarySource::Cloud));
        }
    }

    None
}

fn classify_custom_auto_save_dir(config: &AppConfig) -> CustomAutoSaveDirState {
    let Some(dir) = config.auto_save_dir.as_deref() else {
        return CustomAutoSaveDirState::Unset;
    };
    if dir.is_empty() {
        return CustomAutoSaveDirState::Unset;
    }
    if config
        .cloud_sync_provider
        .as_deref()
        .is_some_and(|provider| is_cloud_notes_dir_for_provider(provider, dir))
    {
        return CustomAutoSaveDirState::Unset;
    }

    let path = PathBuf::from(dir);
    if path.is_dir() {
        CustomAutoSaveDirState::Available(path)
    } else {
        CustomAutoSaveDirState::Unavailable(path)
    }
}

pub fn get_custom_auto_save_dir_state(app: &AppHandle) -> CustomAutoSaveDirState {
    let config = read_config(app);
    classify_custom_auto_save_dir(&config)
}

pub fn set_custom_auto_save_dir(app: &AppHandle, dir: Option<&str>) -> Result<(), String> {
    if let Some(d) = dir {
        let path = Path::new(d);
        if !path.is_absolute() {
            return Err("Path must be absolute".to_string());
        }
        if !path.is_dir() {
            return Err("Path must be an existing directory".to_string());
        }
    }
    let mut config = read_config(app);
    config.auto_save_dir = dir.map(String::from);
    write_config(app, &config)
}

pub fn get_cloud_sync_provider(app: &AppHandle) -> Option<String> {
    let config = read_config(app);
    config.cloud_sync_provider.filter(|p| !p.is_empty())
}

pub fn set_cloud_sync_provider(app: &AppHandle, provider: Option<&str>) -> Result<(), String> {
    let mut config = read_config(app);
    if let Some(existing_dir) = config.auto_save_dir.clone() {
        let matches_previous_cloud_path = config
            .cloud_sync_provider
            .as_deref()
            .is_some_and(|current| is_cloud_notes_dir_for_provider(current, &existing_dir));
        let matches_next_cloud_path =
            provider.is_some_and(|next| is_cloud_notes_dir_for_provider(next, &existing_dir));
        if matches_previous_cloud_path || matches_next_cloud_path {
            config.auto_save_dir = None;
        }
    }
    config.cloud_sync_provider = provider.map(String::from);
    config.cloud_sync_source = Some(match provider {
        Some(_) => config.cloud_sync_source.unwrap_or(LibrarySource::Cloud),
        None => LibrarySource::Local,
    });
    write_config(app, &config)
}

pub fn get_local_auto_save_dir_state(app: &AppHandle, default_dir: &Path) -> LocalAutoSaveDirState {
    classify_local_auto_save_dir(get_custom_auto_save_dir_state(app), default_dir)
}

fn classify_local_auto_save_dir(
    custom_state: CustomAutoSaveDirState,
    default_dir: &Path,
) -> LocalAutoSaveDirState {
    match custom_state {
        CustomAutoSaveDirState::Unset => LocalAutoSaveDirState::Unset(default_dir.to_path_buf()),
        CustomAutoSaveDirState::Available(path) => LocalAutoSaveDirState::Available(path),
        CustomAutoSaveDirState::Unavailable(path) => LocalAutoSaveDirState::Unavailable(path),
    }
}

pub fn get_cloud_sync_source(app: &AppHandle) -> LibrarySource {
    let config = read_config(app);
    if config
        .cloud_sync_provider
        .as_ref()
        .is_some_and(|provider| !provider.is_empty())
    {
        config.cloud_sync_source.unwrap_or(LibrarySource::Cloud)
    } else {
        LibrarySource::Local
    }
}

pub fn set_cloud_sync_source(app: &AppHandle, source: LibrarySource) -> Result<(), String> {
    let mut config = read_config(app);
    config.cloud_sync_source = Some(source);
    write_config(app, &config)
}

pub fn get_cloud_notes_dir(app: &AppHandle) -> Option<PathBuf> {
    let provider = get_cloud_sync_provider(app)?;
    get_cloud_notes_dir_for_provider(&provider)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub sync_folder: Option<String>,
}

fn detect_onedrive() -> Option<String> {
    // 1st: %OneDrive% environment variable
    if let Ok(path) = std::env::var("OneDrive") {
        if !path.is_empty() && Path::new(&path).exists() {
            return Some(path);
        }
    }
    // 2nd: %OneDriveConsumer% environment variable
    if let Ok(path) = std::env::var("OneDriveConsumer") {
        if !path.is_empty() && Path::new(&path).exists() {
            return Some(path);
        }
    }
    // 3rd: Default path ~/OneDrive
    if let Some(home) = dirs::home_dir() {
        let default = home.join("OneDrive");
        if default.exists() {
            return Some(default.to_string_lossy().to_string());
        }
    }
    None
}

fn detect_google_drive() -> Option<String> {
    if let Some(home) = dirs::home_dir() {
        // Legacy "Backup and Sync": ~/Google Drive/My Drive
        let my_drive = home.join("Google Drive").join("My Drive");
        if my_drive.exists() {
            return Some(my_drive.to_string_lossy().to_string());
        }
        let default = home.join("Google Drive");
        if default.exists() {
            return Some(default.to_string_lossy().to_string());
        }
    }

    // Modern "Google Drive Desktop" (DriveFS) only exists on Windows.
    // Keep the heuristic out of the Linux runtime path.
    #[cfg(windows)]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let drivefs = Path::new(&local_app_data).join("Google").join("DriveFS");
            if drivefs.exists() {
                for letter in b'D'..=b'Z' {
                    let root = format!("{}:\\", letter as char);
                    for subfolder in &["My Drive", "내 드라이브"] {
                        let candidate = PathBuf::from(&root).join(subfolder);
                        if candidate.exists() {
                            return Some(candidate.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

pub fn detect_cloud_providers() -> Vec<CloudProviderInfo> {
    let onedrive = detect_onedrive();
    let google_drive = detect_google_drive();

    vec![
        CloudProviderInfo {
            id: "onedrive".to_string(),
            name: "OneDrive".to_string(),
            available: onedrive.is_some(),
            sync_folder: onedrive,
        },
        CloudProviderInfo {
            id: "google_drive".to_string(),
            name: "Google Drive".to_string(),
            available: google_drive.is_some(),
            sync_folder: google_drive,
        },
    ]
}

/// One-time migration: copy legacy Electron config to Tauri config directory.
/// Electron stored config at `%APPDATA%/hwan-note/config.json`.
/// Tauri stores config at `%APPDATA%/com.hwankr.hwannote/config.json`.
#[cfg(windows)]
pub fn migrate_legacy_electron_config(app: &AppHandle) -> Result<(), String> {
    let tauri_config_path = get_config_path(app);

    // If Tauri config already exists, skip migration
    if tauri_config_path.exists() {
        return Ok(());
    }

    if let Some(appdata) = std::env::var_os("APPDATA") {
        let legacy_path = PathBuf::from(appdata).join("hwan-note").join("config.json");

        if legacy_path.exists() {
            if let Some(parent) = tauri_config_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&legacy_path, &tauri_config_path).map_err(|e| e.to_string())?;
            tracing::info!(
                "Migrated legacy Electron config from {:?} to {:?}",
                legacy_path,
                tauri_config_path
            );
        }
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn migrate_legacy_electron_config(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub fn migrate_legacy_cloud_sync_config(app: &AppHandle) -> Result<(), String> {
    let mut config = read_config(app);
    if config
        .cloud_sync_provider
        .as_deref()
        .is_some_and(|provider| !provider.is_empty())
    {
        return Ok(());
    }

    let Some(auto_save_dir) = config.auto_save_dir.as_deref() else {
        return Ok(());
    };

    let providers = detect_cloud_providers();
    let Some((provider, source)) = classify_legacy_cloud_sync_dir(auto_save_dir, &providers) else {
        return Ok(());
    };

    config.cloud_sync_provider = Some(provider);
    config.cloud_sync_source = Some(config.cloud_sync_source.unwrap_or(source));
    write_config(app, &config)
}

#[cfg(not(windows))]
pub fn migrate_legacy_cloud_sync_config(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        classify_custom_auto_save_dir, classify_legacy_cloud_sync_dir,
        classify_local_auto_save_dir, AppConfig, CloudProviderInfo, CustomAutoSaveDirState,
        LibrarySource, LocalAutoSaveDirState,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn provider(id: &str, path: &str) -> CloudProviderInfo {
        CloudProviderInfo {
            id: id.to_string(),
            name: id.to_string(),
            available: true,
            sync_folder: Some(path.to_string()),
        }
    }

    fn make_temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "hwan-note-config-test-{}-{}-{}",
            name,
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn classify_legacy_cloud_sync_dir_recognizes_provider_root_hwan_dir_as_local_source() {
        let providers = vec![provider("google_drive", r"G:\내 드라이브")];
        let result = classify_legacy_cloud_sync_dir(r"G:\내 드라이브\HwanNote", &providers);
        assert_eq!(
            result,
            Some(("google_drive".to_string(), LibrarySource::Local))
        );
    }

    #[test]
    fn classify_legacy_cloud_sync_dir_recognizes_notes_dir_as_cloud_source() {
        let providers = vec![provider("google_drive", r"G:\내 드라이브")];
        let result = classify_legacy_cloud_sync_dir(r"G:\내 드라이브\HwanNote\Notes", &providers);
        assert_eq!(
            result,
            Some(("google_drive".to_string(), LibrarySource::Cloud))
        );
    }

    #[test]
    fn classify_legacy_cloud_sync_dir_ignores_unrelated_custom_paths() {
        let providers = vec![provider("google_drive", r"G:\내 드라이브")];
        let result = classify_legacy_cloud_sync_dir(r"D:\Notes", &providers);
        assert!(result.is_none());
    }

    #[test]
    fn classify_custom_auto_save_dir_returns_unset_when_no_directory_is_configured() {
        let config = AppConfig::default();

        let state = classify_custom_auto_save_dir(&config);

        assert_eq!(state, CustomAutoSaveDirState::Unset);
    }

    #[test]
    fn only_unset_custom_directory_selects_the_default_directory() {
        let default_dir = PathBuf::from("C:/Users/test/Documents/HwanNote/Notes");
        let custom_dir = PathBuf::from("D:/Library");

        assert_eq!(
            classify_local_auto_save_dir(CustomAutoSaveDirState::Unset, &default_dir),
            LocalAutoSaveDirState::Unset(default_dir)
        );
        assert_eq!(
            classify_local_auto_save_dir(
                CustomAutoSaveDirState::Unavailable(custom_dir.clone()),
                PathBuf::from("C:/Users/test/Documents/HwanNote/Notes").as_path(),
            ),
            LocalAutoSaveDirState::Unavailable(custom_dir)
        );
    }

    #[test]
    fn classify_custom_auto_save_dir_returns_unavailable_when_configured_directory_is_missing() {
        let root = make_temp_dir("missing-custom");
        let missing_dir = root.join("detached");
        let config = AppConfig {
            auto_save_dir: Some(missing_dir.to_string_lossy().to_string()),
            cloud_sync_provider: None,
            cloud_sync_source: None,
        };

        let state = classify_custom_auto_save_dir(&config);

        assert_eq!(state, CustomAutoSaveDirState::Unavailable(missing_dir));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn classify_custom_auto_save_dir_rejects_a_regular_file() {
        let root = make_temp_dir("custom-path-file");
        let file_path = root.join("not-a-directory");
        fs::write(&file_path, "not a library directory").unwrap();
        let config = AppConfig {
            auto_save_dir: Some(file_path.to_string_lossy().to_string()),
            cloud_sync_provider: None,
            cloud_sync_source: None,
        };

        assert_eq!(
            classify_custom_auto_save_dir(&config),
            CustomAutoSaveDirState::Unavailable(file_path)
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn classify_custom_auto_save_dir_restores_the_configured_directory_when_it_reappears() {
        let dir = make_temp_dir("custom-dir-restore");
        let config = AppConfig {
            auto_save_dir: Some(dir.to_string_lossy().to_string()),
            cloud_sync_provider: None,
            cloud_sync_source: None,
        };

        assert_eq!(
            classify_custom_auto_save_dir(&config),
            CustomAutoSaveDirState::Available(dir.clone())
        );

        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            classify_custom_auto_save_dir(&config),
            CustomAutoSaveDirState::Unavailable(dir.clone())
        );

        fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            classify_custom_auto_save_dir(&config),
            CustomAutoSaveDirState::Available(dir.clone())
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_config_json_deserializes_without_runtime_state_fields() {
        let raw = r#"{
            "autoSaveDir": "D:\\Notes",
            "cloudSyncProvider": "onedrive"
        }"#;

        let config: AppConfig = serde_json::from_str(raw).unwrap();

        assert_eq!(config.auto_save_dir.as_deref(), Some(r"D:\Notes"));
        assert_eq!(config.cloud_sync_provider.as_deref(), Some("onedrive"));
        assert_eq!(config.cloud_sync_source, None);

        let serialized = serde_json::to_value(&config).unwrap();
        assert_eq!(serialized["autoSaveDir"], r"D:\Notes");
        assert_eq!(serialized["cloudSyncProvider"], "onedrive");
        assert!(serialized.get("localAutoSaveDirState").is_none());
    }
}
