import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

const INDEX_FILENAME = ".hwan-note-index.json";
const TOGGLE_BLOCK_PATTERN = /^:::toggle\[(open|closed)\](?:\s+(.*))?$/i;
const TOGGLE_BLOCK_END = ":::";

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

  const toggleMatch = firstLine.match(TOGGLE_BLOCK_PATTERN);
  if (toggleMatch) {
    const summaryTitle = (toggleMatch[2] ?? "").trim();
    return summaryTitle || "제목 없음";
  }

  const stripped = firstLine
    .replace(/^#{1,3}\s+/, "")
    .replace(/^- \[[ xX]\]\s*/, "")
    .replace(/^:::\s*$/, "");
  return stripped || "제목 없음";
}

function markdownToPlainText(markdownText: string) {
  return markdownText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const toggleMatch = trimmed.match(TOGGLE_BLOCK_PATTERN);
      if (toggleMatch) {
        return (toggleMatch[2] ?? "").trim();
      }

      if (trimmed === TOGGLE_BLOCK_END) {
        return "";
      }

      return line.replace(/^(\s*)- \[[ xX]\]\s*/, "$1");
    })
    .join("\n")
    .trimEnd();
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToHtml(markdownText: string) {
  const normalized = markdownText.replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    return "<p></p>";
  }

  interface TaskNode {
    checked: boolean;
    text: string;
    depth: number;
    children: TaskNode[];
  }

  const checklistPattern = /^(\s*)-\s+\[([ xX])\]\s*(.*)$/;

  const renderTaskNodes = (nodes: TaskNode[]): string => {
    const renderNode = (node: TaskNode): string => {
      const checkedAttr = node.checked ? ' checked="checked"' : "";
      const text = escapeHtml(node.text);
      const nestedHtml = node.children.length > 0 ? renderTaskNodes(node.children) : "";

      return (
        `<li data-type="taskItem" data-checked="${node.checked ? "true" : "false"}">` +
          `<label><input type="checkbox"${checkedAttr}><span></span></label>` +
          `<div><p>${text || "<br>"}</p>${nestedHtml}</div>` +
        "</li>"
      );
    };

    return `<ul data-type="taskList">${nodes.map(renderNode).join("")}</ul>`;
  };

  const findToggleBlockEnd = (lines: string[], startIndex: number) => {
    let depth = 0;

    for (let i = startIndex; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();

      if (TOGGLE_BLOCK_PATTERN.test(trimmed)) {
        depth += 1;
        continue;
      }

      if (trimmed === TOGGLE_BLOCK_END) {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }

    return -1;
  };

  const renderLines = (lines: string[]) => {
    const html: string[] = [];
    let inCodeFence = false;
    let lineIndex = 0;

    while (lineIndex < lines.length) {
      const line = lines[lineIndex];
      const trimmed = line.trim();

      if (trimmed.startsWith("```")) {
        inCodeFence = !inCodeFence;
        html.push(`<p>${escapeHtml(line)}</p>`);
        lineIndex += 1;
        continue;
      }

      if (!inCodeFence) {
        const toggleMatch = trimmed.match(TOGGLE_BLOCK_PATTERN);
        if (toggleMatch) {
          const endIndex = findToggleBlockEnd(lines, lineIndex);
          if (endIndex !== -1) {
            const open = toggleMatch[1].toLowerCase() === "open";
            const summaryText = escapeHtml((toggleMatch[2] ?? "").trim()) || "Toggle";
            const innerLines = lines.slice(lineIndex + 1, endIndex);
            const innerHtml = renderLines(innerLines) || "<p><br></p>";
            const openAttr = open ? ' open="open"' : "";

            html.push(
              `<details data-type="toggleBlock"${openAttr}><summary>${summaryText}</summary>` +
                `<div data-type="toggleContent">${innerHtml}</div></details>`
            );
            lineIndex = endIndex + 1;
            continue;
          }
        }

        if (checklistPattern.test(line)) {
          const taskLines: Array<{ indent: number; checked: boolean; text: string }> = [];

          while (lineIndex < lines.length) {
            const taskLine = lines[lineIndex];
            if (!taskLine.trim() || !checklistPattern.test(taskLine)) {
              break;
            }

            const match = taskLine.match(checklistPattern);
            if (!match) {
              break;
            }

            const indent = match[1].replace(/\t/g, "  ").length;
            const depth = Math.max(0, Math.floor(indent / 2));
            const checked = match[2].toLowerCase() === "x";
            taskLines.push({
              indent: depth,
              checked,
              text: match[3] ?? ""
            });
            lineIndex += 1;
          }

          const roots: TaskNode[] = [];
          const stack: TaskNode[] = [];

          taskLines.forEach((taskLine) => {
            const node: TaskNode = {
              checked: taskLine.checked,
              text: taskLine.text,
              depth: taskLine.indent,
              children: []
            };

            const safeDepth = Math.min(node.depth, stack.length);
            while (stack.length > safeDepth) {
              stack.pop();
            }

            if (stack.length === 0) {
              roots.push(node);
            } else {
              stack[stack.length - 1].children.push(node);
            }

            stack.push(node);
          });

          html.push(renderTaskNodes(roots));
          continue;
        }
      }

      if (!trimmed) {
        html.push("<p><br></p>");
      } else {
        html.push(`<p>${escapeHtml(line)}</p>`);
      }
      lineIndex += 1;
    }

    return html.join("");
  };

  return renderLines(normalized.split("\n"));
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
  autoSaveDir: string,
  payload: AutoSavePayload
): Promise<AutoSaveResult> {
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

export async function loadMarkdownNotes(autoSaveDir: string): Promise<LoadedNote[]> {
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
      content: markdownToHtml(markdown),
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

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function saveTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, toWindowsCrlf(content), "utf8");
}

export function titleFromFilename(filePath: string): string {
  const base = basename(filePath, extname(filePath));
  return base.trim().slice(0, 50) || "제목 없음";
}
