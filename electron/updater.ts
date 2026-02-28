import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

interface UpdateStatus {
  status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  version?: string;
  progress?: number;
  error?: string;
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

export function initAutoUpdater(mainWindow: BrowserWindow) {
  if (!app.isPackaged) return;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return;

  const sendStatus = (payload: UpdateStatus) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("updater:status", payload);
    }
  };

  autoUpdater.on("checking-for-update", () => {
    sendStatus({ status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    sendStatus({ status: "available", version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    sendStatus({ status: "not-available" });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendStatus({ status: "downloading", progress: Math.round(progress.percent) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    sendStatus({ status: "downloaded", version: info.version });
  });

  autoUpdater.on("error", (err) => {
    sendStatus({ status: "error", error: err.message });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Silently ignore check failures (e.g., no network)
    });
  }, 3000);
}

export function startDownload() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return;
  autoUpdater.downloadUpdate().catch(() => {
    // Error event will fire via the listener above
  });
}

export function installUpdate() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return;
  autoUpdater.quitAndInstall();
}
