import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ── Types (matching Rust serde output) ──

export interface AutoSaveResult {
  filePath: string;
  noteId: string;
  createdAt: number;
  updatedAt: number;
}

export interface LoadedNote {
  noteId: string;
  title: string;
  isTitleManual: boolean;
  plainText: string;
  content: string;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
  filePath: string;
}

export interface ImportedFile {
  title: string;
  content: string;
  filePath: string;
}

export interface AutoSaveDirInfo {
  customDir: string | null;
  effectiveDir: string;
  isDefault: boolean;
}

interface UpdateStatusData {
  status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  version?: string;
  progress?: number;
  error?: string;
}

// ── IPC abstraction layer ──
// Replaces window.hwanNote and window.hwanShell with Tauri invoke() calls.

export const hwanNote = {
  window: {
    minimize: () => invoke("cmd_window_minimize"),
    toggleMaximize: () => invoke<boolean>("cmd_window_toggle_maximize"),
    close: () => invoke("cmd_window_close"),
  },

  note: {
    save: (filePath: string, content: string) =>
      invoke("cmd_note_save", { filePath, content }),

    read: (filePath: string) =>
      invoke<string>("cmd_note_read", { filePath }),

    list: (dirPath: string) =>
      invoke<string[]>("cmd_note_list", { dirPath }),

    autoSave: (
      noteId: string,
      title: string,
      content: string,
      folderPath: string,
      isTitleManual: boolean
    ) =>
      invoke<AutoSaveResult>("cmd_note_auto_save", {
        payload: { noteId, title, content, folderPath, isTitleManual },
      }),

    loadAll: () => invoke<LoadedNote[]>("cmd_note_load_all"),

    importTxt: () =>
      invoke<ImportedFile[] | null>("cmd_note_import_txt"),

    saveTxt: (filePath: string, content: string) =>
      invoke<boolean>("cmd_note_save_txt", { filePath, content }),

    delete: (noteId: string) =>
      invoke<boolean>("cmd_note_delete", { noteId }),
  },

  updater: {
    check: () => invoke("cmd_updater_check"),
    download: () => invoke("cmd_updater_download"),
    install: () => invoke("cmd_updater_install"),
    onStatus: (callback: (data: UpdateStatusData) => void): (() => void) => {
      let unlisten: UnlistenFn | null = null;
      let cancelled = false;

      listen<UpdateStatusData>("updater:status", (event) => {
        callback(event.payload);
      }).then((fn_) => {
        if (cancelled) {
          fn_();
        } else {
          unlisten = fn_;
        }
      });

      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  },

  settings: {
    browseAutoSaveDir: () =>
      invoke<string | null>("cmd_settings_browse_autosave_dir"),

    setAutoSaveDir: (dir: string | null) =>
      invoke<AutoSaveDirInfo>("cmd_settings_set_autosave_dir", { dir }),

    getAutoSaveDir: () =>
      invoke<AutoSaveDirInfo>("cmd_settings_get_autosave_dir"),
  },
};

export const hwanShell = {
  openExternal: (url: string) =>
    invoke("cmd_shell_open_external", { url }),
};
