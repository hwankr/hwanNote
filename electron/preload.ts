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
    list: (dirPath: string) => ipcRenderer.invoke("note:list", dirPath) as Promise<string[]>
  }
};

contextBridge.exposeInMainWorld("hwanNote", api);
