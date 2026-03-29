export function normalizeFolderPath(path: string) {
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments[0]?.toLowerCase() === "inbox") {
    segments.shift();
  }

  return segments.join("/");
}
