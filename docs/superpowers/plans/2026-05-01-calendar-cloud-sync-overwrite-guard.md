# Calendar Cloud Sync Overwrite Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an empty fallback-loaded `calendar.json` from overwriting the real cloud `calendar.json` when Google Drive or another cloud folder becomes available after app startup.

**Architecture:** Make calendar load/save source-aware. The backend reports whether calendar data came from local storage, cloud storage, or a local fallback used because cloud storage was unavailable; saves include the source that was loaded and are rejected if the current resolved source has drifted. Cloud enable also migrates `calendar.json` safely by copying local calendar data only when the cloud calendar file does not already exist.

**Tech Stack:** Tauri 2, Rust commands, React, TypeScript, Zustand.

---

## Confirmed Failure Path

- `src-tauri/src/commands.rs:103-128` resolves the effective directory. If cloud sync is configured but the cloud folder is missing, it falls back to the local note directory without changing the configured active source.
- `src-tauri/src/commands.rs:244-261` loads `calendar.json` from that resolved directory and returns an empty string when the file is missing.
- `src/stores/calendarStore.ts:134-142` parses an empty string into `createEmptyCalendarData()` and marks `loaded: true`.
- `src/App.tsx:1613` saves calendar data on window close without checking where it was loaded from.
- `src-tauri/src/commands.rs:265-286` saves to the currently resolved directory. If Google Drive has appeared by then, the same in-memory empty calendar is written to cloud storage.
- `src-tauri/src/file_manager.rs:1363-1469` migrates only markdown notes and the note index. `calendar.json` is not part of cloud-enable migration, so an existing cloud calendar is not loaded or protected during enable.

## File Structure

- Modify `src-tauri/src/file_manager.rs`
  - Add a pure `migrate_calendar_file(src_dir, dst_dir)` helper.
  - Add unit tests proving destination calendar preservation and missing-destination copy behavior.
- Modify `src-tauri/src/commands.rs`
  - Add calendar load/save payload structs.
  - Add storage-source-aware calendar resolution.
  - Reject calendar saves when a fallback-loaded calendar would now be saved into cloud storage.
  - Call `migrate_calendar_file` during cloud enable.
- Modify `src/lib/tauriApi.ts`
  - Change the calendar API wrapper from raw string load/save to typed load/save payloads.
- Modify `src/stores/calendarStore.ts`
  - Track `loadedFrom` and `cloudUnavailable` along with `loaded`.
  - Pass `loadedFrom` into saves.
  - Keep dirty saves queued or blocked when backend refuses a source-drift save.
- Modify `src/App.tsx`
  - Reload calendar data after cloud provider/source changes.
  - Avoid saving fallback-loaded calendar data to cloud during close.

---

### Task 1: Add Calendar File Migration Tests

**Files:**
- Modify: `src-tauri/src/file_manager.rs`
- Test: `src-tauri/src/file_manager.rs`

- [ ] **Step 1: Write failing tests for safe calendar migration**

Add these tests inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/file_manager.rs`:

```rust
#[test]
fn migrate_calendar_file_copies_when_destination_is_missing() {
    let src = make_temp_dir("calendar-migrate-src");
    let dst = make_temp_dir("calendar-migrate-dst");
    let result = (|| -> Result<(), String> {
        fs::write(
            src.join("calendar.json"),
            r#"{"version":4,"todos":{"2026-05-01":{"items":[]}},"inbox":[],"noteLinks":{}}"#,
        )
        .unwrap();

        let copied = migrate_calendar_file(&src, &dst)?;

        assert!(copied);
        let dst_calendar = fs::read_to_string(dst.join("calendar.json")).unwrap();
        assert!(dst_calendar.contains("2026-05-01"));
        Ok(())
    })();
    cleanup_temp_dir(&src);
    cleanup_temp_dir(&dst);
    result.unwrap();
}

