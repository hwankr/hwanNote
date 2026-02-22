import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";

const INDEX_FILENAME = ".hwan-note-index.json";

interface NoteIndexEntry {
  relativePath: string;
  createdAt: number;
  manualTitle?: string;
}

interface NoteIndex {
  entries: Record<string, NoteIndexEntry>;
}

function assertMarkdownPath(filePath: string) {
  if (extname(filePath).toLowerCase() !== ".md") {
    throw new Error("Only .md files are supported.");
  }
}

function toWindowsCrlf(text: string) {
  return text.replace(/\r?\n/g, "\r\n");
}

function toPosix(pathValue: string) {
  return pathValue.replace(/\\/g, "/");
}

function sanitizeNoteId(noteId: string) {
  return noteId.replace(/[^a-zA-Z0-9_-]/g, "");
}

function sanitizeFolderPath(folderPath: string | undefined) {
  if (!folderPath) {
    return "";
  }

  const normalized = folderPath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.replace(/[^a-zA-Z0-9_-]/g, ""))
    .filter(Boolean)
    .join("/");

  if (!normalized || normalized === "inbox") {
    return "";
  }

  return normalized;
}

function slugifyTitle(title: string) {
  const slug = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, "-")
    .replace(/\.+$/g, "")
    .slice(0, 80);

  return slug || "untitled";
}

function deriveTitle(markdownText: string) {
  const firstLine = markdownText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "제목 없음";
  }

  const stripped = firstLine.replace(/^#{1,3}\s+/, "");
  return stripped || "제목 없음";
}

function markdownToPlainText(markdownText: string) {
  return markdownText.replace(/\r\n/g, "\n").trimEnd();
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTextToHtml(plainText: string) {
  const normalized = plainText.replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    return "<p></p>";
  }

  return normalized
    .split("\n")
    .map((line) => {
      if (!line.trim()) {
        return "<p><br></p>";
      }
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("");
}

function getIndexPath(autoSaveDir: string) {
  return join(autoSaveDir, INDEX_FILENAME);
}

async function readIndex(autoSaveDir: string): Promise<NoteIndex> {
  const indexPath = getIndexPath(autoSaveDir);

  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as NoteIndex;

    if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") {
      return { entries: {} };
    }

    return parsed;
  } catch {
    return { entries: {} };
  }
}

async function writeIndex(autoSaveDir: string, index: NoteIndex) {
  const indexPath = getIndexPath(autoSaveDir);
  await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
}

async function walkMarkdownFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === INDEX_FILENAME) {
      continue;
    }

    const fullPath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      const nested = await walkMarkdownFiles(rootDir, fullPath);
      files.push(...nested);
      continue;
    }

    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      files.push(fullPath);
    }
  }

  return files;
}

async function ensureUniqueFilePath(targetDir: string, baseName: string, exceptPath?: string) {
  let counter = 1;

  while (true) {
    const suffix = counter === 1 ? "" : `-${counter}`;
    const candidate = join(targetDir, `${baseName}${suffix}.md`);

    if (exceptPath && toPosix(candidate) === toPosix(exceptPath)) {
      return candidate;
    }

    try {
      await access(candidate);
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

function generateNoteId(relativeFilePath: string) {
  const hash = createHash("sha1").update(relativeFilePath).digest("hex").slice(0, 12);
  return `note-${hash}`;
}

export interface AutoSavePayload {
  noteId: string;
  title: string;
  content: string;
  folderPath?: string;
  isTitleManual?: boolean;
}

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

  await mkdir(targetDir, { recursive: true });

  const index = await readIndex(autoSaveDir);
  const existingEntry = index.entries[safeId];
  const existingPath = existingEntry ? join(autoSaveDir, existingEntry.relativePath) : undefined;

  const baseName = slugifyTitle(payload.title || deriveTitle(payload.content));
  const nextFilePath = await ensureUniqueFilePath(targetDir, baseName, existingPath);

  await writeFile(nextFilePath, toWindowsCrlf(payload.content), "utf8");

  if (existingPath && toPosix(existingPath) !== toPosix(nextFilePath)) {
    await rm(existingPath, { force: true });
  }

  const fileStat = await stat(nextFilePath);
  const createdAt = existingEntry?.createdAt ?? Date.now();

  const manualTitle = payload.title.trim().slice(0, 50);
  index.entries[safeId] = {
    relativePath: toPosix(relative(autoSaveDir, nextFilePath)),
    createdAt,
    manualTitle: payload.isTitleManual && manualTitle ? manualTitle : undefined
  };

  await writeIndex(autoSaveDir, index);

  return {
    filePath: nextFilePath,
    noteId: safeId,
    createdAt,
    updatedAt: fileStat.mtimeMs
  };
}

export async function loadMarkdownNotes(documentsDir: string): Promise<LoadedNote[]> {
  const autoSaveDir = getAutoSaveDir(documentsDir);
  await mkdir(autoSaveDir, { recursive: true });

  const index = await readIndex(autoSaveDir);
  const files = await walkMarkdownFiles(autoSaveDir);

  const byRelativePath = new Map<string, string>();
  files.forEach((filePath) => {
    byRelativePath.set(toPosix(relative(autoSaveDir, filePath)), filePath);
  });

  const usedPaths = new Set<string>();
  let indexChanged = false;

  for (const [noteId, entry] of Object.entries(index.entries)) {
    if (!byRelativePath.has(entry.relativePath)) {
      delete index.entries[noteId];
      indexChanged = true;
      continue;
    }

    usedPaths.add(entry.relativePath);
  }

  for (const [relativePath, fullPath] of byRelativePath.entries()) {
    if (usedPaths.has(relativePath)) {
      continue;
    }

    const generatedId = generateNoteId(relativePath);
    if (!index.entries[generatedId]) {
      const fileStat = await stat(fullPath);
      index.entries[generatedId] = {
        relativePath,
        createdAt: fileStat.birthtimeMs || fileStat.ctimeMs || Date.now()
      };
      indexChanged = true;
    }
  }

  const notes: LoadedNote[] = [];

  for (const [noteId, entry] of Object.entries(index.entries)) {
    const filePath = byRelativePath.get(entry.relativePath);
    if (!filePath) {
      continue;
    }

    const markdown = await readFile(filePath, "utf8");
    const plainText = markdownToPlainText(markdown);
    const derivedTitle = deriveTitle(markdown);
    const title = entry.manualTitle?.trim() ? entry.manualTitle.trim() : derivedTitle;
    const relativeFolder = toPosix(dirname(entry.relativePath));
    const folderPath = relativeFolder === "." ? "inbox" : relativeFolder;
    const fileStat = await stat(filePath);

    notes.push({
      noteId,
      title,
      isTitleManual: Boolean(entry.manualTitle?.trim()),
      plainText,
      content: plainTextToHtml(plainText),
      folderPath,
      createdAt: entry.createdAt,
      updatedAt: fileStat.mtimeMs,
      filePath
    });
  }

  if (indexChanged) {
    await writeIndex(autoSaveDir, index);
  }

  return notes.sort((a, b) => b.updatedAt - a.updatedAt);
}
