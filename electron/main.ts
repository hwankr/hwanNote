import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { listMarkdownFiles, readMarkdownFile, saveMarkdownFile } from "./fileManager";

const isDev = !app.isPackaged;

function createMainWindow() {
  const mainWindow = new BrowserWindow({
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
