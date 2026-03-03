import { Editor as TiptapEditor } from "@tiptap/react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hwanNote, type CloudProviderInfo, type LoadedNote } from "./lib/tauriApi";
import Editor, { restoreEditorFocus } from "./components/Editor";
import SettingsPanel, { type ThemeMode } from "./components/SettingsPanel";
import Sidebar, { type SidebarTag } from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import UpdateToast from "./components/UpdateToast";
import { useAutoSave } from "./hooks/useAutoSave";
import { useI18n } from "./i18n/context";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFINITIONS,
  createDefaultShortcuts,
  isContextMatch,
  matchesShortcut,
  parseShortcutMap,
  validateShortcutAssignment,
  type ShortcutAction,
  type ShortcutCombo,
  type ShortcutMap
} from "./lib/shortcuts";
import { applyTheme, type ThemeName } from "./styles/themes";
import { readTabSessionFromStorage, useNoteStore, type NoteTab } from "./stores/noteStore";

const CUSTOM_FOLDERS_KEY = "hwan-note:custom-folders";
const EDITOR_FONT_SIZE_KEY = "hwan-note:editor-font-size";
const EDITOR_LINE_HEIGHT_KEY = "hwan-note:editor-line-height";
const EDITOR_SPELLCHECK_KEY = "hwan-note:editor-spellcheck";
const SHORTCUTS_KEY = "hwan-note:shortcuts";
const SPLIT_RATIO_KEY = "hwan-note:split-ratio";
const TAB_SIZE_KEY = "hwan-note:tab-size";
const THEME_MODE_KEY = "hwan-note:theme-mode";
const MIN_EDITOR_FONT_SIZE = 10;
const MAX_EDITOR_FONT_SIZE = 24;
const DEFAULT_EDITOR_FONT_SIZE = 14;
const MIN_EDITOR_LINE_HEIGHT = 1.2;
const MAX_EDITOR_LINE_HEIGHT = 2.2;
const DEFAULT_EDITOR_LINE_HEIGHT = 1.55;
const DEFAULT_TAB_SIZE = 4;
const VALID_TAB_SIZES = [2, 4, 8];
const MIN_SPLIT_RATIO = 0.25;
const MAX_SPLIT_RATIO = 0.75;
const DEFAULT_SPLIT_RATIO = 0.5;

type SortMode = "updated" | "title" | "created";
type PaneId = "primary" | "secondary";
type PaneEditors = Record<PaneId, TiptapEditor | null>;
type PaneCursor = { line: number; column: number; chars: number };
type PaneCursors = Record<PaneId, PaneCursor>;

function getDraftKey(tabId: string) {
  return `hwan-note:draft:${tabId}`;
}

function normalizeFolderPath(path: string) {
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

function normalizeIntentPathKey(filePath: string) {
  return filePath.trim().replace(/\\/g, "/").toLowerCase();
}

function textToParagraphHtml(content: string) {
  const escapeHtml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>"))
    .join("");
}

function htmlToMarkdownWithBlocks(contentHtml: string) {
  const parser = new DOMParser();
  const document = parser.parseFromString(contentHtml, "text/html");
  const lines: string[] = [];

  const extractText = (element: Element) =>
    element.textContent?.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim() ?? "";
  const normalizeText = (text: string) => text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();

  const extractTaskItemText = (container: Element) => {
    const segments: string[] = [];

    container.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = normalizeText(child.textContent ?? "");
        if (text) {
          segments.push(text);
        }
        return;
      }

      if (!(child instanceof Element)) {
        return;
      }

      if (child.matches('ul[data-type="taskList"]')) {
        return;
      }

      const text = normalizeText(child.textContent ?? "");
      if (text) {
        segments.push(text);
      }
    });

    return segments.join(" ").trim();
  };

  const pushTaskList = (list: Element, depth: number) => {
    const taskItems = Array.from(list.children).filter((child) => child.matches('li[data-type="taskItem"]'));

    taskItems.forEach((item) => {
      const checked =
        item.getAttribute("data-checked") === "true" ||
        item.querySelector('label > input[type="checkbox"]')?.hasAttribute("checked");
      const content = item.querySelector(":scope > div");
      const itemText = content ? extractTaskItemText(content) : extractText(item);
      const prefix = `${"  ".repeat(Math.max(0, depth))}- [${checked ? "x" : " "}]`;
      lines.push(itemText ? `${prefix} ${itemText}` : prefix);

      const nestedTaskLists = content
        ? Array.from(content.children).filter((child) => child.matches('ul[data-type="taskList"]'))
        : [];
      nestedTaskLists.forEach((nested) => pushTaskList(nested, depth + 1));
    });
  };

  const pushNode = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.replace(/\r?\n/g, "\n").trim();
      if (text) {
        lines.push(text);
      }
      return;
    }

    if (!(node instanceof Element)) {
      return;
    }

    if (node.matches('ul[data-type="taskList"]')) {
      pushTaskList(node, 0);
      return;
    }

    if (node.matches('details[data-type="toggleBlock"], details')) {
      const isOpen = node.hasAttribute("open");
      const summary = node.querySelector(":scope > summary");
      const summaryText = normalizeText(summary?.textContent ?? "");
      lines.push(`:::toggle[${isOpen ? "open" : "closed"}]${summaryText ? ` ${summaryText}` : ""}`);

      const content = Array.from(node.children).find((child) => child !== summary);
      if (content) {
        Array.from(content.childNodes).forEach(pushNode);
      }

      lines.push(":::");
      return;
    }

    if (node.matches('div[data-type="toggleContent"]')) {
      Array.from(node.childNodes).forEach(pushNode);
      return;
    }

    if (node.matches("p")) {
      const text = extractText(node);
      lines.push(text);
      return;
    }

    if (node.matches("h1, h2, h3, h4, h5, h6")) {
      const text = extractText(node);
      if (text) {
        lines.push(text);
      }
      return;
    }

    const text = extractText(node);
    lines.push(text);
  };

  Array.from(document.body.childNodes).forEach(pushNode);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function toMarkdownDocument(title: string, plainText: string, contentHtml: string, fallbackTitle: string) {
  const hasTaskList = /<ul[^>]*data-type=(['"])taskList\1/i.test(contentHtml);
  const hasToggleBlock = /<details/i.test(contentHtml);
  const hasStructuredBlocks = hasTaskList || hasToggleBlock;
  const sourceText = hasStructuredBlocks ? htmlToMarkdownWithBlocks(contentHtml) : plainText;
  const normalizedBody = sourceText.replace(/\r?\n/g, "\n").trimEnd();
  if (normalizedBody) {
    return `${normalizedBody}\n`;
  }

  const safeTitle = title.trim() || fallbackTitle;
  return `# ${safeTitle}\n`;
}

function toTabSaveAsContent(tab: NoteTab, fallbackTitle: string) {
  if (tab.fileFormat === "txt") {
    return {
      extension: "txt" as const,
      content: tab.plainText
    };
  }

  return {
    extension: "md" as const,
    content: toMarkdownDocument(tab.title, tab.plainText, tab.content, fallbackTitle)
  };
}

function extractTags(plainText: string) {
  const matcher = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
  const tags = new Set<string>();

  for (const match of plainText.matchAll(matcher)) {
    tags.add(match[2].toLowerCase());
  }

  return Array.from(tags);
}

function tagColor(tag: string) {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  }

  const hue = hash % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

function replaceFolderPrefix(path: string, from: string, to: string) {
  if (path === from) {
    return to;
  }

  if (path.startsWith(`${from}/`)) {
    return `${to}${path.slice(from.length)}`;
  }

  return path;
}

function resolveTheme(mode: ThemeMode, prefersDark: boolean): ThemeName {
  if (mode === "system") {
    return prefersDark ? "dark" : "light";
  }

  return mode;
}

function normalizeEditorFontSize(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  return Math.round(Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, value)));
}