#[test]
fn migrate_calendar_file_preserves_existing_destination_calendar() {
    let src = make_temp_dir("calendar-migrate-src-existing");
    let dst = make_temp_dir("calendar-migrate-dst-existing");
    let result = (|| -> Result<(), String> {
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("calendar.json"), r#"{"version":4,"todos":{"local":{"items":[]}},"inbox":[],"noteLinks":{}}"#)
            .unwrap();
        fs::write(dst.join("calendar.json"), r#"{"version":4,"todos":{"cloud":{"items":[]}},"inbox":[],"noteLinks":{}}"#)
            .unwrap();

        let copied = migrate_calendar_file(&src, &dst)?;

        assert!(!copied);
        let dst_calendar = fs::read_to_string(dst.join("calendar.json")).unwrap();
        assert!(dst_calendar.contains("cloud"));
        assert!(!dst_calendar.contains("local"));
        Ok(())
    })();
    cleanup_temp_dir(&src);
    cleanup_temp_dir(&dst);
    result.unwrap();
}
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```powershell
cd src-tauri
cargo test migrate_calendar_file --lib
```

Expected: fail with `cannot find function migrate_calendar_file in this scope`.

- [ ] **Step 3: Implement the migration helper**

Add near `migrate_notes` in `src-tauri/src/file_manager.rs`:

```rust
const CALENDAR_FILENAME: &str = "calendar.json";

pub fn migrate_calendar_file(src_dir: &Path, dst_dir: &Path) -> Result<bool, String> {
    let src_path = src_dir.join(CALENDAR_FILENAME);
    let dst_path = dst_dir.join(CALENDAR_FILENAME);

    if !src_path.exists() || dst_path.exists() {
        return Ok(false);
    }

    fs::create_dir_all(dst_dir).map_err(|e| format!("Failed to create destination: {}", e))?;
    fs::copy(&src_path, &dst_path)
        .map_err(|e| format!("Failed to copy calendar.json: {}", e))?;
    Ok(true)
}
```

- [ ] **Step 4: Run tests and confirm they pass**

Run:

```powershell
cd src-tauri
cargo test migrate_calendar_file --lib
```

Expected: both tests pass.

---

### Task 2: Migrate Calendar During Cloud Enable Without Overwriting Cloud

**Files:**
- Modify: `src-tauri/src/commands.rs:74-83`
- Modify: `src-tauri/src/commands.rs:747-760`
- Test: `src-tauri/src/file_manager.rs`

- [ ] **Step 1: Extend the backend cloud sync result**

Change `CloudSyncResult` in `src-tauri/src/commands.rs`:

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    provider: Option<String>,
    files_copied: u32,
    calendar_copied: bool,
    active_source: String,
}
```

- [ ] **Step 2: Call calendar migration when enabling cloud sync**

Replace the `let migration_result = if copy_existing { ... } else { ... };` block in `cmd_cloud_sync_enable` with:

```rust
let (migration_result, calendar_copied) = if copy_existing {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let src = config_manager::get_local_auto_save_dir(&app, &file_manager::get_auto_save_dir(&documents));
    let dst = cloud_notes_dir.clone();
    let calendar_src = src.clone();
    let calendar_dst = dst.clone();

    let notes_result = tauri::async_runtime::spawn_blocking(move || file_manager::migrate_notes(&src, &dst))
        .await
        .map_err(|e| e.to_string())??;
    let calendar_copied = tauri::async_runtime::spawn_blocking(move || {
        file_manager::migrate_calendar_file(&calendar_src, &calendar_dst)
    })
    .await
    .map_err(|e| e.to_string())??;

    (notes_result, calendar_copied)
} else {
    (
        file_manager::MigrationResult {
            files_copied: 0,
            index_copied: false,
        },
        false,
    )
};
```

Update every `CloudSyncResult` constructor:

```rust
Ok(CloudSyncResult {
    provider: Some(provider),
    files_copied: migration_result.files_copied,
    calendar_copied,
    active_source: library_source_to_str(LibrarySource::Cloud).to_string(),
})
```

For disable:

```rust
Ok(CloudSyncResult {
    provider: None,
    files_copied: 0,
    calendar_copied: false,
    active_source: library_source_to_str(LibrarySource::Local).to_string(),
})
```

- [ ] **Step 3: Update frontend type**

Change `CloudSyncResult` in `src/lib/tauriApi.ts`:

```ts
export interface CloudSyncResult {
  provider: string | null;
  filesCopied: number;
  calendarCopied: boolean;
  activeSource: CloudSyncSource;
}
```

- [ ] **Step 4: Run backend and frontend checks**

Run:

```powershell
npm run typecheck
cd src-tauri
cargo test migrate_calendar_file --lib
cargo check
```

Expected: all commands pass.

---

### Task 3: Make Calendar Load and Save Source-Aware

**Files:**
- Modify: `src-tauri/src/commands.rs:85-99`
- Modify: `src-tauri/src/commands.rs:103-128`
- Modify: `src-tauri/src/commands.rs:239-286`
- Modify: `src/lib/tauriApi.ts:194-209`
- Modify: `src/stores/calendarStore.ts:17-35`

- [ ] **Step 1: Add source-aware payload types in Rust**

Add near `CloudSyncStatus` in `src-tauri/src/commands.rs`:

```rust
#[derive(Clone, Copy, PartialEq, Eq)]
enum ResolvedStorageSource {
    Local,
    Cloud,
    LocalFallback,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLoadResult {
    data: String,
    loaded_from: String,
    cloud_unavailable: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSavePayload {
    data: String,
    loaded_from: String,
}
```

Add helpers near `library_source_to_str`:

```rust
fn resolved_storage_source_to_str(source: ResolvedStorageSource) -> &'static str {
    match source {
        ResolvedStorageSource::Local => "local",
        ResolvedStorageSource::Cloud => "cloud",
        ResolvedStorageSource::LocalFallback => "local_fallback",
    }
}

fn parse_resolved_storage_source(source: &str) -> Option<ResolvedStorageSource> {
    match source {
        "local" => Some(ResolvedStorageSource::Local),
        "cloud" => Some(ResolvedStorageSource::Cloud),
        "local_fallback" => Some(ResolvedStorageSource::LocalFallback),
        _ => None,
    }
}

fn can_save_calendar(loaded_from: ResolvedStorageSource, current: ResolvedStorageSource) -> bool {
    loaded_from == current
}
```

- [ ] **Step 2: Add tests for save source drift**

Add a small test module in `src-tauri/src/commands.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::{can_save_calendar, ResolvedStorageSource};

