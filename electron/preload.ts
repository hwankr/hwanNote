import { contextBridge, ipcRenderer } from "electron";

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
    getAutoSaveDir: () => ipcRenderer.invoke("note:get-autosave-dir") as Promise<string>,
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
      >
  }
};

contextBridge.exposeInMainWorld("hwanNote", api);
