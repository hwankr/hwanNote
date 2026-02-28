import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const api = {
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize") as Promise<boolean>,
    close: () => ipcRenderer.invoke("window:close")
  },
  note: {
    save: (filePath: string, content: string) => ipcRenderer.invoke("note:save", filePath, content),
    read: (filePath: string) => ipcRenderer.invoke("note:read", filePath) as Promise<string>,
    list: (dirPath: string) => ipcRenderer.invoke("note:list", dirPath) as Promise<string[]>,
    autoSave: (noteId: string, title: string, content: string, folderPath: string, isTitleManual: boolean) =>
      ipcRenderer.invoke("note:auto-save", { noteId, title, content, folderPath, isTitleManual }) as Promise<{
        filePath: string;
      }>,
    loadAll: () =>
      ipcRenderer.invoke("note:load-all") as Promise<
        Array<{
          noteId: string;
          title: string;
          isTitleManual: boolean;
          plainText: string;
          content: string;
          folderPath: string;
          createdAt: number;
          updatedAt: number;
          filePath: string;
        }>
      >,
    importTxt: () =>
      ipcRenderer.invoke("note:import-txt") as Promise<
        Array<{ title: string; content: string; filePath: string }> | null
      >,
    saveTxt: (filePath: string, content: string) =>
      ipcRenderer.invoke("note:save-txt", filePath, content) as Promise<boolean>,
    delete: (noteId: string) =>
      ipcRenderer.invoke("note:delete", noteId) as Promise<boolean>
  },
  updater: {
    download: () => ipcRenderer.invoke("updater:download"),
    install: () => ipcRenderer.invoke("updater:install"),
    onStatus: (callback: (data: { status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"; version?: string; progress?: number; error?: string }) => void) => {
      const handler = (_event: IpcRendererEvent, data: { status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"; version?: string; progress?: number; error?: string }) => callback(data);
      ipcRenderer.on("updater:status", handler);
      return () => { ipcRenderer.removeListener("updater:status", handler); };
    }
  },
  settings: {
    browseAutoSaveDir: () => ipcRenderer.invoke("settings:browse-autosave-dir") as Promise<string | null>,
    setAutoSaveDir: (dir: string | null) =>
      ipcRenderer.invoke("settings:set-autosave-dir", dir) as Promise<{
        customDir: string | null;
        effectiveDir: string;
        isDefault: boolean;
      }>,
    getAutoSaveDir: () =>
      ipcRenderer.invoke("settings:get-autosave-dir") as Promise<{
        customDir: string | null;
        effectiveDir: string;
        isDefault: boolean;
      }>
  }
};

const shellApi = {
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url)
};

contextBridge.exposeInMainWorld("hwanNote", api);
contextBridge.exposeInMainWorld("hwanShell", shellApi);
