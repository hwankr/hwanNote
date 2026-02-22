import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

function assertMarkdownPath(filePath: string) {
  if (extname(filePath).toLowerCase() !== ".md") {
    throw new Error("Only .md files are supported.");
  }
}

function toWindowsCrlf(text: string) {
  return text.replace(/\r?\n/g, "\r\n");
}

function sanitizeNoteId(noteId: string) {
  return noteId.replace(/[^a-zA-Z0-9_-]/g, "");
}

function sanitizeFolderPath(folderPath: string | undefined) {
  if (!folderPath) {
    return "";
  }

  return folderPath
    .split(/[\\/]/)
    .map((segment) => segment.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter(Boolean)
    .join("/");
}

export interface AutoSavePayload {
  noteId: string;
  title: string;
  content: string;
  folderPath?: string;
}

export interface AutoSaveResult {
  filePath: string;
}

export function getAutoSaveDir(documentsDir: string) {
  return join(documentsDir, "HwanNote", "Notes");
}

export async function saveMarkdownFile(filePath: string, content: string) {
  assertMarkdownPath(filePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function readMarkdownFile(filePath: string) {
  assertMarkdownPath(filePath);
  return readFile(filePath, "utf8");
}

export async function listMarkdownFiles(dirPath: string) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
    .map((entry) => join(dirPath, entry.name));
}

export async function autoSaveMarkdownNote(
  documentsDir: string,
  payload: AutoSavePayload
): Promise<AutoSaveResult> {
  const autoSaveDir = getAutoSaveDir(documentsDir);
  const safeId = sanitizeNoteId(payload.noteId) || "note";
  const safeFolderPath = sanitizeFolderPath(payload.folderPath);
  const targetDir = safeFolderPath ? join(autoSaveDir, safeFolderPath) : autoSaveDir;
  const filePath = join(targetDir, `${safeId}.md`);

  await mkdir(targetDir, { recursive: true });
  await writeFile(filePath, toWindowsCrlf(payload.content), "utf8");

  return { filePath };
}