    #[test]
    fn calendar_save_rejects_local_fallback_loaded_data_when_cloud_is_current() {
        assert!(!can_save_calendar(
            ResolvedStorageSource::LocalFallback,
            ResolvedStorageSource::Cloud
        ));
    }

    #[test]
    fn calendar_save_allows_same_resolved_source() {
        assert!(can_save_calendar(
            ResolvedStorageSource::Cloud,
            ResolvedStorageSource::Cloud
        ));
        assert!(can_save_calendar(
            ResolvedStorageSource::LocalFallback,
            ResolvedStorageSource::LocalFallback
        ));
    }
}
```

- [ ] **Step 3: Replace directory resolver with source-aware resolver**

Keep `resolve_effective_dir` for notes, and add this helper in `src-tauri/src/commands.rs`:

```rust
fn resolve_calendar_dir(app: &AppHandle) -> (PathBuf, ResolvedStorageSource) {
    let documents = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    let local_dir = config_manager::get_local_auto_save_dir(app, &file_manager::get_auto_save_dir(&documents));
    let provider = config_manager::get_cloud_sync_provider(app);
    let active_source = config_manager::get_cloud_sync_source(app);

    if provider.is_some() && active_source == LibrarySource::Cloud {
        if let Some(cloud_dir) = config_manager::get_cloud_notes_dir(app) {
            if cloud_dir.exists() {
                return (cloud_dir, ResolvedStorageSource::Cloud);
            }
            return (local_dir, ResolvedStorageSource::LocalFallback);
        }
    }

    (local_dir, ResolvedStorageSource::Local)
}
```

- [ ] **Step 4: Change calendar load command**

Replace `cmd_calendar_load` with:

```rust
#[tauri::command]
pub fn cmd_calendar_load(app: AppHandle) -> Result<CalendarLoadResult, String> {
    let (dir, loaded_from) = resolve_calendar_dir(&app);
    let path = dir.join(CALENDAR_FILE);

    let data = if !path.exists() {
        String::new()
    } else {
        match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(e) => {
                tracing::error!("Failed to read calendar.json: {}", e);
                let bak = dir.join("calendar.json.bak");
                let _ = fs::copy(&path, &bak);
                String::new()
            }
        }
    };

    Ok(CalendarLoadResult {
        data,
        loaded_from: resolved_storage_source_to_str(loaded_from).to_string(),
        cloud_unavailable: loaded_from == ResolvedStorageSource::LocalFallback,
    })
}
```

- [ ] **Step 5: Change calendar save command**

Replace `cmd_calendar_save` with:

```rust
#[tauri::command]
pub fn cmd_calendar_save(app: AppHandle, payload: CalendarSavePayload) -> Result<(), String> {
    let loaded_from = parse_resolved_storage_source(&payload.loaded_from)
        .ok_or_else(|| "Invalid calendar storage source.".to_string())?;
    let (dir, current_source) = resolve_calendar_dir(&app);

    if !can_save_calendar(loaded_from, current_source) {
        return Err(format!(
            "Calendar storage source changed from {} to {}; reload before saving.",
            resolved_storage_source_to_str(loaded_from),
            resolved_storage_source_to_str(current_source)
        ));
    }

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }

    let path = dir.join(CALENDAR_FILE);
    let tmp_path = dir.join(".calendar.json.tmp");

    fs::write(&tmp_path, payload.data.as_bytes()).map_err(|e| {
        tracing::error!("Failed to write calendar temp file: {}", e);
        e.to_string()
    })?;

    fs::rename(&tmp_path, &path).map_err(|e| {
        tracing::error!("Failed to rename calendar temp file: {}", e);
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })?;

    Ok(())
}
```

- [ ] **Step 6: Update TypeScript API types**

Change `src/lib/tauriApi.ts`:

```ts
export type CalendarStorageSource = "local" | "cloud" | "local_fallback";

