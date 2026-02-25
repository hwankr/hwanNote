import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { getCustomAutoSaveDir, getEffectiveAutoSaveDir, setCustomAutoSaveDir } from "./configManager";
import {
  type AutoSavePayload,
  autoSaveMarkdownNote,
  getAutoSaveDir,
  listMarkdownFiles,
  loadMarkdownNotes,
  readMarkdownFile,
  readTextFile,
  removeNoteFromIndex,
  saveMarkdownFile,
  saveTextFile,
  titleFromFilename
} from "./fileManager";

const isDev = !app.isPackaged;

function createMainWindow() {
  const iconPath = isDev
    ? path.join(__dirname, "../resources/icon.ico")
    : path.join(process.resourcesPath, "icon.ico");

  const mainWindow = new BrowserWindow({
    icon: iconPath,
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#F5F0EB",
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  return mainWindow;
}

function setupIpcHandlers() {
  ipcMain.handle("window:minimize", () => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });

  ipcMain.handle("window:toggle-maximize", () => {
    const win = BrowserWindow.getFocusedWindow();

    if (!win) {
      return false;
    }

    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    }

    win.maximize();
    return true;
  });

  ipcMain.handle("window:close", () => {
    BrowserWindow.getFocusedWindow()?.close();
  });

  ipcMain.handle("note:save", async (_event, filePath: string, content: string) => {
    await saveMarkdownFile(filePath, content);
    return true;
  });

  ipcMain.handle("note:read", async (_event, filePath: string) => {
    return readMarkdownFile(filePath);
  });

  ipcMain.handle("note:list", async (_event, dirPath: string) => {
    return listMarkdownFiles(dirPath);
  });

  async function resolveEffectiveAutoSaveDir() {
    const defaultDir = getAutoSaveDir(app.getPath("documents"));
    return getEffectiveAutoSaveDir(defaultDir);
  }

  ipcMain.handle("note:auto-save", async (_event, payload: AutoSavePayload) => {
    const effectiveDir = await resolveEffectiveAutoSaveDir();
    return autoSaveMarkdownNote(effectiveDir, payload);
  });

  ipcMain.handle("note:load-all", async () => {
    const effectiveDir = await resolveEffectiveAutoSaveDir();
    return loadMarkdownNotes(effectiveDir);
  });

  ipcMain.handle("note:delete", async (_event, noteId: string) => {
    const effectiveDir = await resolveEffectiveAutoSaveDir();
    const filePath = await removeNoteFromIndex(effectiveDir, noteId);
    if (!filePath) {
      return false;
    }

    try {
      await shell.trashItem(filePath);
    } catch {
      // File may already be missing; index entry was already removed
    }

    return true;
  });

  ipcMain.handle("settings:browse-autosave-dir", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("settings:set-autosave-dir", async (_event, dir: string | null) => {
    await setCustomAutoSaveDir(dir);
    const defaultDir = getAutoSaveDir(app.getPath("documents"));
    const effectiveDir = await getEffectiveAutoSaveDir(defaultDir);
    const customDir = await getCustomAutoSaveDir();
    return { customDir, effectiveDir, isDefault: customDir === null };
  });

  ipcMain.handle("settings:get-autosave-dir", async () => {
    const defaultDir = getAutoSaveDir(app.getPath("documents"));
    const effectiveDir = await getEffectiveAutoSaveDir(defaultDir);
    const customDir = await getCustomAutoSaveDir();
    return { customDir, effectiveDir, isDefault: customDir === null };
  });

  ipcMain.handle("note:import-txt", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      title: "텍스트 파일 가져오기",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Text Files", extensions: ["txt"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const imported = await Promise.all(
      result.filePaths.map(async (filePath) => {
        const content = await readTextFile(filePath);
        const title = titleFromFilename(filePath);
        return { title, content, filePath };
      })
    );

    return imported;
  });

  ipcMain.handle("note:save-txt", async (_event, filePath: string, content: string) => {
    await saveTextFile(filePath, content);
    return true;
  });

  ipcMain.handle("shell:open-external", async (_event, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const allowed = ["http:", "https:", "mailto:"];
    if (!allowed.includes(parsed.protocol)) {
      return;
    }
    await shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  setupIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
