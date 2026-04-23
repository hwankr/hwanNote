# Note Delete Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A note must not disappear from the sidebar, index, or filesystem unless the user explicitly confirms deletion and the trash operation succeeds.

**Architecture:** Centralize the app-owned delete confirmation in `App.tsx` so every delete entry point has the same guard, and make the Tauri backend resolve the target path before trashing but remove the note from the index only after trash succeeds. This keeps the UI, index, and filesystem consistent when the user cancels either the app dialog, an unsaved-changes dialog, or an OS recycle-bin dialog.

**Tech Stack:** React 18, TypeScript, Tauri v2, Rust, existing `@tauri-apps/plugin-dialog`. No new dependencies.

---

## Investigation Summary

- `src/components/Sidebar.tsx:140-147` currently shows `window.confirm(...)` before calling `onDeleteNote(...)`. If the user cancels this app dialog, the frontend should not call `handleDeleteNote`.
- `src/App.tsx:1626-1648` performs the actual delete flow. It resolves dirty tabs first, then calls `hwanNote.note.delete(id)`, then removes the note from Zustand and calendar links.
- `src-tauri/src/commands.rs:230-240` currently calls `file_manager::remove_note_from_index(...)` before `trash::delete(...)`, and it ignores trash errors. If Windows shows a recycle-bin confirmation or the trash operation fails, the app index can already be changed before the user finishes confirming at the OS layer.
- `src-tauri/src/file_manager.rs:1182-1190` confirms that `remove_note_from_index(...)` mutates and writes the index before returning the file path.

## File Map

**Modify**
- `src/App.tsx` - own the note-delete confirmation, call the existing dirty-tab guard only after delete confirmation, and show an error dialog if backend deletion fails.
- `src/components/Sidebar.tsx` - remove the local `window.confirm` from the context-menu item and delegate delete requests directly to `App.tsx`.
- `src/i18n/messages.ts` - add a localized delete failure message for the backend failure/cancel path.
- `src-tauri/src/file_manager.rs` - add a non-mutating helper that resolves a note's file path from the index without removing the index entry.
- `src-tauri/src/commands.rs` - trash the note file first, propagate trash failures, then remove the index entry only after successful trash or when the file is already missing.

**Not modified**
- `src/lib/tauriApi.ts` - the `hwanNote.note.delete(noteId)` API shape can stay the same.
- `src/stores/noteStore.ts` - `removeNote(id)` should still be called only after the backend confirms deletion.
- `src/components/ContextMenu.tsx` - current event handling is not the primary defect; do not change menu mechanics unless runtime verification proves a separate event-order bug.

---

## Behavior Contract

- Cancel in the app delete confirmation: no backend call, no UI removal, no index mutation.
- Confirm app deletion, then cancel the unsaved-changes dialog: no backend call, no UI removal, no index mutation.
- Confirm app deletion, then cancel/fail the OS trash dialog: backend returns failure, no UI removal, no index mutation.
- Confirm all dialogs and trash succeeds: backend removes the file, then index; frontend removes the note and calendar note links.
- If the indexed file is already missing: backend may remove the stale index entry and return success, preserving the existing cleanup behavior for stale index records.

---

## Task 1: Move App-Owned Delete Confirmation Into `App.tsx`

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/i18n/messages.ts`

- [ ] **Step 1: Import the Tauri confirm dialog**

In `src/App.tsx`, replace the current dialog import:

```ts
import { message } from "@tauri-apps/plugin-dialog";
```

with:

```ts
import { confirm as confirmDialog, message } from "@tauri-apps/plugin-dialog";
```

- [ ] **Step 2: Add a shared delete confirmation helper**

In `src/App.tsx`, place this helper immediately before `handleDeleteNote`:

```ts
  const confirmDeleteNote = useCallback(async (tab: NoteTab) => {
    const title = tab.title.trim() || t("common.untitled");
    return confirmDialog(t("sidebar.noteDeleteConfirm", { title }), {
      title: t("sidebar.noteDelete"),
      kind: "warning"
    });
  }, [t]);
```

- [ ] **Step 3: Gate `handleDeleteNote` before any destructive work**

In `src/App.tsx`, replace `handleDeleteNote` with:

```ts
  const handleDeleteNote = useCallback(async (id: string) => {
    const initialTab = getTabById(id);
    if (!initialTab) {
      return false;
    }

    const confirmed = await confirmDeleteNote(initialTab);
    if (!confirmed) {
      return false;
    }

    return runGuardedFlow(async () => {
      const tab = getTabById(id);
      if (!tab) {
        return false;
      }

      const didResolve = await resolveDirtyTabs([id], { closeResolvedTabs: false });
      if (!didResolve) {
        return false;
      }

      try {
        await hwanNote.note.delete(id);
        removeNote(id);
        useCalendarStore.getState().removeNoteLinks(id);
        return true;
      } catch (error) {
        console.error("Failed to delete note:", error);
        await message(t("sidebar.noteDeleteFailed"), {
          title: t("sidebar.noteDelete"),
          kind: "error"
        });
        return false;
      }
    });
  }, [confirmDeleteNote, getTabById, removeNote, resolveDirtyTabs, runGuardedFlow, t]);
