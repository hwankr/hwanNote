import { app } from "electron";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

interface AppConfig {
  autoSaveDir?: string | null;
}

function getConfigPath() {
  return join(app.getPath("userData"), "config.json");
}

async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as AppConfig;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeConfig(config: AppConfig): Promise<void> {
  const configPath = getConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

export async function getCustomAutoSaveDir(): Promise<string | null> {
  const config = await readConfig();
  const dir = config.autoSaveDir;
  if (!dir) return null;
  try {
    await access(dir);
    return dir;
  } catch {
    return null;
  }
}

export async function setCustomAutoSaveDir(dir: string | null): Promise<void> {
  if (dir !== null) {
    if (!isAbsolute(dir)) {
      throw new Error("Path must be absolute");
    }
    await access(dir, constants.W_OK);
  }
  const config = await readConfig();
  config.autoSaveDir = dir;
  await writeConfig(config);
}

export async function getEffectiveAutoSaveDir(defaultDir: string): Promise<string> {
  const custom = await getCustomAutoSaveDir();
  return custom ?? defaultDir;
}
