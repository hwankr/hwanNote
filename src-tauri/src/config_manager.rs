use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_save_dir: Option<String>,
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

pub fn get_custom_auto_save_dir(app: &AppHandle) -> Option<String> {
    let config = read_config(app);
    let dir = config.auto_save_dir?;
    if dir.is_empty() {
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

pub fn get_effective_auto_save_dir(app: &AppHandle, default_dir: &Path) -> PathBuf {
    match get_custom_auto_save_dir(app) {
        Some(custom) => PathBuf::from(custom),
        None => default_dir.to_path_buf(),
    }
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