```

- [ ] **Step 4: Remove the sidebar-local confirm**

In `src/components/Sidebar.tsx`, replace the delete menu item block:

```ts
    items.push({
      key: "delete",
      label: tt("sidebar.noteDelete"),
      danger: true,
      onClick: () => {
        setNoteMenu(null);
        const confirmed = window.confirm(
          tt("sidebar.noteDeleteConfirm", { title: noteMenuTarget.title })
        );
        if (confirmed) {
          onDeleteNote(noteMenu.noteId);
        }
      }
    });
```

with:

```ts
    items.push({
      key: "delete",
      label: tt("sidebar.noteDelete"),
      danger: true,
      onClick: () => {
        const noteId = noteMenu.noteId;
        setNoteMenu(null);
        onDeleteNote(noteId);
      }
    });
```

- [ ] **Step 5: Add delete-failure i18n strings**

In `src/i18n/messages.ts`, add this key near `sidebar.noteDeleteConfirm` in the Korean block:

```ts
    "sidebar.noteDeleteFailed": "메모를 삭제하지 못했습니다. 메모가 목록에 남아 있으면 다시 시도해 주세요.",
```

Add the matching English key:

```ts
    "sidebar.noteDeleteFailed": "The note could not be deleted. If it remains in the list, try again.",
```

- [ ] **Step 6: Typecheck the frontend**

Run:

```powershell
npm run typecheck
```

Expected: `tsc --noEmit` exits with code 0.

- [ ] **Step 7: Commit the frontend guard change**

Run:

```powershell
git add src/App.tsx src/components/Sidebar.tsx src/i18n/messages.ts
git commit -m @'
Prevent note deletion before app confirmation

Delete requests now pass through one app-owned confirmation path before dirty-tab resolution or backend deletion starts.

