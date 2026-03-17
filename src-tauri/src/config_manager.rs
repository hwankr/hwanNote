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

fn get_cloud_notes_dir_for_provider(provider: &str) -> Option<PathBuf> {
    get_cloud_provider_root(provider).map(|root| PathBuf::from(root).join("HwanNote").join("Notes"))
}

fn is_cloud_notes_dir_for_provider(provider: &str, dir: &str) -> bool {
    get_cloud_notes_dir_for_provider(provider)
        .map(|cloud_dir| normalize_path_for_compare(cloud_dir.to_string_lossy().as_ref()) == normalize_path_for_compare(dir))
        .unwrap_or(false)
}

pub fn get_custom_auto_save_dir(app: &AppHandle) -> Option<String> {
    let config = read_config(app);
    let dir = config.auto_save_dir?;
    if dir.is_empty() {
        return None;
    }
    if config
        .cloud_sync_provider
        .as_deref()
        .is_some_and(|provider| is_cloud_notes_dir_for_provider(provider, &dir))
    {
        return None;
    }
    if Path::new(&dir).exists() {
        Some(dir)
    } else {
        None
    }
}

pub fn set_custom_auto_save_dir(app: &AppHandle, dir: Option<&str>) -> Result<(), String> {
    if let Some(d) = dir {
        let path = Path::new(d);
        if !path.is_absolute() {
            return Err("Path must be absolute".to_string());
        }
        if !path.exists() {
            return Err("Directory does not exist".to_string());
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
        let matches_next_cloud_path = provider
            .is_some_and(|next| is_cloud_notes_dir_for_provider(next, &existing_dir));
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

pub fn get_local_auto_save_dir(app: &AppHandle, default_dir: &Path) -> PathBuf {
    match get_custom_auto_save_dir(app) {
        Some(custom) => PathBuf::from(custom),
        None => default_dir.to_path_buf(),
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

    // Modern "Google Drive Desktop" (DriveFS): virtual drive letter (e.g. G:\내 드라이브)
    // Only scan drive letters when DriveFS installation is confirmed
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
pub fn migrate_legacy_electron_config(app: &AppHandle) -> Result<(), String> {
    let tauri_config_path = get_config_path(app);

    // If Tauri config already exists, skip migration
    if tauri_config_path.exists() {
        return Ok(());
    }

    if let Some(appdata) = std::env::var_os("APPDATA") {
        let legacy_path = PathBuf::from(appdata)
            .join("hwan-note")
            .join("config.json");

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