export interface CalendarLoadResult {
  data: string;
  loadedFrom: CalendarStorageSource;
  cloudUnavailable: boolean;
}
```

Change calendar wrappers:

```ts
calendar: {
  load: () =>
    invoke<CalendarLoadResult>("cmd_calendar_load"),

  save: (data: string, loadedFrom: CalendarStorageSource) =>
    invoke("cmd_calendar_save", { payload: { data, loadedFrom } }),
},
```

- [ ] **Step 7: Track loaded source in calendar store**

Change imports in `src/stores/calendarStore.ts`:

```ts
import { hwanNote, type CalendarStorageSource } from "../lib/tauriApi";
```

Extend `CalendarStore`:

```ts
loadedFrom: CalendarStorageSource;
cloudUnavailable: boolean;
```

Change initial state:

```ts
loadedFrom: "local",
cloudUnavailable: false,
```

Change `executeSave`:

```ts
const json = serializeCalendarData(state.data);
await hwanNote.calendar.save(json, state.loadedFrom);
```

Change `loadCalendarData`:

```ts
const result = await hwanNote.calendar.load();
const data = parseCalendarData(result.data);
set({
  data,
  loaded: true,
  loadedFrom: result.loadedFrom,
  cloudUnavailable: result.cloudUnavailable,
});
```

Change the catch branch:

```ts
set({
  data: createEmptyCalendarData(),
  loaded: true,
  loadedFrom: "local",
  cloudUnavailable: false,
});
```

- [ ] **Step 8: Run checks**

Run:

```powershell
npm run typecheck
cd src-tauri
cargo test calendar_save --lib
cargo check
```

Expected: TypeScript compiles, Rust tests pass, and Tauri commands compile.

---

### Task 4: Reload Calendar on Cloud Provider and Source Changes

**Files:**
- Modify: `src/App.tsx:1711-1744`
- Modify: `src/App.tsx:1605-1617`

- [ ] **Step 1: Reload calendar after cloud provider changes**

In `handleCloudSyncChange`, after `await loadLibraryState();`, insert:

```ts
await useCalendarStore.getState().loadCalendarData();
useCalendarStore.getState().cleanOrphanNoteLinks();
```

The final block should read:

```ts
await refreshLocalAutoSaveDir();
await loadLibraryState();
await useCalendarStore.getState().loadCalendarData();
useCalendarStore.getState().cleanOrphanNoteLinks();
await refreshCloudSyncState();
```

- [ ] **Step 2: Reload calendar after switching local/cloud source**

In `handleCloudSyncSourceChange`, after `await loadLibraryState();`, insert:

```ts
await useCalendarStore.getState().loadCalendarData();
useCalendarStore.getState().cleanOrphanNoteLinks();
```

The final block should read:

```ts
await hwanNote.cloud.setActiveSource(source);
await loadLibraryState();
await useCalendarStore.getState().loadCalendarData();
useCalendarStore.getState().cleanOrphanNoteLinks();
await refreshCloudSyncState();
```

- [ ] **Step 3: Make close-time save tolerate protected source drift**

In `handleRequestCloseWindow`, wrap calendar save with a catch that does not write fallback data into cloud:

```ts
try {
  await useCalendarStore.getState().saveCalendarData();
} catch (error) {
  console.error("Failed to save calendar data before exit:", error);
}
await hwanNote.window.exit();
```

If `saveCalendarData` currently swallows errors in `executeSave`, change `executeSave` so it logs and rethrows:

```ts
} catch (error) {
  console.error("Failed to save calendar data:", error);
  throw error;
}
```

- [ ] **Step 4: Run checks**

Run:

```powershell
npm run typecheck
cd src-tauri
cargo check
```

Expected: both commands pass.

---

### Task 5: Manual Regression Scenario

**Files:**
- No file edits

- [ ] **Step 1: Prepare a cloud calendar with visible data**

Create or keep a cloud file at:

```text
<Google Drive>\HwanNote\Notes\calendar.json
```

Use this content:

```json
{
  "version": 4,
  "todos": {
    "2026-05-01": {
      "items": [
        {
          "id": "todo-cloud-regression",
          "text": "cloud calendar must survive startup fallback",
          "done": false,
          "createdAt": 1777550400000,
          "updatedAt": 1777550400000,
          "dueDateKey": null,
          "completedAt": null
        }
      ]
    }
  },
  "inbox": [],
  "noteLinks": {}
}
```

- [ ] **Step 2: Simulate Drive missing at app startup**

Temporarily make the configured cloud folder unavailable by stopping Google Drive Desktop or renaming the provider root outside the app.

- [ ] **Step 3: Start hwanNote and open Calendar**

Expected: the app may show local fallback data, but it must not save fallback data to cloud.

- [ ] **Step 4: Restore Drive availability and close hwanNote**

Expected: the existing cloud `calendar.json` still contains `todo-cloud-regression`.

- [ ] **Step 5: Restart hwanNote with Drive available**

Expected: the calendar shows `cloud calendar must survive startup fallback`.

---

### Task 6: Final Verification

**Files:**
- No file edits

- [ ] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
cd src-tauri
cargo test --lib
cargo check
```

Expected: all commands pass.

- [ ] **Step 2: Review diff for scope**

Run:

```powershell
git diff -- src-tauri/src/file_manager.rs src-tauri/src/commands.rs src/lib/tauriApi.ts src/stores/calendarStore.ts src/App.tsx
```

Expected: diff is limited to calendar sync protection, safe calendar migration, and reload flow.

## Self-Review

- Spec coverage: the plan covers the startup fallback overwrite path, existing cloud calendar preservation, cloud enable migration, and source-switch reload.
- Placeholder scan: no implementation step relies on open-ended placeholders.
- Type consistency: `CalendarStorageSource` values are `"local"`, `"cloud"`, and `"local_fallback"` in both Rust and TypeScript; save payload uses `loadedFrom` in TypeScript and `loaded_from` in Rust via serde camelCase.