Constraint: No new dependencies; reuse the existing Tauri dialog plugin.
Rejected: Keep confirmation inside Sidebar | deletion safety belongs at the destructive action boundary.
Confidence: medium
Scope-risk: narrow
Tested: npm run typecheck
Not-tested: Runtime Windows recycle-bin confirmation path
'@
```

---

## Task 2: Make Backend Delete Order Transactional Enough

**Files:**
- Modify: `src-tauri/src/file_manager.rs`
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Add a non-mutating note path resolver**

In `src-tauri/src/file_manager.rs`, add this helper immediately before `remove_note_from_index(...)`:

```rust
pub fn resolve_note_file_path(
    auto_save_dir: &Path,
    note_id: &str,
) -> Result<Option<PathBuf>, String> {
    let safe_id = sanitize_note_id(note_id);
    if safe_id.is_empty() {
        return Ok(None);
    }

    let index = read_index(auto_save_dir);
    let entry = match index.entries.get(&safe_id) {
        Some(e) => e,
        None => return Ok(None),
    };

    Ok(Some(auto_save_dir.join(&entry.relative_path)))
}
```

- [ ] **Step 2: Reorder `cmd_note_delete`**

In `src-tauri/src/commands.rs`, replace `cmd_note_delete(...)` with:

```rust
#[tauri::command]
pub async fn cmd_note_delete(app: AppHandle, note_id: String) -> Result<bool, String> {
    let effective_dir = resolve_effective_dir(&app);
    let file_path = match file_manager::resolve_note_file_path(&effective_dir, &note_id)? {
        Some(p) => p,
        None => return Ok(false),
    };

    if file_path.exists() {
        let trash_result = tauri::async_runtime::spawn_blocking({
            let file_path = file_path.clone();
            move || trash::delete(&file_path).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;

        trash_result?;
    }

    let removed = file_manager::remove_note_from_index(&effective_dir, &note_id)?;
    Ok(removed.is_some())
}
```

This preserves the stale-index cleanup path when the file is already missing, but it no longer mutates the index before a real file-trash attempt succeeds.

- [ ] **Step 3: Add a file-manager regression test for path resolution**

In the existing `#[cfg(test)]` module in `src-tauri/src/file_manager.rs`, add this test near the other note index tests:

```rust
#[test]
fn resolve_note_file_path_does_not_remove_index_entry() {
    let dir = make_temp_dir("resolve-note-path");
    let result = (|| -> Result<(), String> {
        auto_save_markdown_note(
            &dir,
            &AutoSavePayload {
                note_id: "note-1".to_string(),
                title: "Alpha".to_string(),
                content: "# Alpha".to_string(),
                folder_path: None,
                is_title_manual: Some(true),
            },
        )?;

        let path = resolve_note_file_path(&dir, "note-1")?
            .ok_or_else(|| "missing note path".to_string())?;
        assert!(path.exists());

        let index = read_index(&dir);
        assert!(index.entries.contains_key("note-1"));

        Ok(())
    })();
    cleanup_temp_dir(&dir);
    result.unwrap();
}
```

- [ ] **Step 4: Run backend tests**

Run:

```powershell
Push-Location src-tauri
cargo test resolve_note_file_path_does_not_remove_index_entry
Pop-Location
```

Expected: the new Rust test passes.

- [ ] **Step 5: Run full Rust tests**

Run:

```powershell
Push-Location src-tauri
cargo test
Pop-Location
```

Expected: all Rust tests pass.

- [ ] **Step 6: Commit the backend ordering change**

Run:

```powershell
git add src-tauri/src/file_manager.rs src-tauri/src/commands.rs
git commit -m @'
Preserve note index until trash succeeds

The delete command now resolves the indexed file path without mutating the index, attempts the trash operation, and only then removes the index entry.

Constraint: Windows may show a recycle-bin confirmation outside the React confirmation flow.
Rejected: Ignore trash errors after index removal | this can make notes disappear when the user cancels the OS dialog.
Confidence: medium
Scope-risk: narrow
Directive: Do not move index removal before trash success without testing OS cancel/failure behavior.
Tested: cargo test
Not-tested: Manual Windows recycle-bin cancel path
'@
```

---

## Task 3: End-to-End Verification

**Files:**
- Verify only: `src/App.tsx`
- Verify only: `src/components/Sidebar.tsx`
- Verify only: `src-tauri/src/commands.rs`
- Verify only: `src-tauri/src/file_manager.rs`

- [ ] **Step 1: Run frontend typecheck**

Run:

```powershell
npm run typecheck
```

Expected: `tsc --noEmit` exits with code 0.

- [ ] **Step 2: Run Rust tests**

Run:

```powershell
Push-Location src-tauri
cargo test
Pop-Location
```

Expected: all Rust tests pass.

- [ ] **Step 3: Build the frontend**

Run:

```powershell
npm run build:frontend
```

Expected: Vite completes without errors.

- [ ] **Step 4: Manual app confirmation cancel test**

Run the app, create a note, right-click it in the note list, click `삭제`, then cancel the app delete confirmation.

Expected:
- The note remains visible in the sidebar.
- The note can still be opened.
- Restarting the app still shows the note.

- [ ] **Step 5: Manual dirty-note cancel test**

Edit a note without saving, right-click it in the note list, click `삭제`, confirm the delete dialog, then cancel the unsaved-changes dialog.

Expected:
- The note remains visible in the sidebar.
- The note remains dirty/open.
- No file is moved to the recycle bin.

- [ ] **Step 6: Manual OS recycle-bin cancel test**

On Windows, enable the recycle-bin delete confirmation setting if available. Right-click a saved note, click `삭제`, confirm the app delete dialog, then cancel the OS recycle-bin confirmation.

Expected:
- The note remains visible in the sidebar.
- Restarting the app still shows the note.
- The note file remains at its original location.

- [ ] **Step 7: Manual successful delete test**

Right-click a saved note, click `삭제`, confirm all dialogs.

Expected:
- The note disappears from the sidebar.
- Restarting the app does not restore the note.
- The note file is moved to the recycle bin.
- Linked calendar note references for that note are removed.

- [ ] **Step 8: Final commit if manual fixes were needed**

If verification required any follow-up changes, commit them using the Lore protocol:

```powershell
git add <changed-files>
git commit -m @'
Complete note delete confirmation fix

Follow-up verification changes from manual delete-path testing.

Confidence: medium
Scope-risk: narrow
Tested: npm run typecheck; cargo test; npm run build:frontend; manual delete cancel and success paths
Not-tested: <remaining gap, or none>
'@
```

---

## Self-Review

- Spec coverage: The plan covers the reported note-list right-click delete path, app confirmation cancel, dirty-note cancel, OS trash cancel/failure, successful delete, UI removal, index mutation, and calendar link cleanup.
- Placeholder scan: No placeholder implementation steps are required; the only `<changed-files>` and `<remaining gap, or none>` placeholders are explicitly confined to the optional follow-up commit command.
- Type consistency: `confirmDeleteNote(tab: NoteTab)`, `resolve_note_file_path(...)`, and `cmd_note_delete(...)` signatures match existing project types and call sites.
- Remaining risk: The exact error returned by `trash::delete` on Windows OS-dialog cancel should be verified manually; the planned backend behavior treats any trash error as a non-delete result by preserving the index and returning an error to the frontend.
