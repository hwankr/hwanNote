import { Editor as TiptapEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "./components/Editor";
import SettingsPanel, { type ThemeMode } from "./components/SettingsPanel";
import Sidebar, { type SidebarTag } from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import { useAutoSave } from "./hooks/useAutoSave";
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
const SHORTCUTS_KEY = "hwan-note:shortcuts";
const THEME_MODE_KEY = "hwan-note:theme-mode";

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

function toMarkdownDocument(title: string, plainText: string) {
  const normalizedBody = plainText.replace(/\r?\n/g, "\n").trimEnd();
  if (normalizedBody) {
    return `${normalizedBody}\n`;
  }

  const fallbackTitle = title.trim() || "제목 없음";
  return `# ${fallbackTitle}\n`;
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

export default function App() {
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
  const markTabSaved = useNoteStore((state) => state.markTabSaved);
  const toggleSidebar = useNoteStore((state) => state.toggleSidebar);

  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1, chars: 0 });
  const [isMaximized, setIsMaximized] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("updated");
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [autoSaveDir, setAutoSaveDir] = useState("");
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(() => createDefaultShortcuts());

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
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [noteTags]);

  const folderPaths = useMemo(() => {
    const merged = new Set<string>(["inbox"]);

    customFolders.forEach((path) => merged.add(normalizeFolderPath(path)));
    tabs.forEach((tab) => merged.add(normalizeFolderPath(tab.folderPath)));

    return Array.from(merged).sort((a, b) => a.localeCompare(b, "ko"));
  }, [customFolders, tabs]);

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
        const haystack = `${tab.title} ${tab.plainText}`.toLowerCase();
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
          return a.title.localeCompare(b.title, "ko");
        case "created":
          return b.createdAt - a.createdAt;
        case "updated":
        default:
          return b.updatedAt - a.updatedAt;
      }
    });
  }, [tabs, selectedFolder, selectedTag, searchQuery, noteTags, sortMode]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CUSTOM_FOLDERS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const normalized = parsed
            .filter((entry): entry is string => typeof entry === "string")
            .map((path) => normalizeFolderPath(path));

          setCustomFolders(Array.from(new Set(normalized)));
        }
      }
    } catch (error) {
      console.warn("Failed to load custom folders", error);
    }

    const savedThemeMode = window.localStorage.getItem(THEME_MODE_KEY);
    if (savedThemeMode === "light" || savedThemeMode === "dark" || savedThemeMode === "system") {
      setThemeMode(savedThemeMode);
    }

    try {
      const rawShortcuts = window.localStorage.getItem(SHORTCUTS_KEY);
      if (!rawShortcuts) {
        return;
      }

      const parsed = JSON.parse(rawShortcuts) as unknown;
      setShortcuts(parseShortcutMap(parsed));
    } catch (error) {
      console.warn("Failed to load shortcuts", error);
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
            content: note.content,
            plainText: note.plainText,
            isDirty: false,
            isPinned: false,
            folderPath: normalizeFolderPath(note.folderPath),
            createdAt: note.createdAt,
            updatedAt: note.updatedAt
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

  const handleManualSave = useCallback(async () => {
    if (!activeTab) {
      return;
    }

    const noteApi = window.hwanNote?.note;

    if (!noteApi?.autoSave) {
      window.localStorage.setItem(getDraftKey(activeTab.id), activeTab.content);
      markTabSaved(activeTab.id);
      return;
    }

    try {
      const markdown = toMarkdownDocument(activeTab.title, activeTab.plainText);
      await noteApi.autoSave(activeTab.id, activeTab.title, markdown, normalizeFolderPath(activeTab.folderPath));
      markTabSaved(activeTab.id);
    } catch (error) {
      console.error("Auto-save failed:", error);
    }
  }, [activeTab, markTabSaved]);

  useAutoSave({
    value: activeTab?.content ?? "",
    enabled: Boolean(activeTab?.isDirty),
    delay: 1000,
    onSave: handleManualSave
  });

  useEffect(() => {
    const noteApi = window.hwanNote?.note;
    if (!noteApi?.getAutoSaveDir) {
      return;
    }

    void noteApi.getAutoSaveDir().then(setAutoSaveDir).catch(() => {
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

      const isEditorFocus = Boolean(target?.closest(".note-editor"));

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
      }
    };

    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [settingsOpen]);

  const handleToggleMaximize = useCallback(async () => {
    const winApi = window.hwanNote?.window;
    if (!winApi) {
      return;
    }

    const nextState = await winApi.toggleMaximize();
    setIsMaximized(nextState);
  }, []);

  const themeLabel = useMemo(() => {
    if (themeMode === "system") {
      return "Theme: System";
    }
    if (themeMode === "dark") {
      return "Theme: Dark";
    }
    return "Theme: Light";
  }, [themeMode]);

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

      <Toolbar editor={editor} onOpenSettings={() => setSettingsOpen(true)} />

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
          sortMode={sortMode}
          onSearchChange={setSearchQuery}
          onSelectFolder={setSelectedFolder}
          onSelectTag={setSelectedTag}
          onSortModeChange={setSortMode}
          onSelectNote={setActiveTab}
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
              onEditorReady={setEditor}
              onChange={(content, plainText) => updateActiveContent(content, plainText)}
              onCursorChange={(line, column, chars) => setCursor({ line, column, chars })}
            />
          ) : null}
        </main>
      </div>

      <StatusBar line={cursor.line} column={cursor.column} chars={cursor.chars} themeLabel={themeLabel} />

      <SettingsPanel
        open={settingsOpen}
        themeMode={themeMode}
        autoSaveDir={autoSaveDir}
        shortcuts={shortcuts}
        onThemeModeChange={setThemeMode}
        onShortcutChange={handleShortcutChange}
        onResetShortcuts={handleShortcutReset}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
