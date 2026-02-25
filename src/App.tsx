import { Editor as TiptapEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Editor, { restoreEditorFocus } from "./components/Editor";
import SettingsPanel, { type ThemeMode } from "./components/SettingsPanel";
import Sidebar, { type SidebarTag } from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
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
import { useNoteStore } from "./stores/noteStore";

const CUSTOM_FOLDERS_KEY = "hwan-note:custom-folders";
const EDITOR_FONT_SIZE_KEY = "hwan-note:editor-font-size";
const EDITOR_LINE_HEIGHT_KEY = "hwan-note:editor-line-height";
const SHORTCUTS_KEY = "hwan-note:shortcuts";
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

type SortMode = "updated" | "title" | "created";

function getDraftKey(tabId: string) {
  return `hwan-note:draft:${tabId}`;
}

function normalizeFolderPath(path: string) {
  const normalized = path
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");

  return normalized || "inbox";
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

export default function App() {
  const { t, localeTag } = useI18n();
  const tabs = useNoteStore((state) => state.tabs);
  const activeTabId = useNoteStore((state) => state.activeTabId);
  const sidebarVisible = useNoteStore((state) => state.sidebarVisible);
  const createTab = useNoteStore((state) => state.createTab);
  const hydrateTabs = useNoteStore((state) => state.hydrateTabs);
  const setActiveTab = useNoteStore((state) => state.setActiveTab);
  const closeTab = useNoteStore((state) => state.closeTab);
  const closeOtherTabs = useNoteStore((state) => state.closeOtherTabs);
  const reorderTabs = useNoteStore((state) => state.reorderTabs);
  const togglePinTab = useNoteStore((state) => state.togglePinTab);
  const moveTabToFolder = useNoteStore((state) => state.moveTabToFolder);
  const renameFolderPath = useNoteStore((state) => state.renameFolderPath);
  const clearFolderPath = useNoteStore((state) => state.clearFolderPath);
  const activateNextTab = useNoteStore((state) => state.activateNextTab);
  const activatePrevTab = useNoteStore((state) => state.activatePrevTab);
  const updateActiveContent = useNoteStore((state) => state.updateActiveContent);
  const setActiveTitle = useNoteStore((state) => state.setActiveTitle);
  const markTabSaved = useNoteStore((state) => state.markTabSaved);
  const toggleFileFormat = useNoteStore((state) => state.toggleFileFormat);
  const toggleSidebar = useNoteStore((state) => state.toggleSidebar);
  const addImportedTab = useNoteStore((state) => state.addImportedTab);

  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1, chars: 0 });
  const [isMaximized, setIsMaximized] = useState(false);

  const handleCursorChange = useCallback((line: number, column: number, chars: number) => {
    setCursor({ line, column, chars });
  }, []);

  const handleEditorChange = useCallback((content: string, plainText: string) => {
    updateActiveContent(content, plainText);
  }, [updateActiveContent]);

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
  const [autoSaveDir, setAutoSaveDir] = useState("");
  const [autoSaveDirIsDefault, setAutoSaveDirIsDefault] = useState(true);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(() => createDefaultShortcuts());
  const [tabSize, setTabSize] = useState(DEFAULT_TAB_SIZE);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  );

  const noteTags = useMemo(() => {
    const map = new Map<string, string[]>();
    tabs.forEach((tab) => {
      map.set(tab.id, extractTags(tab.plainText));
    });
    return map;
  }, [tabs]);

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
    const merged = new Set<string>(["inbox"]);

    customFolders.forEach((path) => merged.add(normalizeFolderPath(path)));
    tabs.forEach((tab) => merged.add(normalizeFolderPath(tab.folderPath)));

    return Array.from(merged).sort((a, b) => a.localeCompare(b, localeTag));
  }, [customFolders, localeTag, tabs]);

  const filteredNotes = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    const filtered = tabs.filter((tab) => {
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
  }, [tabs, selectedFolder, selectedTag, searchQuery, searchMode, noteTags, sortMode, localeTag]);

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
    const noteApi = window.hwanNote?.note;
    if (!noteApi?.loadAll) {
      return;
    }

    let disposed = false;

    const run = async () => {
      try {
        const loaded = await noteApi.loadAll();
        if (disposed || loaded.length === 0) {
          return;
        }

        hydrateTabs(
          loaded.map((note) => ({
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
          }))
        );

        const loadedFolders = loaded
          .map((note) => normalizeFolderPath(note.folderPath))
          .filter((folderPath) => folderPath !== "inbox");

        setCustomFolders((prev) => Array.from(new Set([...prev, ...loadedFolders])));
      } catch (error) {
        console.error("Failed to load notes from file system:", error);
      }
    };

    void run();

    return () => {
      disposed = true;
    };
  }, [hydrateTabs]);

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

  const handleImportTxt = useCallback(async () => {
    const noteApi = window.hwanNote?.note;
    if (!noteApi?.importTxt) return;

    const imported = await noteApi.importTxt();
    if (!imported || imported.length === 0) return;

    for (const { title, content, filePath } of imported) {
      const escapeHtml = (text: string) =>
        text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      const html = content
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>"))
        .join("");

      addImportedTab(title, html || "<p></p>", content.replace(/\r?\n/g, "\n"), filePath);
    }
  }, [addImportedTab]);

  const handleManualSave = useCallback(async () => {
    if (!activeTab) {
      return;
    }

    // 외부 .txt 파일인 경우: 원본 위치에 plain text로 저장
    if (activeTab.fileFormat === "txt" && activeTab.sourceFilePath) {
      const noteApi = window.hwanNote?.note;
      if (!noteApi?.saveTxt) return;

      try {
        await noteApi.saveTxt(activeTab.sourceFilePath, activeTab.plainText);
        markTabSaved(activeTab.id);
      } catch (error) {
        console.error("Save txt failed:", error);
      }
      return;
    }

    const noteApi = window.hwanNote?.note;

    if (!noteApi?.autoSave) {
      window.localStorage.setItem(getDraftKey(activeTab.id), activeTab.content);
      markTabSaved(activeTab.id);
      return;
    }

    try {
      const isTxtWithoutSource = activeTab.fileFormat === "txt" && !activeTab.sourceFilePath;
      const markdown = isTxtWithoutSource
        ? activeTab.plainText.trimEnd() + "\n"
        : toMarkdownDocument(
            activeTab.title,
            activeTab.plainText,
            activeTab.content,
            t("common.untitled")
          );
      await noteApi.autoSave(
        activeTab.id,
        activeTab.title,
        markdown,
        normalizeFolderPath(activeTab.folderPath),
        activeTab.isTitleManual
      );
      markTabSaved(activeTab.id);
    } catch (error) {
      console.error("Auto-save failed:", error);
    }
  }, [activeTab, markTabSaved, t]);

  const handleBrowseAutoSaveDir = useCallback(async () => {
    await handleManualSave();
    const settingsApi = window.hwanNote?.settings;
    if (!settingsApi) return;

    const selected = await settingsApi.browseAutoSaveDir();
    if (!selected) return;

    try {
      const result = await settingsApi.setAutoSaveDir(selected);
      setAutoSaveDir(result.effectiveDir);
      setAutoSaveDirIsDefault(result.isDefault);

      const noteApi = window.hwanNote?.note;
      if (noteApi?.loadAll) {
        const loaded = await noteApi.loadAll();
        hydrateTabs(
          loaded.map((note) => ({
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
          }))
        );
      }
    } catch (error) {
      console.error("Failed to set auto-save directory:", error);
    }
  }, [handleManualSave, hydrateTabs]);

  const handleResetAutoSaveDir = useCallback(async () => {
    await handleManualSave();
    const settingsApi = window.hwanNote?.settings;
    if (!settingsApi) return;

    try {
      const result = await settingsApi.setAutoSaveDir(null);
      setAutoSaveDir(result.effectiveDir);
      setAutoSaveDirIsDefault(result.isDefault);

      const noteApi = window.hwanNote?.note;
      if (noteApi?.loadAll) {
        const loaded = await noteApi.loadAll();
        hydrateTabs(
          loaded.map((note) => ({
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
          }))
        );
      }
    } catch (error) {
      console.error("Failed to reset auto-save directory:", error);
    }
  }, [handleManualSave, hydrateTabs]);

  useAutoSave({
    value: activeTab?.content ?? "",
    enabled: Boolean(activeTab?.isDirty),
    delay: 1000,
    onSave: handleManualSave
  });

  useEffect(() => {
    const settingsApi = window.hwanNote?.settings;
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
            activateNextTab();
            return;

          case "prevTab":
            event.preventDefault();
            activatePrevTab();
            return;

          case "saveNote":
            event.preventDefault();
            void handleManualSave();
            return;

          case "newNote":
            event.preventDefault();
            createTab();
            return;

          case "closeTab":
            if (!activeTab) {
              return;
            }

            event.preventDefault();
            closeTab(activeTab.id);
            return;

          case "toggleBold":
            if (!editor) {
              return;
            }

            event.preventDefault();
            editor.chain().focus().toggleBold().run();
            return;

          case "toggleItalic":
            if (!editor) {
              return;
            }

            event.preventDefault();
            editor.chain().focus().toggleItalic().run();
            return;

          case "toggleChecklist":
            if (!editor) {
              return;
            }

            event.preventDefault();
            editor.chain().focus().toggleTaskList().run();
            return;

          case "insertToggleBlock":
            if (!editor) {
              return;
            }

            event.preventDefault();
            editor.chain().focus().insertToggleBlock().run();
            return;

          case "insertDateTime": {
            if (!editor) {
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
            editor.chain().focus().insertContent(dateTimeStr).run();
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
    activeTab,
    activateNextTab,
    activatePrevTab,
    closeTab,
    createTab,
    editor,
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
        restoreEditorFocus(editor);
      }
    };

    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [editor, settingsOpen]);

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
    const winApi = window.hwanNote?.window;
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

  return (
    <div className="app-shell">
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        isMaximized={isMaximized}
        onToggleSidebar={toggleSidebar}
        onSelectTab={setActiveTab}
        onCloseTab={closeTab}
        onCloseOtherTabs={closeOtherTabs}
        onTogglePinTab={togglePinTab}
        onReorderTabs={reorderTabs}
        onCreateTab={createTab}
        onMinimize={() => void window.hwanNote?.window.minimize()}
        onToggleMaximize={() => void handleToggleMaximize()}
        onCloseWindow={() => void window.hwanNote?.window.close()}
      />

      <Toolbar
        editor={editor}
        activeTitle={activeTab?.title ?? ""}
        activeTabId={activeTab?.id ?? ""}
        isTitleManual={Boolean(activeTab?.isTitleManual)}
        onChangeTitle={setActiveTitle}
        lastSavedAt={activeTab?.lastSavedAt ?? 0}
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
          onSelectNote={setActiveTab}
          onTogglePinNote={togglePinTab}
          onDeleteNote={(id) => {
            const tab = tabs.find((t) => t.id === id);
            if (!tab) return;
            closeTab(id);
            if (tab.lastSavedAt > 0) {
              void window.hwanNote?.note.delete(id);
            }
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
            if (normalized === "inbox") {
              return;
            }

            setCustomFolders((prev) =>
              prev.filter((path) => path !== normalized && !path.startsWith(`${normalized}/`))
            );
            clearFolderPath(normalized);

            if (selectedFolder && (selectedFolder === normalized || selectedFolder.startsWith(`${normalized}/`))) {
              setSelectedFolder(null);
            }
          }}
        />

        <main className="editor-workspace">
          {activeTab ? (
            <Editor
              key={activeTab.id}
              content={activeTab.content}
              tabSize={tabSize}
              onEditorReady={setEditor}
              onChange={handleEditorChange}
              onCursorChange={handleCursorChange}
            />
          ) : null}
        </main>
      </div>

      <StatusBar
        line={cursor.line}
        column={cursor.column}
        chars={cursor.chars}
        themeLabel={themeLabel}
        zoomPercent={zoomPercent}
        fileFormat={activeTab?.fileFormat ?? "md"}
        onToggleFileFormat={() => {
          if (!activeTab) return;
          if (activeTab.fileFormat === "md") {
            const hasFormatting =
              /<ul[^>]*data-type=(['"])taskList\1/i.test(activeTab.content) ||
              /<details/i.test(activeTab.content) ||
              /<strong/i.test(activeTab.content) ||
              /<em>/i.test(activeTab.content) ||
              /<s>/i.test(activeTab.content) ||
              /<a\s/i.test(activeTab.content) ||
              /<h[1-3]/i.test(activeTab.content);
            if (hasFormatting && !window.confirm(t("status.confirmSwitchToTxt"))) {
              return;
            }
          }
          toggleFileFormat(activeTab.id);
        }}
      />

      <SettingsPanel
        open={settingsOpen}
        themeMode={themeMode}
        editorLineHeight={editorLineHeight}
        editorFontSize={editorFontSize}
        tabSize={tabSize}
        autoSaveDir={autoSaveDir}
        autoSaveDirIsDefault={autoSaveDirIsDefault}
        onBrowseAutoSaveDir={() => void handleBrowseAutoSaveDir()}
        onResetAutoSaveDir={() => void handleResetAutoSaveDir()}
        shortcuts={shortcuts}
        onThemeModeChange={setThemeMode}
        onEditorLineHeightChange={(value) => setEditorLineHeight(normalizeEditorLineHeight(value))}
        onEditorFontSizeChange={(value) => setEditorFontSize(normalizeEditorFontSize(value))}
        onTabSizeChange={(size) => setTabSize(VALID_TAB_SIZES.includes(size) ? size : DEFAULT_TAB_SIZE)}
        onShortcutChange={handleShortcutChange}
        onResetShortcuts={handleShortcutReset}
        onClose={() => {
          setSettingsOpen(false);
          restoreEditorFocus(editor);
        }}
      />
    </div>
  );
}