function normalizeEditorLineHeight(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_EDITOR_LINE_HEIGHT;
  }

  if (value < MIN_EDITOR_LINE_HEIGHT) {
    return MIN_EDITOR_LINE_HEIGHT;
  }

  if (value > MAX_EDITOR_LINE_HEIGHT) {
    return MAX_EDITOR_LINE_HEIGHT;
  }

  return Math.round(value * 100) / 100;
}

function clampSplitRatio(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_SPLIT_RATIO;
  }

  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

function pickDistinctTabId(tabIds: string[], excludedId: string, preferredId?: string | null) {
  if (preferredId && preferredId !== excludedId && tabIds.includes(preferredId)) {
    return preferredId;
  }

  return tabIds.find((id) => id !== excludedId) ?? null;
}

export default function App() {
  const { t, localeTag, language } = useI18n();
  const allNotes = useNoteStore((state) => state.allNotes);
  const openTabs = useNoteStore((state) => state.openTabs);
  const activeTabId = useNoteStore((state) => state.activeTabId);
  const sidebarVisible = useNoteStore((state) => state.sidebarVisible);
  const createTab = useNoteStore((state) => state.createTab);
  const hydrateTabs = useNoteStore((state) => state.hydrateTabs);
  const openNote = useNoteStore((state) => state.openNote);
  const setActiveTab = useNoteStore((state) => state.setActiveTab);
  const closeTab = useNoteStore((state) => state.closeTab);
  const closeOtherTabs = useNoteStore((state) => state.closeOtherTabs);
  const reorderTabs = useNoteStore((state) => state.reorderTabs);
  const removeNote = useNoteStore((state) => state.removeNote);
  const togglePinTab = useNoteStore((state) => state.togglePinTab);
  const moveTabToFolder = useNoteStore((state) => state.moveTabToFolder);
  const renameFolderPath = useNoteStore((state) => state.renameFolderPath);
  const clearFolderPath = useNoteStore((state) => state.clearFolderPath);
  const updateTabContent = useNoteStore((state) => state.updateTabContent);
  const setTabTitle = useNoteStore((state) => state.setTabTitle);
  const markTabSaved = useNoteStore((state) => state.markTabSaved);
  const toggleFileFormat = useNoteStore((state) => state.toggleFileFormat);
  const toggleSidebar = useNoteStore((state) => state.toggleSidebar);
  const addImportedTab = useNoteStore((state) => state.addImportedTab);

  const [isSplit, setIsSplit] = useState(false);
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      const raw = window.localStorage.getItem(SPLIT_RATIO_KEY);
      if (raw) {
        return clampSplitRatio(Number.parseFloat(raw));
      }
    } catch {
      // ignore localStorage failures
    }

    return DEFAULT_SPLIT_RATIO;
  });
  const [primaryTabId, setPrimaryTabId] = useState<string | null>(null);
  const [secondaryTabId, setSecondaryTabId] = useState<string | null>(null);
  const [focusedPane, setFocusedPane] = useState<PaneId>("primary");
  const [paneEditors, setPaneEditors] = useState<PaneEditors>({ primary: null, secondary: null });
  const [paneCursors, setPaneCursors] = useState<PaneCursors>({
    primary: { line: 1, column: 1, chars: 0 },
    secondary: { line: 1, column: 1, chars: 0 }
  });
  const [isMaximized, setIsMaximized] = useState(false);
  const editorWorkspaceRef = useRef<HTMLElement | null>(null);
  const [splitDropTarget, setSplitDropTarget] = useState<PaneId | null>(null);
  const splitResizeRef = useRef<{
    startX: number;
    startRatio: number;
    workspaceWidth: number;
  } | null>(null);
  const openIntentBufferRef = useRef<string[]>([]);
  const inFlightIntentKeysRef = useRef<Set<string>>(new Set());
  const hydrationCompleteRef = useRef(false);

  const tabById = useMemo(() => {
    const map = new Map<string, NoteTab>();
    openTabs.forEach((tab) => {
      map.set(tab.id, tab);
    });
    return map;
  }, [openTabs]);

  const openTabIds = useMemo(() => openTabs.map((tab) => tab.id), [openTabs]);
  const focusedTabId = useMemo(() => {
    if (isSplit && focusedPane === "secondary") {
      return secondaryTabId ?? primaryTabId;
    }

    return primaryTabId ?? secondaryTabId;
  }, [focusedPane, isSplit, primaryTabId, secondaryTabId]);
  const primaryTab = primaryTabId ? (tabById.get(primaryTabId) ?? null) : null;
  const secondaryTab = secondaryTabId ? (tabById.get(secondaryTabId) ?? null) : null;
  const focusedTab = focusedTabId ? (tabById.get(focusedTabId) ?? null) : null;
  const focusedEditor = focusedPane === "secondary" ? paneEditors.secondary : paneEditors.primary;
  const cursor = paneCursors[focusedPane];

  const setPaneTab = useCallback(
    (pane: PaneId, nextTabId: string) => {
      if (pane === "primary") {
        setPrimaryTabId(nextTabId);
        if (isSplit && secondaryTabId === nextTabId) {
          setSecondaryTabId((current) => pickDistinctTabId(openTabIds, nextTabId, current));
        }
      } else {
        setSecondaryTabId(nextTabId);
        if (primaryTabId === nextTabId) {
          setPrimaryTabId((current) => pickDistinctTabId(openTabIds, nextTabId, current));
        }
      }
    },
    [isSplit, openTabIds, primaryTabId, secondaryTabId]
  );

  const focusPane = useCallback(
    (pane: PaneId) => {
      if (pane === "secondary" && !isSplit) {
        return;
      }

      setFocusedPane(pane);
      const paneTabId = pane === "secondary" && isSplit ? secondaryTabId : primaryTabId;
      if (paneTabId && paneTabId !== activeTabId) {
        setActiveTab(paneTabId);
      }
    },
    [activeTabId, isSplit, primaryTabId, secondaryTabId, setActiveTab]
  );

  const handleCursorChange = useCallback((pane: PaneId, line: number, column: number, chars: number) => {
    setPaneCursors((prev) => ({
      ...prev,
      [pane]: { line, column, chars }
    }));
  }, []);

  const handleEditorChange = useCallback((pane: PaneId, content: string, plainText: string) => {
    const targetTabId = pane === "secondary" && isSplit ? secondaryTabId : primaryTabId;
    if (!targetTabId) {
      return;
    }

    updateTabContent(targetTabId, content, plainText);
  }, [isSplit, primaryTabId, secondaryTabId, updateTabContent]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"all" | "title" | "content">("all");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("updated");
  const [customFolders, setCustomFolders] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(CUSTOM_FOLDERS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          return Array.from(new Set(
            parsed.filter((e): e is string => typeof e === "string").map(normalizeFolderPath)
          ));
        }
      }
    } catch { /* ignore */ }
    return [];
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [editorFontSize, setEditorFontSize] = useState(DEFAULT_EDITOR_FONT_SIZE);
  const [editorLineHeight, setEditorLineHeight] = useState(DEFAULT_EDITOR_LINE_HEIGHT);
  const [editorSpellcheck, setEditorSpellcheck] = useState(true);
  const [autoSaveDir, setAutoSaveDir] = useState("");
  const [autoSaveDirIsDefault, setAutoSaveDirIsDefault] = useState(true);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(() => createDefaultShortcuts());
  const [tabSize, setTabSize] = useState(DEFAULT_TAB_SIZE);
  const [cloudSyncProvider, setCloudSyncProvider] = useState<string | null>(null);
  const [cloudProviders, setCloudProviders] = useState<CloudProviderInfo[]>([]);

  const noteTags = useMemo(() => {
    const map = new Map<string, string[]>();
    allNotes.forEach((tab) => {
      map.set(tab.id, extractTags(tab.plainText));
    });
    return map;
  }, [allNotes]);

  const tags = useMemo<SidebarTag[]>(() => {
    const count = new Map<string, number>();

    noteTags.forEach((values) => {
      values.forEach((tag) => {
        count.set(tag, (count.get(tag) ?? 0) + 1);
      });
    });

    return Array.from(count.entries())
      .map(([name, tagCount]) => ({
        name,
        count: tagCount,
        color: tagColor(name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, localeTag));
  }, [localeTag, noteTags]);

  const folderPaths = useMemo(() => {
    const merged = new Set<string>();

    customFolders.forEach((path) => merged.add(normalizeFolderPath(path)));
    allNotes.forEach((tab) => merged.add(normalizeFolderPath(tab.folderPath)));

    return Array.from(merged).sort((a, b) => a.localeCompare(b, localeTag));
  }, [customFolders, localeTag, allNotes]);

  const filteredNotes = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    const filtered = allNotes.filter((tab) => {
      if (selectedFolder) {
        const folderPath = normalizeFolderPath(tab.folderPath);
        if (!(folderPath === selectedFolder || folderPath.startsWith(`${selectedFolder}/`))) {
          return false;
        }
      }

      if (selectedTag) {
        const tabTags = noteTags.get(tab.id) ?? [];
        if (!tabTags.includes(selectedTag)) {
          return false;
        }
      }

      if (normalizedQuery) {
        let haystack: string;
        switch (searchMode) {
          case "title":
            haystack = tab.title.toLowerCase();
            break;
          case "content":
            haystack = tab.plainText.toLowerCase();
            break;
          default:
            haystack = `${tab.title} ${tab.plainText}`.toLowerCase();
        }
        if (!haystack.includes(normalizedQuery)) {
          return false;
        }
      }

      return true;
    });

    return filtered.sort((a, b) => {
      if (a.isPinned !== b.isPinned) {
        return a.isPinned ? -1 : 1;
      }

      switch (sortMode) {
        case "title":
          return a.title.localeCompare(b.title, localeTag);
        case "created":
          return b.createdAt - a.createdAt;
        case "updated":
        default:
          return b.updatedAt - a.updatedAt;
      }
    });
  }, [allNotes, selectedFolder, selectedTag, searchQuery, searchMode, noteTags, sortMode, localeTag]);

  const mapLoadedNoteToTab = useCallback(
    (note: LoadedNote) => ({
      id: note.noteId,
      title: note.title,
      isTitleManual: note.isTitleManual,
      content: note.content,
      plainText: note.plainText,
      isDirty: false,
      isPinned: false,
      folderPath: normalizeFolderPath(note.folderPath),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      lastSavedAt: 0,
      fileFormat: "md" as const
    }),
    []
  );

  const hydrateLoadedNotes = useCallback(
    (loaded: LoadedNote[]) => {
      hydrateTabs(loaded.map(mapLoadedNoteToTab), readTabSessionFromStorage());

      const loadedFolders = loaded.map((note) => normalizeFolderPath(note.folderPath)).filter(Boolean);
      setCustomFolders((prev) => Array.from(new Set([...prev, ...loadedFolders])));
    },
    [hydrateTabs, mapLoadedNoteToTab]
  );

  const findExistingTxtTabIdByPath = useCallback((filePath: string) => {
    const targetKey = normalizeIntentPathKey(filePath);
    if (!targetKey) {
      return null;
    }

    const state = useNoteStore.getState();
    for (const noteId of state.noteIds) {
      const sourcePath = state.notesById[noteId]?.sourceFilePath;
      if (!sourcePath) {
        continue;
      }

      if (normalizeIntentPathKey(sourcePath) === targetKey) {
        return noteId;
      }
    }

    return null;
  }, []);

  const ingestImportedTextFile = useCallback((title: string, content: string, filePath: string) => {
    const html = textToParagraphHtml(content);
    addImportedTab(title, html || "<p></p>", content.replace(/\r?\n/g, "\n"), filePath);
  }, [addImportedTab]);

  const ingestExternalTxtIntent = useCallback(async (filePath: string) => {
    const noteApi = hwanNote.note;
    if (!noteApi?.readExternalTxt) {
      return;
    }

    const existingTabId = findExistingTxtTabIdByPath(filePath);
    if (existingTabId) {
      openNote(existingTabId);
      return;
    }

    const dedupeKey = normalizeIntentPathKey(filePath);
    if (!dedupeKey || inFlightIntentKeysRef.current.has(dedupeKey)) {
      return;
    }

    inFlightIntentKeysRef.current.add(dedupeKey);

    try {
      const imported = await noteApi.readExternalTxt(filePath);
      const existingAfterRead = findExistingTxtTabIdByPath(imported.filePath);
      if (existingAfterRead) {
        openNote(existingAfterRead);
        return;
      }

      ingestImportedTextFile(imported.title, imported.content, imported.filePath);
    } catch (error) {
      console.error("Failed to open external .txt file:", error);
    } finally {
      inFlightIntentKeysRef.current.delete(dedupeKey);
    }
  }, [findExistingTxtTabIdByPath, ingestImportedTextFile, openNote]);

  const ingestExternalTxtIntents = useCallback(async (filePaths: string[]) => {
    const merged = new Set<string>();

    for (const filePath of filePaths) {
      const key = normalizeIntentPathKey(filePath);
      if (!key || merged.has(key)) {
        continue;
      }

      merged.add(key);
      await ingestExternalTxtIntent(filePath);
    }
  }, [ingestExternalTxtIntent]);

  useEffect(() => {
    const savedThemeMode = window.localStorage.getItem(THEME_MODE_KEY);
    if (savedThemeMode === "light" || savedThemeMode === "dark" || savedThemeMode === "system") {
      setThemeMode(savedThemeMode);
    }

    try {
      const rawShortcuts = window.localStorage.getItem(SHORTCUTS_KEY);
      if (rawShortcuts) {
        const parsed = JSON.parse(rawShortcuts) as unknown;
        setShortcuts(parseShortcutMap(parsed));
      }
    } catch (error) {
      console.warn("Failed to load shortcuts", error);
    }

    try {
      const rawFontSize = window.localStorage.getItem(EDITOR_FONT_SIZE_KEY);
      if (rawFontSize) {
        const parsed = Number.parseInt(rawFontSize, 10);
        setEditorFontSize(normalizeEditorFontSize(parsed));
      }
    } catch (error) {
      console.warn("Failed to load editor font-size", error);
    }

    try {
      const rawLineHeight = window.localStorage.getItem(EDITOR_LINE_HEIGHT_KEY);
      if (rawLineHeight) {
        const parsed = Number.parseFloat(rawLineHeight);
        setEditorLineHeight(normalizeEditorLineHeight(parsed));
      }
    } catch (error) {
      console.warn("Failed to load editor line-height", error);
    }

    try {
      const rawTabSize = window.localStorage.getItem(TAB_SIZE_KEY);
      if (rawTabSize) {
        const parsed = Number.parseInt(rawTabSize, 10);
        if (VALID_TAB_SIZES.includes(parsed)) {
          setTabSize(parsed);
        }
      }
    } catch (error) {
      console.warn("Failed to load tab size", error);
    }

    try {
      const rawSpellcheck = window.localStorage.getItem(EDITOR_SPELLCHECK_KEY);
      if (rawSpellcheck === "true" || rawSpellcheck === "false") {
        setEditorSpellcheck(rawSpellcheck === "true");
      }
    } catch (error) {
      console.warn("Failed to load editor spellcheck", error);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CUSTOM_FOLDERS_KEY, JSON.stringify(customFolders));
  }, [customFolders]);

  useEffect(() => {
    window.localStorage.setItem(THEME_MODE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcuts));
  }, [shortcuts]);

  useEffect(() => {
    window.localStorage.setItem(TAB_SIZE_KEY, String(tabSize));
  }, [tabSize]);

  useEffect(() => {
    window.localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(editorFontSize));
    document.documentElement.style.setProperty("--editor-font-size", `${editorFontSize}px`);
  }, [editorFontSize]);

  useEffect(() => {
    window.localStorage.setItem(EDITOR_LINE_HEIGHT_KEY, String(editorLineHeight));
    document.documentElement.style.setProperty("--editor-line-height", String(editorLineHeight));
  }, [editorLineHeight]);

  useEffect(() => {
    window.localStorage.setItem(EDITOR_SPELLCHECK_KEY, String(editorSpellcheck));
  }, [editorSpellcheck]);

  useEffect(() => {
    window.localStorage.setItem(SPLIT_RATIO_KEY, String(splitRatio));
  }, [splitRatio]);

  useEffect(() => {
    if (openTabIds.length === 0) {
      setPrimaryTabId(null);
      setSecondaryTabId(null);
      setIsSplit(false);
      setFocusedPane("primary");
      return;
    }

    const fallbackPrimary =
      (activeTabId && openTabIds.includes(activeTabId) ? activeTabId : null) ?? openTabIds[0];
    const nextPrimary = primaryTabId && openTabIds.includes(primaryTabId) ? primaryTabId : fallbackPrimary;

    let nextIsSplit = isSplit && openTabIds.length > 1;
    let nextSecondary =
      nextIsSplit &&
      secondaryTabId &&
      openTabIds.includes(secondaryTabId) &&
      secondaryTabId !== nextPrimary
        ? secondaryTabId
        : pickDistinctTabId(openTabIds, nextPrimary, secondaryTabId);

    if (!nextSecondary) {
      nextIsSplit = false;
      nextSecondary = null;
    }

    if (nextPrimary !== primaryTabId) {
      setPrimaryTabId(nextPrimary);
    }
    if (nextSecondary !== secondaryTabId) {
      setSecondaryTabId(nextSecondary);
    }
    if (nextIsSplit !== isSplit) {
      setIsSplit(nextIsSplit);
    }
    if (!nextIsSplit && focusedPane !== "primary") {
      setFocusedPane("primary");
    }
  }, [activeTabId, focusedPane, isSplit, openTabIds, primaryTabId, secondaryTabId]);

  useEffect(() => {
    if (!focusedTabId || focusedTabId === activeTabId) {
      return;
    }
    setActiveTab(focusedTabId);
  }, [activeTabId, focusedTabId, setActiveTab]);

  useEffect(() => {
    const noteApi = hwanNote.note;
    if (!noteApi?.loadAll) {
      return;
    }

    let disposed = false;

    const stopListening = noteApi.onOpenIntent?.((filePath) => {
      if (!filePath) {
        return;
      }

      if (hydrationCompleteRef.current) {
        void ingestExternalTxtIntent(filePath);
        return;
      }

      openIntentBufferRef.current.push(filePath);
    });

    const run = async () => {
      try {
        const loaded = await noteApi.loadAll();
        if (disposed) {
          return;
        }

        hydrateLoadedNotes(loaded);

        const pendingFromBackend = noteApi.drainOpenIntents
          ? await noteApi.drainOpenIntents()
          : [];

        if (disposed) {
          return;
        }

        const buffered = openIntentBufferRef.current;
        openIntentBufferRef.current = [];
        hydrationCompleteRef.current = true;

        await ingestExternalTxtIntents([...buffered, ...pendingFromBackend]);
      } catch (error) {
        console.error("Failed to load notes from file system:", error);
      }
    };

    void run();

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [hydrateLoadedNotes, ingestExternalTxtIntent, ingestExternalTxtIntents]);

  useEffect(() => {
    if (selectedFolder && !folderPaths.includes(selectedFolder)) {
      setSelectedFolder(null);
    }
  }, [folderPaths, selectedFolder]);

  useEffect(() => {
    if (selectedTag && !tags.some((tag) => tag.name === selectedTag)) {
      setSelectedTag(null);
    }
  }, [selectedTag, tags]);

  const handleSelectTabInFocusedPane = useCallback((tabId: string) => {
    setPaneTab(focusedPane, tabId);
    setActiveTab(tabId);
  }, [focusedPane, setActiveTab, setPaneTab]);

  const handleSelectNoteInFocusedPane = useCallback((tabId: string) => {
    openNote(tabId);
    setPaneTab(focusedPane, tabId);
    setActiveTab(tabId);
  }, [focusedPane, openNote, setActiveTab, setPaneTab]);

  const handleCreateTabInFocusedPane = useCallback(() => {
    const prevIds = new Set(openTabIds);
    createTab();

    queueMicrotask(() => {
      const state = useNoteStore.getState();
      const createdId = state.openTabIds.find((id) => !prevIds.has(id));
      if (!createdId) {
        return;
      }

      setPaneTab(focusedPane, createdId);
      setActiveTab(createdId);
    });
  }, [createTab, focusedPane, openTabIds, setActiveTab, setPaneTab]);

  const resolveWorkspaceDropTarget = useCallback((clientX: number, clientY: number) => {
    const workspace = editorWorkspaceRef.current;
    if (!workspace) {
      return null;
    }

    const rect = workspace.getBoundingClientRect();
    const isInsideWorkspace =
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    if (!isInsideWorkspace) {
      return null;
    }

    return clientX < rect.left + rect.width / 2 ? "primary" : "secondary";
  }, []);

  const handleTabDragPreview = useCallback((_tabId: string, clientX: number, clientY: number) => {
    if (openTabIds.length <= 1) {
      setSplitDropTarget(null);
      return;
    }

    setSplitDropTarget(resolveWorkspaceDropTarget(clientX, clientY));
  }, [openTabIds.length, resolveWorkspaceDropTarget]);

  const handleTabDragEnd = useCallback(() => {
    setSplitDropTarget(null);
  }, []);

  const handleDropTabOutside = useCallback((tabId: string, clientX: number, clientY: number) => {
    setSplitDropTarget(null);
    if (openTabIds.length <= 1) {
      return;
    }

    const targetPane = resolveWorkspaceDropTarget(clientX, clientY);
    if (!targetPane) {
      return;
    }

    const fallbackTabId = pickDistinctTabId(openTabIds, tabId, targetPane === "primary" ? secondaryTabId : primaryTabId);
    if (!fallbackTabId) {
      return;
    }

    setIsSplit(true);
    setFocusedPane(targetPane);
    if (targetPane === "primary") {
      setPrimaryTabId(tabId);
      setSecondaryTabId(fallbackTabId);
    } else {
      setSecondaryTabId(tabId);
      setPrimaryTabId(fallbackTabId);
    }
    setActiveTab(tabId);
  }, [openTabIds, primaryTabId, resolveWorkspaceDropTarget, secondaryTabId, setActiveTab]);

  const handleCycleTabInFocusedPane = useCallback((direction: 1 | -1) => {
    const currentTabId = focusedPane === "secondary" && isSplit ? secondaryTabId : primaryTabId;
    if (!currentTabId || openTabIds.length <= 1) {
      return;
    }

    const currentIndex = openTabIds.findIndex((id) => id === currentTabId);
    if (currentIndex === -1) {
      return;
    }

    const nextIndex = (currentIndex + direction + openTabIds.length) % openTabIds.length;
    const nextTabId = openTabIds[nextIndex];
    setPaneTab(focusedPane, nextTabId);
    setActiveTab(nextTabId);
  }, [focusedPane, isSplit, openTabIds, primaryTabId, secondaryTabId, setActiveTab, setPaneTab]);

  const handleSplitDividerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isSplit || !editorWorkspaceRef.current) {
      return;
    }

    const rect = editorWorkspaceRef.current.getBoundingClientRect();
    splitResizeRef.current = {
      startX: event.clientX,
      startRatio: splitRatio,
      workspaceWidth: rect.width
    };
    event.preventDefault();
  }, [isSplit, splitRatio]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = splitResizeRef.current;
      if (!resizeState || resizeState.workspaceWidth <= 0) {
        return;
      }

      const deltaX = event.clientX - resizeState.startX;
      const ratioDelta = deltaX / resizeState.workspaceWidth;
      setSplitRatio(clampSplitRatio(resizeState.startRatio + ratioDelta));
    };

    const handlePointerUp = () => {
      splitResizeRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  const handleImportTxt = useCallback(async () => {
    const noteApi = hwanNote.note;
    if (!noteApi?.importTxt) return;

    const imported = await noteApi.importTxt();
    if (!imported || imported.length === 0) return;

    for (const { title, content, filePath } of imported) {
      ingestImportedTextFile(title, content, filePath);
    }
  }, [ingestImportedTextFile]);

  const handleManualSave = useCallback(async () => {
    if (!focusedTab) {
      return;
    }

    // 외부 .txt 파일인 경우: 원본 위치에 plain text로 저장
    if (focusedTab.fileFormat === "txt" && focusedTab.sourceFilePath) {
      const noteApi = hwanNote.note;
      if (!noteApi?.saveTxt) return;

      try {
        await noteApi.saveTxt(focusedTab.sourceFilePath, focusedTab.plainText);
        markTabSaved(focusedTab.id);
      } catch (error) {
        console.error("Save txt failed:", error);
      }
      return;
    }

    const noteApi = hwanNote.note;

    if (!noteApi?.autoSave) {
      window.localStorage.setItem(getDraftKey(focusedTab.id), focusedTab.content);
      markTabSaved(focusedTab.id);
      return;
    }

    try {
      const isTxtWithoutSource = focusedTab.fileFormat === "txt" && !focusedTab.sourceFilePath;
      const markdown = isTxtWithoutSource
        ? focusedTab.plainText.trimEnd() + "\n"
        : toMarkdownDocument(
            focusedTab.title,
            focusedTab.plainText,
            focusedTab.content,
            t("common.untitled")
          );
      await noteApi.autoSave(
        focusedTab.id,
        focusedTab.title,
        markdown,
        normalizeFolderPath(focusedTab.folderPath),
        focusedTab.isTitleManual
      );
      markTabSaved(focusedTab.id);
    } catch (error) {
      console.error("Auto-save failed:", error);
    }
  }, [focusedTab, markTabSaved, t]);

  const handleSaveAsAndCloseTab = useCallback(async (tabId: string) => {
    const tab = tabById.get(tabId);
    if (!tab) {
      return;
    }

    const noteApi = hwanNote.note;
    if (!noteApi?.pickSavePath) {
      return;
    }

    const { extension, content } = toTabSaveAsContent(tab, t("common.untitled"));
    const fallbackTitle = t("common.untitled");
    const title = tab.title.trim() || fallbackTitle;
    const path = await noteApi.pickSavePath(
      t("titlebar.closeDirty.saveAsClose"),
      `${title}.${extension}`,
      extension
    );

    if (!path) {
      return;
    }

    try {
      if (extension === "txt") {
        if (!noteApi.saveTxt) {
          return;
        }
        await noteApi.saveTxt(path, content);
      } else {
        await noteApi.save(path, content);
      }
      closeTab(tabId);
    } catch (error) {
      console.error("Save As failed:", error);
    }
  }, [closeTab, t, tabById]);

  const handleBrowseAutoSaveDir = useCallback(async () => {
    await handleManualSave();
    const settingsApi = hwanNote.settings;
    if (!settingsApi) return;

    const selected = await settingsApi.browseAutoSaveDir();
    if (!selected) return;

    try {
      const result = await settingsApi.setAutoSaveDir(selected);
      setAutoSaveDir(result.effectiveDir);
      setAutoSaveDirIsDefault(result.isDefault);

      const noteApi = hwanNote.note;
      if (noteApi?.loadAll) {
        const loaded = await noteApi.loadAll();
        hydrateLoadedNotes(loaded);
      }
    } catch (error) {
      console.error("Failed to set auto-save directory:", error);
    }
  }, [handleManualSave, hydrateLoadedNotes]);

  const handleResetAutoSaveDir = useCallback(async () => {
    await handleManualSave();
    const settingsApi = hwanNote.settings;
    if (!settingsApi) return;

    try {
      const result = await settingsApi.setAutoSaveDir(null);
      setAutoSaveDir(result.effectiveDir);
      setAutoSaveDirIsDefault(result.isDefault);

      const noteApi = hwanNote.note;
      if (noteApi?.loadAll) {
        const loaded = await noteApi.loadAll();
        hydrateLoadedNotes(loaded);
      }
    } catch (error) {
      console.error("Failed to reset auto-save directory:", error);
    }
  }, [handleManualSave, hydrateLoadedNotes]);

  const handleCloudSyncChange = useCallback(async (provider: string | null) => {
    await handleManualSave();
    try {
      if (provider) {
        const result = await hwanNote.cloud.enable(provider);
        setCloudSyncProvider(result.provider);
        setAutoSaveDir(result.effectiveDir);
        setAutoSaveDirIsDefault(false);
      } else {
        const result = await hwanNote.cloud.disable();
        setCloudSyncProvider(null);
        setAutoSaveDir(result.effectiveDir);
        setAutoSaveDirIsDefault(true);
      }
      const loaded = await hwanNote.note.loadAll();
      hydrateLoadedNotes(loaded);
      const providers = await hwanNote.cloud.detectProviders();
      setCloudProviders(providers);
    } catch (error) {
      console.error("Failed to change cloud sync:", error);
    }
  }, [handleManualSave, hydrateLoadedNotes]);

  useAutoSave({
    value: focusedTab?.content ?? "",
    enabled: Boolean(focusedTab?.isDirty),
    delay: 1000,
    onSave: handleManualSave
  });

  useEffect(() => {
    const settingsApi = hwanNote.settings;
    if (!settingsApi?.getAutoSaveDir) {
      return;
    }

    void settingsApi.getAutoSaveDir().then((result) => {
      setAutoSaveDir(result.effectiveDir);
      setAutoSaveDirIsDefault(result.isDefault);
    }).catch(() => {
      setAutoSaveDir("");
    });
  }, []);

  useEffect(() => {
    void hwanNote.cloud.status().then((s) => {
      setCloudSyncProvider(s.provider);
    }).catch(() => { /* ignore */ });
    void hwanNote.cloud.detectProviders().then((providers) => {
      setCloudProviders(providers);
    }).catch(() => { /* ignore */ });
  }, []);

  useEffect(() => {
    const unlisten = hwanNote.cloud.onFolderMissing((data) => {
      window.alert(
        `${t("settings.cloudSyncFolderMissing")}\n${t("settings.cloudSyncFolderMissingDetail", { path: data.expectedPath })}`
      );
    });
    return () => unlisten();
  }, [t]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyCurrentTheme = () => {
      applyTheme(resolveTheme(themeMode, media.matches));
    };

    applyCurrentTheme();

    if (themeMode !== "system") {
      return;
    }

    media.addEventListener("change", applyCurrentTheme);
    return () => media.removeEventListener("change", applyCurrentTheme);
  }, [themeMode]);

  const handleShortcutChange = useCallback((action: ShortcutAction, combo: ShortcutCombo) => {
    const validation = validateShortcutAssignment(action, combo, shortcuts);
    if (!validation.ok) {
      return validation;
    }

    setShortcuts((prev) => ({
      ...prev,
      [action]: combo
    }));
    return validation;
  }, [shortcuts]);

  const handleShortcutReset = useCallback(() => {
    setShortcuts(createDefaultShortcuts());
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-shortcut-capture='true']")) {
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const paneElement = (target?.closest("[data-pane]") ?? activeElement?.closest("[data-pane]")) as HTMLElement | null;
      const paneAttr = paneElement?.dataset.pane;
      if (paneAttr === "primary" || paneAttr === "secondary") {
        focusPane(paneAttr);
      }

      const isEditorFocus = Boolean(
        target?.closest(".note-editor, .editor-shell") ?? activeElement?.closest(".note-editor")
      );

      for (const action of SHORTCUT_ACTIONS) {
        const shortcut = shortcuts[action];
        if (!matchesShortcut(event, shortcut)) {
          continue;
        }

        const { context } = SHORTCUT_DEFINITIONS[action];
        if (!isContextMatch(context, isEditorFocus)) {
          continue;
        }

        switch (action) {
          case "toggleSidebar":
            event.preventDefault();
            toggleSidebar();
            return;

          case "nextTab":
            event.preventDefault();
            handleCycleTabInFocusedPane(1);
            return;

          case "prevTab":
            event.preventDefault();
            handleCycleTabInFocusedPane(-1);
            return;

          case "saveNote":
            event.preventDefault();
            void handleManualSave();
            return;

          case "newNote":
            event.preventDefault();
            handleCreateTabInFocusedPane();
            return;

          case "closeTab":
            if (!focusedTabId) {
              return;
            }

            event.preventDefault();
            closeTab(focusedTabId);
            return;

          case "toggleBold":
            if (!focusedEditor) {
              return;
            }

            event.preventDefault();
            focusedEditor.chain().focus().toggleBold().run();
            return;

          case "toggleItalic":
            if (!focusedEditor) {
              return;
            }

            event.preventDefault();
            focusedEditor.chain().focus().toggleItalic().run();
            return;

          case "toggleChecklist":
            if (!focusedEditor) {
              return;
            }

            event.preventDefault();
            focusedEditor.chain().focus().toggleTaskList().run();
            return;

          case "insertToggleBlock":
            if (!focusedEditor) {
              return;
            }

            event.preventDefault();
            focusedEditor.chain().focus().insertToggleBlock().run();
            return;

          case "insertDateTime": {
            if (!focusedEditor) {
              return;
            }

            event.preventDefault();
            const now = new Date();
            const dateTimeStr = now.toLocaleString(localeTag, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false
            });
            focusedEditor.chain().focus().insertContent(dateTimeStr).run();
            return;
          }

          default:
            return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeTab,
    focusPane,
    focusedEditor,
    focusedTabId,
    handleCreateTabInFocusedPane,
    handleCycleTabInFocusedPane,
    handleManualSave,
    localeTag,
    settingsOpen,
    shortcuts,
    toggleSidebar
  ]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    const onEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        restoreEditorFocus(focusedEditor);
      }
    };

    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [focusedEditor, settingsOpen]);

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();
      setEditorFontSize((prev) => {
        const delta = event.deltaY < 0 ? 1 : -1;
        return normalizeEditorFontSize(prev + delta);
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === "0") {
        event.preventDefault();
        setEditorFontSize(DEFAULT_EDITOR_FONT_SIZE);
      }
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    const winApi = hwanNote.window;
    if (!winApi) {
      return;
    }

    const nextState = await winApi.toggleMaximize();
    setIsMaximized(nextState);
  }, []);

  const zoomPercent = useMemo(
    () => Math.round((editorFontSize / DEFAULT_EDITOR_FONT_SIZE) * 100),
    [editorFontSize]
  );

  const themeLabel = useMemo(() => {
    if (themeMode === "system") {
      return t("theme.system");
    }
    if (themeMode === "dark") {
      return t("theme.dark");
    }
    return t("theme.light");
  }, [themeMode, t]);
  const splitDropLeftLabel = language === "ko" ? "왼쪽에 놓아 분할" : "Drop to split left";
  const splitDropRightLabel = language === "ko" ? "오른쪽에 놓아 분할" : "Drop to split right";

  return (
    <div className="app-shell">
      <TitleBar
        tabs={openTabs}
        activeTabId={activeTabId}
        isMaximized={isMaximized}
        onToggleSidebar={toggleSidebar}
        onSelectTab={handleSelectTabInFocusedPane}
        onCloseTab={closeTab}
        onSaveAsAndCloseTab={(tabId) => void handleSaveAsAndCloseTab(tabId)}
        onCloseOtherTabs={closeOtherTabs}
        onTogglePinTab={togglePinTab}
        onReorderTabs={reorderTabs}
        onDropTabOutside={handleDropTabOutside}
        onTabDragPreview={handleTabDragPreview}
        onTabDragEnd={handleTabDragEnd}
        onCreateTab={handleCreateTabInFocusedPane}
        onMinimize={() => void hwanNote.window.minimize()}
        onToggleMaximize={() => void handleToggleMaximize()}
        onCloseWindow={() => void hwanNote.window.close()}
      />

      <Toolbar
        editor={focusedEditor}
        activeTitle={focusedTab?.title ?? ""}
        activeTabId={focusedTab?.id ?? ""}
        isTitleManual={Boolean(focusedTab?.isTitleManual)}
        onChangeTitle={(title) => {
          if (!focusedTabId) return;
          setTabTitle(focusedTabId, title);
        }}
        lastSavedAt={focusedTab?.lastSavedAt ?? 0}
        onOpenSettings={() => setSettingsOpen(true)}
        onImportTxt={() => void handleImportTxt()}
      />

      <div className="workspace">
        <Sidebar
          visible={sidebarVisible}
          activeTabId={activeTabId}
          folders={folderPaths}
          tags={tags}
          notes={filteredNotes}
          selectedFolder={selectedFolder}
          selectedTag={selectedTag}
          searchQuery={searchQuery}
          searchMode={searchMode}
          sortMode={sortMode}
          onSearchChange={setSearchQuery}
          onSearchModeChange={setSearchMode}
          onSelectFolder={setSelectedFolder}
          onSelectTag={setSelectedTag}
          onSortModeChange={setSortMode}
          onSelectNote={handleSelectNoteInFocusedPane}
          onTogglePinNote={togglePinTab}
          onDeleteNote={(id) => {
            void (async () => {
              try {
                await hwanNote.note.delete(id);
                removeNote(id);
              } catch (error) {
                console.error("Failed to delete note:", error);
              }
            })();
          }}
          onMoveNoteToFolder={(id, folderPath) => {
            moveTabToFolder(id, normalizeFolderPath(folderPath));
          }}
          onCreateFolder={(folderPath) => {
            const normalized = normalizeFolderPath(folderPath);
            setCustomFolders((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
          }}
          onRenameFolder={(from, to) => {
            const normalizedFrom = normalizeFolderPath(from);
            const normalizedTo = normalizeFolderPath(to);

            setCustomFolders((prev) => {
              const next = prev.map((path) => replaceFolderPrefix(path, normalizedFrom, normalizedTo));
              return Array.from(new Set(next));
            });

            renameFolderPath(normalizedFrom, normalizedTo);

            if (selectedFolder) {
              setSelectedFolder(replaceFolderPrefix(selectedFolder, normalizedFrom, normalizedTo));
            }
          }}
          onDeleteFolder={(folderPath) => {
            const normalized = normalizeFolderPath(folderPath);

            setCustomFolders((prev) =>
              prev.filter((path) => path !== normalized && !path.startsWith(`${normalized}/`))
            );
            clearFolderPath(normalized);

            if (selectedFolder && (selectedFolder === normalized || selectedFolder.startsWith(`${normalized}/`))) {
              setSelectedFolder(null);
            }
          }}
        />

        <main ref={editorWorkspaceRef} className={`editor-workspace ${isSplit ? "split" : ""}`}>
          {isSplit && primaryTab && secondaryTab ? (
            <>
              <section
                className={`editor-pane ${focusedPane === "primary" ? "focused" : ""}`}
                data-pane="primary"
                style={{ flexBasis: `${splitRatio * 100}%` }}
                onMouseDown={() => focusPane("primary")}
              >
                <Editor
                  key={`primary-${primaryTab.id}`}
                  content={primaryTab.content}
                  tabSize={tabSize}
                  spellcheck={editorSpellcheck}
                  autofocus={focusedPane === "primary"}
                  onFocus={() => focusPane("primary")}
                  onEditorReady={(nextEditor) => {
                    setPaneEditors((prev) => ({ ...prev, primary: nextEditor }));
                  }}
                  onChange={(content, plainText) => handleEditorChange("primary", content, plainText)}
                  onCursorChange={(line, column, chars) => handleCursorChange("primary", line, column, chars)}
                />
              </section>

              <div className="split-divider" onPointerDown={handleSplitDividerPointerDown} />

              <section
                className={`editor-pane ${focusedPane === "secondary" ? "focused" : ""}`}
                data-pane="secondary"
                style={{ flexBasis: `${(1 - splitRatio) * 100}%` }}
                onMouseDown={() => focusPane("secondary")}
              >
                <Editor
                  key={`secondary-${secondaryTab.id}`}
                  content={secondaryTab.content}
                  tabSize={tabSize}
                  spellcheck={editorSpellcheck}
                  autofocus={focusedPane === "secondary"}
                  onFocus={() => focusPane("secondary")}
                  onEditorReady={(nextEditor) => {
                    setPaneEditors((prev) => ({ ...prev, secondary: nextEditor }));
                  }}
                  onChange={(content, plainText) => handleEditorChange("secondary", content, plainText)}
                  onCursorChange={(line, column, chars) => handleCursorChange("secondary", line, column, chars)}
                />
              </section>
            </>
          ) : primaryTab ? (
            <section className="editor-pane focused" data-pane="primary" onMouseDown={() => focusPane("primary")}>
              <Editor
                key={`primary-${primaryTab.id}`}
                content={primaryTab.content}
                tabSize={tabSize}
                spellcheck={editorSpellcheck}
                autofocus
                onFocus={() => focusPane("primary")}
                onEditorReady={(nextEditor) => {
                  setPaneEditors((prev) => ({ ...prev, primary: nextEditor }));
                }}
                onChange={(content, plainText) => handleEditorChange("primary", content, plainText)}
                onCursorChange={(line, column, chars) => handleCursorChange("primary", line, column, chars)}
              />
            </section>
          ) : null}
          {splitDropTarget ? (
            <div className="split-drop-preview" aria-hidden="true">
              <div className={`split-drop-zone ${splitDropTarget === "primary" ? "active" : ""}`}>
                <span>{splitDropLeftLabel}</span>
              </div>
              <div className={`split-drop-zone ${splitDropTarget === "secondary" ? "active" : ""}`}>
                <span>{splitDropRightLabel}</span>
              </div>
            </div>
          ) : null}
        </main>
      </div>

      <StatusBar
        line={cursor.line}
        column={cursor.column}
        chars={cursor.chars}
        themeLabel={themeLabel}
        zoomPercent={zoomPercent}
        fileFormat={focusedTab?.fileFormat ?? "md"}
        onToggleFileFormat={() => {
          if (!focusedTab) return;
          if (focusedTab.fileFormat === "md") {
            const hasFormatting =
              /<ul[^>]*data-type=(['"])taskList\1/i.test(focusedTab.content) ||
              /<details/i.test(focusedTab.content) ||
              /<strong/i.test(focusedTab.content) ||
              /<em>/i.test(focusedTab.content) ||
              /<s>/i.test(focusedTab.content) ||
              /<a\s/i.test(focusedTab.content) ||
              /<h[1-3]/i.test(focusedTab.content);
            if (hasFormatting && !window.confirm(t("status.confirmSwitchToTxt"))) {
              return;
            }
          }
          toggleFileFormat(focusedTab.id);
        }}
        cloudSyncProvider={cloudSyncProvider}
      />

      <SettingsPanel
        open={settingsOpen}
        themeMode={themeMode}
        editorLineHeight={editorLineHeight}
        editorFontSize={editorFontSize}
        editorSpellcheck={editorSpellcheck}
        tabSize={tabSize}
        autoSaveDir={autoSaveDir}
        autoSaveDirIsDefault={autoSaveDirIsDefault}
        onBrowseAutoSaveDir={() => void handleBrowseAutoSaveDir()}
        onResetAutoSaveDir={() => void handleResetAutoSaveDir()}
        cloudSyncProvider={cloudSyncProvider}
        cloudProviders={cloudProviders}
        noteCount={allNotes.length}
        onCloudSyncChange={handleCloudSyncChange}
        shortcuts={shortcuts}
        onThemeModeChange={setThemeMode}
        onEditorLineHeightChange={(value) => setEditorLineHeight(normalizeEditorLineHeight(value))}
        onEditorFontSizeChange={(value) => setEditorFontSize(normalizeEditorFontSize(value))}
        onEditorSpellcheckChange={setEditorSpellcheck}
        onTabSizeChange={(size) => setTabSize(VALID_TAB_SIZES.includes(size) ? size : DEFAULT_TAB_SIZE)}
        onShortcutChange={handleShortcutChange}
        onResetShortcuts={handleShortcutReset}
        onClose={() => {
          setSettingsOpen(false);
          restoreEditorFocus(focusedEditor);
        }}
      />

      <UpdateToast language={language} />
    </div>
  );
}
