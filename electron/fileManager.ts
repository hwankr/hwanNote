import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

function assertMarkdownPath(filePath: string) {
  if (extname(filePath).toLowerCase() !== ".md") {
    throw new Error("Only .md files are supported.");
  }
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
