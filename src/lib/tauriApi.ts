import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// -- Types (matching Rust serde output) --

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

export interface CloudProviderInfo {
  id: string;
  name: string;
  available: boolean;
  syncFolder: string | null;
}

export type CloudSyncSource = "local" | "cloud";

export interface CloudSyncResult {
  provider: string | null;
  filesCopied: number;
  activeSource: CloudSyncSource;
}

export interface CloudSyncStatus {
  enabled: boolean;
  provider: string | null;
  syncFolder: string | null;
  activeSource: CloudSyncSource;
}

export interface CloudFolderMissingData {
  expectedPath: string;
  fallbackPath: string;
}

export interface FolderDeleteResult {
  folders: string[];
  movedNoteIds: string[];
}

// -- IPC abstraction layer --
// Replaces window.hwanNote and window.hwanShell with Tauri invoke() calls.

function wrapListener<T>(eventName: string, callback: (payload: T) => void): (() => void) {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  listen<T>(eventName, (event) => {
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
}

export const hwanNote = {
  window: {
    minimize: () => invoke("cmd_window_minimize"),
    toggleMaximize: () => invoke<boolean>("cmd_window_toggle_maximize"),
    close: () => invoke("cmd_window_close"),
    exit: () => invoke("cmd_app_exit"),
    startDragging: () => getCurrentWindow().startDragging(),
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

    readExternalTxt: (filePath: string) =>
      invoke<ImportedFile>("cmd_note_read_external_txt", { filePath }),

    drainOpenIntents: () =>
      invoke<string[]>("cmd_note_drain_open_intents"),

    onOpenIntent: (callback: (filePath: string) => void): (() => void) =>
      wrapListener<string>("note:open-intent", callback),

    pickSavePath: (
      dialogTitle: string,
      defaultFileName: string,
      extension: "md" | "txt"
    ) =>
      invoke<string | null>("cmd_note_pick_save_path", {
        dialogTitle,
        defaultFileName,
        extension,
      }),

    saveTxt: (filePath: string, content: string) =>
      invoke<boolean>("cmd_note_save_txt", { filePath, content }),

    delete: (noteId: string) =>
      invoke<boolean>("cmd_note_delete", { noteId }),
  },

  folder: {
    list: () =>
      invoke<string[]>("cmd_folder_list"),

    create: (folderPath: string) =>
      invoke<string[]>("cmd_folder_create", { folderPath }),

    rename: (from: string, to: string) =>
      invoke<string[]>("cmd_folder_rename", { from, to }),

    delete: (folderPath: string) =>
      invoke<FolderDeleteResult>("cmd_folder_delete", { folderPath }),
  },

  updater: {
    check: () => invoke("cmd_updater_check"),
    download: () => invoke("cmd_updater_download"),
    install: () => invoke("cmd_updater_install"),
    onStatus: (callback: (data: UpdateStatusData) => void): (() => void) =>
      wrapListener<UpdateStatusData>("updater:status", callback),
  },

  settings: {
    browseAutoSaveDir: () =>
      invoke<string | null>("cmd_settings_browse_autosave_dir"),

    setAutoSaveDir: (dir: string | null) =>
      invoke<AutoSaveDirInfo>("cmd_settings_set_autosave_dir", { dir }),

    getAutoSaveDir: () =>
      invoke<AutoSaveDirInfo>("cmd_settings_get_autosave_dir"),
  },

  calendar: {
    load: () =>
      invoke<string>("cmd_calendar_load"),

    save: (data: string) =>
      invoke("cmd_calendar_save", { data }),
  },

  cloud: {
    detectProviders: () =>
      invoke<CloudProviderInfo[]>("cmd_cloud_detect_providers"),

    enable: (provider: string, copyExisting: boolean) =>
      invoke<CloudSyncResult>("cmd_cloud_sync_enable", { provider, copyExisting }),

    disable: () =>
      invoke<CloudSyncResult>("cmd_cloud_sync_disable"),

    status: () =>
      invoke<CloudSyncStatus>("cmd_cloud_sync_status"),

    setActiveSource: (source: CloudSyncSource) =>
      invoke<CloudSyncStatus>("cmd_cloud_sync_set_active_source", { source }),

    onFolderMissing: (callback: (data: CloudFolderMissingData) => void): (() => void) =>
      wrapListener<CloudFolderMissingData>("cloud:folder-missing", callback),
  },
};

export const hwanShell = {
  openExternal: (url: string) =>
    invoke("cmd_shell_open_external", { url }),
};
