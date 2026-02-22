import { Editor as TiptapEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "./components/Editor";
import Sidebar, { type SidebarTag } from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import { useAutoSave } from "./hooks/useAutoSave";
import { applyTheme } from "./styles/themes";
import { useNoteStore } from "./stores/noteStore";

const CUSTOM_FOLDERS_KEY = "hwan-note:custom-folders";

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

export default function App() {
  const tabs = useNoteStore((state) => state.tabs);
  const activeTabId = useNoteStore((state) => state.activeTabId);
  const sidebarVisible = useNoteStore((state) => state.sidebarVisible);
  const createTab = useNoteStore((state) => state.createTab);
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
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }

      const normalized = parsed
        .filter((entry): entry is string => typeof entry === "string")
        .map((path) => normalizeFolderPath(path));

      setCustomFolders(Array.from(new Set(normalized)));
    } catch (error) {
      console.warn("Failed to load custom folders", error);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CUSTOM_FOLDERS_KEY, JSON.stringify(customFolders));
  }, [customFolders]);

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
    applyTheme("light");
  }, []);

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    const draft = window.localStorage.getItem(getDraftKey(activeTab.id));
    if (!draft || draft === activeTab.content) {
      return;
    }

    const plainText = draft.replace(/<[^>]+>/g, "").trim();
    updateActiveContent(draft, plainText);
    markTabSaved(activeTab.id);
  }, [activeTab, markTabSaved, updateActiveContent]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      const target = event.target as HTMLElement | null;
      const isEditorFocus = Boolean(target?.closest(".note-editor"));

      if (key === "b" && !event.shiftKey && !isEditorFocus) {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        if (event.shiftKey) {
          activatePrevTab();
          return;
        }

        activateNextTab();
        return;
      }

      if (key === "s") {
        event.preventDefault();
        void handleManualSave();
        return;
      }

      if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        createTab();
        return;
      }

      if (key === "w" && activeTab) {
        event.preventDefault();
        closeTab(activeTab.id);
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
    handleManualSave,
    toggleSidebar
  ]);

  const handleToggleMaximize = useCallback(async () => {
    const winApi = window.hwanNote?.window;
    if (!winApi) {
      return;
    }

    const nextState = await winApi.toggleMaximize();
    setIsMaximized(nextState);
  }, []);

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

      <Toolbar editor={editor} />

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

      <StatusBar line={cursor.line} column={cursor.column} chars={cursor.chars} />
    </div>
  );
}
