import type { JSONContent } from "@tiptap/core";
import { Editor as TiptapEditor } from "@tiptap/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm as confirmDialog, message } from "@tauri-apps/plugin-dialog";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hwanNote,
  type CloudProviderInfo,
  type CloudSyncSource,
  type LoadedNote,
  type NoteLoadResult,
  type NoteStorageSource
} from "./lib/tauriApi";
import Editor, { restoreEditorFocus } from "./components/Editor";
import SettingsPanel, { type ThemeMode } from "./components/SettingsPanel";
import Sidebar, { type AppView, type SidebarTag } from "./components/Sidebar";
import CalendarPage from "./components/calendar/CalendarPage";
import { DEFAULT_WEEK_STARTS_ON, isWeekStart, type WeekStart } from "./lib/calendarRange";
import { ensureCalendarSaved } from "./lib/calendarSaveGuard";
import { useCalendarStore } from "./stores/calendarStore";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import UpdateToast from "./components/UpdateToast";
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
import { normalizeFolderPath } from "./lib/folderPaths";
import { KeyedDebouncer, KeyedSerialTaskQueue } from "./lib/keyedTasks";
import { mergeRecoveredNoteTabs } from "./lib/noteRecovery";
import { mergeReloadedNoteTabs } from "./lib/noteReload";
import { canRunNoteLibraryMutation } from "./lib/noteMutationGuard";
import {
  hasRichTextFormatting,
  markdownToTiptapDocument,
  plainTextToTiptapDocument,
  tiptapDocumentToMarkdown,
  tiptapDocumentToPlainText
} from "./lib/markdown";
import {
  readTabSessionFromStorage,
  useNoteStore,
  type NotePersistence,
  type NoteTab,
  type PersistedTabSession,
  type SavedNoteSnapshot
} from "./stores/noteStore";

const EDITOR_FONT_SIZE_KEY = "hwan-note:editor-font-size";
const EDITOR_LINE_HEIGHT_KEY = "hwan-note:editor-line-height";
const EDITOR_SPELLCHECK_KEY = "hwan-note:editor-spellcheck";
const SHORTCUTS_KEY = "hwan-note:shortcuts";
const SPLIT_RATIO_KEY = "hwan-note:split-ratio";
const TAB_SIZE_KEY = "hwan-note:tab-size";
const THEME_MODE_KEY = "hwan-note:theme-mode";
const WEEK_STARTS_ON_KEY = "hwan-note:week-starts-on";
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
const AUTO_SAVE_DELAY_MS = 1750;
const CLOUD_RECOVERY_POLL_INTERVAL_MS = 1500;
const RECOVERY_TITLE_TOKEN = "__HWAN_NOTE_RECOVERY_TITLE__";

type SortMode = "updated" | "title" | "created";
type PaneId = "primary" | "secondary";
type PaneEditors = Record<PaneId, TiptapEditor | null>;
type PaneCursor = { line: number; column: number; chars: number };
type PaneCursors = Record<PaneId, PaneCursor>;
type CloseDecision = "save" | "discard" | "cancel";

interface ResolveDirtyTabsOptions {
  closeResolvedTabs?: boolean;
}

function getDraftKey(tabId: string) {
  return `hwan-note:draft:${tabId}`;
}

function normalizeIntentPathKey(filePath: string) {
  return filePath.trim().replace(/\\/g, "/").toLowerCase();
}

function toMarkdownDocument(title: string, content: JSONContent, fallbackTitle: string) {
  const normalizedBody = tiptapDocumentToMarkdown(content).replace(/\r?\n/g, "\n");
  if (normalizedBody) {
    return normalizedBody.endsWith("\n") ? normalizedBody : `${normalizedBody}\n`;
  }

  const safeTitle = title.trim() || fallbackTitle;
  return `# ${safeTitle}\n`;
}

function toStoredNoteDocument(
  tab: Pick<NoteTab, "title" | "content" | "plainText" | "fileFormat" | "sourceFilePath">,
  fallbackTitle: string
) {
  if (tab.fileFormat === "txt" && !tab.sourceFilePath) {
    return `${tab.plainText.trimEnd()}\n`;
  }
  return toMarkdownDocument(tab.title, tab.content, fallbackTitle);
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

function normalizeNoteTitle(value: string) {
  return value.trim().slice(0, 50);
}

function normalizePersistedFolders(folders: readonly unknown[]) {
  return Array.from(
    new Set(
      folders
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizeFolderPath)
        .filter(Boolean)
    )
  );
}

function formatRecoveredNoteTitle(template: string, title: string) {
  const tokenIndex = template.indexOf(RECOVERY_TITLE_TOKEN);
  if (tokenIndex < 0) {
    return normalizeNoteTitle(template);
  }

  const prefix = template.slice(0, tokenIndex);
  const suffix = template.slice(tokenIndex + RECOVERY_TITLE_TOKEN.length);
  const titleLength = Math.max(0, 50 - prefix.length - suffix.length);
  return `${prefix}${title.trim().slice(0, titleLength)}${suffix}`.trim().slice(0, 50);
}

function pickDistinctTabId(tabIds: string[], excludedId: string, preferredId?: string | null) {
  if (preferredId && preferredId !== excludedId && tabIds.includes(preferredId)) {
    return preferredId;
  }

  return tabIds.find((id) => id !== excludedId) ?? null;
}

function createSavedSnapshot({
  revision,
  title,
  isTitleManual,
  content,
  plainText,
  folderPath,
  fileFormat,
  sourceFilePath,
  updatedAt,
  lastSavedAt
}: {
  revision: number;
  title: string;
  isTitleManual: boolean;
  content: JSONContent;
  plainText: string;
  folderPath: string;
  fileFormat: NoteTab["fileFormat"];
  sourceFilePath?: string;
  updatedAt: number;
  lastSavedAt: number;
}): SavedNoteSnapshot {
  return {
    revision,
    title,
    isTitleManual,
    content,
    plainText,
    folderPath,
    fileFormat,
    sourceFilePath,
    updatedAt,
    lastSavedAt
  };
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
  const reorderTabs = useNoteStore((state) => state.reorderTabs);
  const removeNote = useNoteStore((state) => state.removeNote);
  const togglePinTabStore = useNoteStore((state) => state.togglePinTab);
  const moveTabToFolder = useNoteStore((state) => state.moveTabToFolder);
  const updateTabContent = useNoteStore((state) => state.updateTabContent);
  const setTabTitle = useNoteStore((state) => state.setTabTitle);
  const markTabSaved = useNoteStore((state) => state.markTabSaved);
  const discardTabChanges = useNoteStore((state) => state.discardTabChanges);
  const toggleFileFormat = useNoteStore((state) => state.toggleFileFormat);
  const toggleSidebar = useNoteStore((state) => state.toggleSidebar);
  const addImportedTab = useNoteStore((state) => state.addImportedTab);

  const [activeView, setActiveView] = useState<AppView>("notes");
  const [noteStorageSource, setNoteStorageSource] = useState<NoteStorageSource>("local");
  const [noteRecoveryPending, setNoteRecoveryPending] = useState(false);

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
  const initialHydrationPromiseRef = useRef<Promise<NoteLoadResult | null> | null>(null);
  const initialHydrationFinalizedRef = useRef(false);
  const guardedFlowRef = useRef(false);
  const allowImmediateCloseRef = useRef(false);
  const pendingTitleDraftsRef = useRef<Record<string, string>>({});
  const autoSaveDebouncerRef = useRef(new KeyedDebouncer<string>());
  const saveQueueRef = useRef(new KeyedSerialTaskQueue<string>());
  const saveTabRef = useRef<((tabId: string) => Promise<boolean>) | null>(null);
  const noteStorageSourceRef = useRef<NoteStorageSource>("local");
  const noteWritesSuspendedRef = useRef(false);
  const recoveryInFlightRef = useRef(false);
  const recoveryFailureNotifiedRef = useRef(false);
  const noteRecoveryPendingRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;

  const isNoteLibraryMutationAllowed = useCallback((loadedFrom: NoteStorageSource) => {
    return canRunNoteLibraryMutation({
      recoveryPending: noteRecoveryPendingRef.current,
      recoveryInFlight: recoveryInFlightRef.current,
      writesSuspended: noteWritesSuspendedRef.current,
      loadedFrom,
      currentSource: noteStorageSourceRef.current,
    });
  }, []);

  const notifyNoteLibraryMutationBlocked = useCallback(async () => {
    try {
      await message(t("settings.cloudSyncMutationBlocked"), {
        title: t("settings.cloudSyncMutationBlockedTitle"),
        kind: "warning",
      });
    } catch {
      // A failed notification must not release the mutation guard.
    }
  }, [t]);

  const ensureNoteLibraryMutationAllowed = useCallback(
    async (loadedFrom: NoteStorageSource) => {
      if (isNoteLibraryMutationAllowed(loadedFrom)) {
        return true;
      }

      await notifyNoteLibraryMutationBlocked();
      return false;
    },
    [isNoteLibraryMutationAllowed, notifyNoteLibraryMutationBlocked]
  );

  const tabById = useMemo(() => {
    const map = new Map<string, NoteTab>();
    openTabs.forEach((tab) => {
      map.set(tab.id, tab);
    });
    return map;
  }, [openTabs]);

  const openTabIds = useMemo(() => openTabs.map((tab) => tab.id), [openTabs]);
  const splitTabIds = useMemo(() => {
    const nextIds = new Set<string>();
    if (!isSplit) {
      return nextIds;
    }

    if (primaryTabId && openTabIds.includes(primaryTabId)) {
      nextIds.add(primaryTabId);
    }
    if (secondaryTabId && openTabIds.includes(secondaryTabId) && secondaryTabId !== primaryTabId) {
      nextIds.add(secondaryTabId);
    }

    return nextIds;
  }, [isSplit, openTabIds, primaryTabId, secondaryTabId]);
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

  const getTabById = useCallback((tabId: string) => {
    return useNoteStore.getState().notesById[tabId] ?? null;
  }, []);

  const handleTogglePinTab = useCallback((id: string) => {
    togglePinTabStore(id);
    const tab = useNoteStore.getState().notesById[id];
    if (tab && tab.persistence === "library") {
      void saveTabRef.current?.(id);
    }
  }, [togglePinTabStore]);

  const clearAutoSaveTimer = useCallback((tabId?: string) => {
    if (tabId) {
      autoSaveDebouncerRef.current.cancel(tabId);
    } else {
      autoSaveDebouncerRef.current.cancelAll();
    }
  }, []);

  const saveLibraryTabIfEligible = useCallback(async (tabId: string) => {
    if (noteWritesSuspendedRef.current) {
      return false;
    }

    const noteApi = hwanNote.note;
    if (!noteApi?.autoSave) {
      return false;
    }

    const tab = getTabById(tabId);
    if (!tab || tab.persistence !== "library" || !tab.isDirty) {
      return false;
    }

    if (saveQueueRef.current.isBusy(tabId)) {
      return false;
    }

    const saveTab = saveTabRef.current;
    if (!saveTab) {
      return false;
    }

    return saveTab(tabId);
  }, [getTabById]);

  const flushPendingAutoSave = useCallback(async (tabId?: string) => {
    const flushTab = async (pendingTabId: string) => {
      clearAutoSaveTimer(pendingTabId);

      if (saveQueueRef.current.isBusy(pendingTabId)) {
        autoSaveDebouncerRef.current.schedule(pendingTabId, AUTO_SAVE_DELAY_MS, () => {
          void flushPendingAutoSave(pendingTabId);
        });
        return false;
      }

      return saveLibraryTabIfEligible(pendingTabId);
    };

    if (tabId) {
      return flushTab(tabId);
    }

    const pendingTabIds = autoSaveDebouncerRef.current.takePendingKeys();
    if (pendingTabIds.length === 0) {
      return false;
    }

    const results = await Promise.all(pendingTabIds.map(flushTab));
    return results.some(Boolean);
  }, [clearAutoSaveTimer, saveLibraryTabIfEligible]);

  const queuePendingAutoSave = useCallback((tabId: string) => {
    autoSaveDebouncerRef.current.schedule(tabId, AUTO_SAVE_DELAY_MS, () => {
      void flushPendingAutoSave(tabId);
    });
  }, [flushPendingAutoSave]);

  const handleViewChange = useCallback(async (view: AppView) => {
    if (view === activeView) return;
    if (activeView === "notes") {
      await flushPendingAutoSave();
    }
    setActiveView(view);
  }, [activeView, flushPendingAutoSave]);

  const armAutoSaveForTab = useCallback((tabId: string | null | undefined) => {
    if (!tabId || noteWritesSuspendedRef.current) {
      return;
    }

    const noteApi = hwanNote.note;
    if (!noteApi?.autoSave) {
      return;
    }

    const tab = getTabById(tabId);
    if (!tab || tab.persistence !== "library" || !tab.isDirty) {
      return;
    }

    queuePendingAutoSave(tabId);
  }, [getTabById, queuePendingAutoSave]);

  const handleTitleDraftChange = useCallback((tabId: string, title: string) => {
    if (!tabId) {
      return;
    }
    pendingTitleDraftsRef.current[tabId] = title;
  }, []);

  const flushTitleDraft = useCallback((tabId: string | null | undefined) => {
    if (!tabId) {
      return;
    }

    const pendingTitle = pendingTitleDraftsRef.current[tabId];
    if (pendingTitle === undefined) {
      return;
    }

    delete pendingTitleDraftsRef.current[tabId];

    const tab = getTabById(tabId);
    if (!tab) {
      return;
    }

    const normalizedPending = normalizeNoteTitle(pendingTitle);
    const normalizedCurrent = normalizeNoteTitle(tab.title);
    const shouldRevertToDerived = normalizedPending.length === 0 && tab.isTitleManual;

    if (normalizedPending === normalizedCurrent && !shouldRevertToDerived) {
      return;
    }

    setTabTitle(tabId, pendingTitle);
  }, [getTabById, setTabTitle]);

  const flushAutoSaveBeforeFocusChange = useCallback((tabId: string | null | undefined) => {
    flushTitleDraft(tabId);
    armAutoSaveForTab(tabId);
    void flushPendingAutoSave();
  }, [armAutoSaveForTab, flushPendingAutoSave, flushTitleDraft]);

  const handleTitleCommit = useCallback((tabId: string, title: string) => {
    handleTitleDraftChange(tabId, title);
    flushTitleDraft(tabId);
    armAutoSaveForTab(tabId);
  }, [armAutoSaveForTab, flushTitleDraft, handleTitleDraftChange]);

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

      if (pane !== focusedPane) {
        flushAutoSaveBeforeFocusChange(focusedTabId);
      }

      setFocusedPane(pane);
      const paneTabId = pane === "secondary" && isSplit ? secondaryTabId : primaryTabId;
      if (paneTabId && paneTabId !== activeTabId) {
        setActiveTab(paneTabId);
      }
    },
    [activeTabId, flushAutoSaveBeforeFocusChange, focusedPane, focusedTabId, isSplit, primaryTabId, secondaryTabId, setActiveTab]
  );

  const handleCursorChange = useCallback((pane: PaneId, line: number, column: number, chars: number) => {
    setPaneCursors((prev) => ({
      ...prev,
      [pane]: { line, column, chars }
    }));
  }, []);

  const handleEditorChange = useCallback((pane: PaneId, content: JSONContent, plainText: string) => {
    const targetTabId = pane === "secondary" && isSplit ? secondaryTabId : primaryTabId;
    if (!targetTabId) {
      return;
    }

    updateTabContent(targetTabId, content, plainText);
    armAutoSaveForTab(targetTabId);
  }, [armAutoSaveForTab, isSplit, primaryTabId, secondaryTabId, updateTabContent]);

  useEffect(() => {
    return () => {
      clearAutoSaveTimer();
    };
  }, [clearAutoSaveTimer]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"all" | "title" | "content">("all");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("updated");
  const [persistedFolders, setPersistedFolders] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStart>(DEFAULT_WEEK_STARTS_ON);
  const [editorFontSize, setEditorFontSize] = useState(DEFAULT_EDITOR_FONT_SIZE);
  const [editorLineHeight, setEditorLineHeight] = useState(DEFAULT_EDITOR_LINE_HEIGHT);
  const [editorSpellcheck, setEditorSpellcheck] = useState(true);
  const [autoSaveDir, setAutoSaveDir] = useState("");
  const [autoSaveDirIsDefault, setAutoSaveDirIsDefault] = useState(true);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(() => createDefaultShortcuts());
  const [tabSize, setTabSize] = useState(DEFAULT_TAB_SIZE);
  const [cloudSyncProvider, setCloudSyncProvider] = useState<string | null>(null);
  const [cloudSyncSource, setCloudSyncSource] = useState<CloudSyncSource>("local");
  const [cloudSyncFolder, setCloudSyncFolder] = useState<string | null>(null);
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

    persistedFolders.forEach((path) => merged.add(normalizeFolderPath(path)));
    allNotes.forEach((tab) => merged.add(normalizeFolderPath(tab.folderPath)));

    return Array.from(merged).sort((a, b) => a.localeCompare(b, localeTag));
  }, [persistedFolders, localeTag, allNotes]);

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
    (note: LoadedNote): NoteTab => {
      const folderPath = normalizeFolderPath(note.folderPath);
      const persistence: NotePersistence = "library";
      const lastSavedAt = note.updatedAt;
      const content = markdownToTiptapDocument(note.markdown);
      const plainText = tiptapDocumentToPlainText(content);
      return {
        id: note.noteId,
        revision: 0,
        title: note.title,
        isTitleManual: note.isTitleManual,
        content,
        plainText,
        isDirty: false,
        isPinned: note.isPinned ?? false,
        folderPath,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        lastSavedAt,
        fileFormat: "md",
        persistence,
        savedSnapshot: createSavedSnapshot({
          revision: 0,
          title: note.title,
          isTitleManual: note.isTitleManual,
          content,
          plainText,
          folderPath,
          fileFormat: "md",
          updatedAt: note.updatedAt,
          lastSavedAt
        })
      };
    },
    []
  );

  const saveDirtyLibraryTabsBeforeReload = useCallback(async () => {
    Object.keys(pendingTitleDraftsRef.current).forEach(flushTitleDraft);

    const dirtyTabIds = Object.values(useNoteStore.getState().notesById)
      .filter((tab) => tab.persistence === "library" && tab.isDirty)
      .map((tab) => tab.id);
    if (dirtyTabIds.length === 0) {
      return true;
    }

    const saveTab = saveTabRef.current;
    if (!saveTab) {
      dirtyTabIds.forEach(armAutoSaveForTab);
      return false;
    }

    dirtyTabIds.forEach((tabId) => clearAutoSaveTimer(tabId));
    const results = await Promise.all(dirtyTabIds.map((tabId) => saveTab(tabId)));
    const remainingDirtyTabIds = dirtyTabIds.filter(
      (tabId) => useNoteStore.getState().notesById[tabId]?.isDirty
    );
    const savedAll = results.every(Boolean) && remainingDirtyTabIds.length === 0;

    if (!savedAll) {
      remainingDirtyTabIds.forEach(armAutoSaveForTab);
    }

    return savedAll;
  }, [armAutoSaveForTab, clearAutoSaveTimer, flushTitleDraft]);

  const hydrateLoadedNotes = useCallback(
    async (loaded: LoadedNote[], loadedFrom: NoteStorageSource) => {
      const reloadedLibraryTabs = loaded.map(mapLoadedNoteToTab);

      if (hydrationCompleteRef.current) {
        Object.keys(pendingTitleDraftsRef.current).forEach(flushTitleDraft);
        const state = useNoteStore.getState();
        const merged = mergeReloadedNoteTabs({
          reloadedLibraryTabs,
          currentTabs: Object.values(state.notesById),
          currentSession: {
            openTabIds: state.openTabIds,
            activeTabId: state.activeTabId
          },
          sameStorageSource: loadedFrom === noteStorageSourceRef.current,
          createRecoveryId: (sourceTab) =>
            `note-recovered-${Date.now()}-${sourceTab.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
          recoveryTitle: (title) =>
            formatRecoveredNoteTitle(
              tRef.current("settings.cloudSyncRecoveredCopyTitle", { title: RECOVERY_TITLE_TOKEN }),
              title
            )
        });
        hydrateTabs(merged.tabs, merged.session);
        return merged;
      }

      let session: PersistedTabSession;
      try {
        const fileSession = await hwanNote.session.load();
        if (fileSession && fileSession.openTabIds.length > 0) {
          session = fileSession;
        } else {
          session = readTabSessionFromStorage();
        }
      } catch {
        session = readTabSessionFromStorage();
      }

      hydrateTabs(reloadedLibraryTabs, session);
      return {
        tabs: reloadedLibraryTabs,
        session,
        preservedDirtyTabIds: [],
        recoveredCount: 0
      };
    },
    [flushTitleDraft, hydrateTabs, mapLoadedNoteToTab]
  );

  const loadLibraryState = useCallback(async () => {
    const noteApi = hwanNote.note;
    if (!noteApi?.loadAll) {
      return null;
    }

    if (hydrationCompleteRef.current) {
      const savedDirtyTabs = await saveDirtyLibraryTabsBeforeReload();
      if (!savedDirtyTabs) {
        throw new Error("Refusing to reload the note library while dirty tabs remain unsaved.");
      }
    }

    const shouldResumeWrites = !noteWritesSuspendedRef.current;
    noteWritesSuspendedRef.current = true;
    clearAutoSaveTimer();
    let loadedSuccessfully = false;

    try {
      await saveQueueRef.current.waitForIdle();
      const result = await noteApi.loadAll();
      const merged = await hydrateLoadedNotes(result.notes, result.loadedFrom);
      noteStorageSourceRef.current = result.loadedFrom;
      setNoteStorageSource(result.loadedFrom);

      setPersistedFolders(normalizePersistedFolders(result.folders));

      loadedSuccessfully = true;
      noteRecoveryPendingRef.current = false;
      setNoteRecoveryPending(false);
      recoveryFailureNotifiedRef.current = false;

      if (merged.recoveredCount > 0) {
        void message(
          tRef.current("settings.cloudSyncRecoveredWithCopies", { count: merged.recoveredCount }),
          {
            title: tRef.current("settings.cloudSyncRecoveredTitle"),
            kind: "info"
          }
        ).catch(() => { /* ignore notification failures */ });
      }

      return result;
    } finally {
      if (shouldResumeWrites || loadedSuccessfully) {
        noteWritesSuspendedRef.current = false;
        Object.values(useNoteStore.getState().notesById)
          .filter((tab) => tab.persistence === "library" && tab.isDirty)
          .forEach((tab) => armAutoSaveForTab(tab.id));
      }
    }
  }, [armAutoSaveForTab, clearAutoSaveTimer, hydrateLoadedNotes, saveDirtyLibraryTabsBeforeReload]);

  const recoverCloudLibrary = useCallback(async () => {
    const recoverySource = noteStorageSourceRef.current;
    if (
      (recoverySource !== "local_fallback" && !noteRecoveryPendingRef.current) ||
      recoveryInFlightRef.current
    ) {
      return false;
    }

    recoveryInFlightRef.current = true;
    noteRecoveryPendingRef.current = true;
    setNoteRecoveryPending(true);
    noteWritesSuspendedRef.current = true;
    clearAutoSaveTimer();
    let calendarRecoveryCopyPath: string | null = null;

    try {
      await saveQueueRef.current.waitForIdle();
      const result = await hwanNote.note.loadAll();

      if (result.loadedFrom !== "cloud") {
        if (recoverySource === "local_fallback") {
          noteStorageSourceRef.current = result.loadedFrom;
          setNoteStorageSource(result.loadedFrom);
          noteRecoveryPendingRef.current = false;
          setNoteRecoveryPending(false);
          noteWritesSuspendedRef.current = false;
          recoveryFailureNotifiedRef.current = false;
        }
        return false;
      }

      const calendarRecovery = await useCalendarStore.getState().recoverCalendarDataFromCloud();
      calendarRecoveryCopyPath = calendarRecovery.recoveryCopyPath;
      if (calendarRecovery.status !== "recovered" || calendarRecovery.loadedFrom !== "cloud") {
        throw new Error(
          `Calendar recovery was blocked while storage resolved to ${calendarRecovery.loadedFrom ?? "unknown"}.`
        );
      }

      const currentState = useNoteStore.getState();
      const reloadedLibraryTabs = result.notes.map(mapLoadedNoteToTab);
      const recovery = mergeRecoveredNoteTabs({
        reloadedLibraryTabs,
        currentTabs: Object.values(currentState.notesById),
        currentSession: {
          openTabIds: currentState.openTabIds,
          activeTabId: currentState.activeTabId
        },
        createId: (sourceTab) =>
          `note-recovered-${Date.now()}-${sourceTab.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
        recoveryTitle: (title) =>
          formatRecoveredNoteTitle(
            tRef.current("settings.cloudSyncRecoveredCopyTitle", { title: RECOVERY_TITLE_TOKEN }),
            title
          )
      });

      setPersistedFolders(normalizePersistedFolders(result.folders));
      hydrateTabs(recovery.tabs, recovery.session);
      noteStorageSourceRef.current = result.loadedFrom;
      setNoteStorageSource(result.loadedFrom);

      useCalendarStore.getState().cleanOrphanNoteLinks();

      noteRecoveryPendingRef.current = false;
      setNoteRecoveryPending(false);
      noteWritesSuspendedRef.current = false;
      recoveryFailureNotifiedRef.current = false;
      const noteDetail = recovery.recoveredCount > 0
        ? tRef.current("settings.cloudSyncRecoveredWithCopies", { count: recovery.recoveredCount })
        : tRef.current("settings.cloudSyncRecovered");
      const detail = calendarRecoveryCopyPath
        ? `${noteDetail}\n\n${tRef.current("settings.cloudSyncRecoveredCalendarCopy", {
            path: calendarRecoveryCopyPath,
          })}`
        : noteDetail;
      void message(detail, {
        title: tRef.current("settings.cloudSyncRecoveredTitle"),
        kind: "info"
      }).catch(() => { /* ignore notification failures */ });
      return true;
    } catch (error) {
      console.error("Failed to recover the cloud library safely:", error);
      noteRecoveryPendingRef.current = true;
      setNoteRecoveryPending(true);
      if (!recoveryFailureNotifiedRef.current) {
        recoveryFailureNotifiedRef.current = true;
        const detail = calendarRecoveryCopyPath
          ? tRef.current("settings.cloudSyncRecoveryFailedWithCalendarCopy", {
              path: calendarRecoveryCopyPath,
            })
          : tRef.current("settings.cloudSyncRecoveryFailed");
        void message(detail, {
          title: tRef.current("settings.cloudSyncRecoveryFailedTitle"),
          kind: "error"
        }).catch(() => { /* ignore notification failures */ });
      }
      return false;
    } finally {
      recoveryInFlightRef.current = false;
    }
  }, [clearAutoSaveTimer, hydrateTabs, mapLoadedNoteToTab]);

  const refreshLocalAutoSaveDir = useCallback(async () => {
    const settingsApi = hwanNote.settings;
    if (!settingsApi?.getAutoSaveDir) {
      setAutoSaveDir("");
      setAutoSaveDirIsDefault(true);
      return;
    }

    const result = await settingsApi.getAutoSaveDir();
    setAutoSaveDir(result.effectiveDir);
    setAutoSaveDirIsDefault(result.isDefault);
  }, []);

  const refreshCloudSyncState = useCallback(async () => {
    const [status, providers] = await Promise.all([
      hwanNote.cloud.status(),
      hwanNote.cloud.detectProviders()
    ]);

    setCloudSyncProvider(status.provider);
    setCloudSyncSource(status.activeSource);
    setCloudSyncFolder(status.syncFolder);
    setCloudProviders(providers);
  }, []);

  const findExistingTxtTabIdByPath = useCallback((filePath: string) => {
    const targetKey = normalizeIntentPathKey(filePath);
    if (!targetKey) {
      return null;
    }

    const state = useNoteStore.getState();
    for (const noteId of Object.keys(state.notesById)) {
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
    addImportedTab(
      title,
      plainTextToTiptapDocument(content),
      content.replace(/\r?\n/g, "\n"),
      filePath
    );
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

    try {
      const rawWeekStartsOn = window.localStorage.getItem(WEEK_STARTS_ON_KEY);
      if (rawWeekStartsOn !== null) {
        const parsed = Number.parseInt(rawWeekStartsOn, 10);
        if (isWeekStart(parsed)) {
          setWeekStartsOn(parsed);
        }
      }
    } catch (error) {
      console.warn("Failed to load week-starts-on", error);
    }
  }, []);

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
    window.localStorage.setItem(WEEK_STARTS_ON_KEY, String(weekStartsOn));
  }, [weekStartsOn]);

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

    return () => stopListening?.();
  }, [ingestExternalTxtIntent]);

  useEffect(() => {
    const noteApi = hwanNote.note;
    if (!noteApi?.loadAll || initialHydrationFinalizedRef.current) {
      return;
    }

    let disposed = false;

    const run = async () => {
      try {
        if (!initialHydrationPromiseRef.current) {
          initialHydrationPromiseRef.current = loadLibraryState();
        }

        const loaded = await initialHydrationPromiseRef.current;
        if (disposed || initialHydrationFinalizedRef.current || !loaded) {
          return;
        }

        // Load calendar data and clean orphan noteLinks after notes are available
        await useCalendarStore.getState().loadCalendarData();
        useCalendarStore.getState().cleanOrphanNoteLinks();

        const pendingFromBackend = noteApi.drainOpenIntents
          ? await noteApi.drainOpenIntents()
          : [];

        if (disposed) {
          return;
        }

        const buffered = openIntentBufferRef.current;
        openIntentBufferRef.current = [];
        hydrationCompleteRef.current = true;
        initialHydrationFinalizedRef.current = true;

        await ingestExternalTxtIntents([...buffered, ...pendingFromBackend]);
      } catch (error) {
        console.error("Failed to load notes from file system:", error);
      }
    };

    void run();

    return () => {
      disposed = true;
    };
  }, [ingestExternalTxtIntents, loadLibraryState]);

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
    flushAutoSaveBeforeFocusChange(focusedTabId);
    setPaneTab(focusedPane, tabId);
    setActiveTab(tabId);
  }, [flushAutoSaveBeforeFocusChange, focusedPane, focusedTabId, setActiveTab, setPaneTab]);

  const handleSelectNoteInFocusedPane = useCallback((tabId: string) => {
    flushAutoSaveBeforeFocusChange(focusedTabId);
    openNote(tabId);
    setPaneTab(focusedPane, tabId);
    setActiveTab(tabId);
  }, [flushAutoSaveBeforeFocusChange, focusedPane, focusedTabId, openNote, setActiveTab, setPaneTab]);

  const handleCreateTabInFocusedPane = useCallback((targetFolderPath?: string | null) => {
    flushAutoSaveBeforeFocusChange(focusedTabId);
    const normalizedTargetFolder = targetFolderPath ? normalizeFolderPath(targetFolderPath) : "";
    const prevIds = new Set(openTabIds);
    createTab();

    queueMicrotask(() => {
      const state = useNoteStore.getState();
      const createdId = state.openTabIds.find((id) => !prevIds.has(id));
      if (!createdId) {
        return;
      }

      if (normalizedTargetFolder) {
        moveTabToFolder(createdId, normalizedTargetFolder);
        setSelectedFolder(normalizedTargetFolder);
      }

      setPaneTab(focusedPane, createdId);
      setActiveTab(createdId);
    });
  }, [createTab, flushAutoSaveBeforeFocusChange, focusedPane, focusedTabId, moveTabToFolder, openTabIds, setActiveTab, setPaneTab]);

  const handleMoveNoteToFolder = useCallback((noteId: string, folderPath: string) => {
    if (!isNoteLibraryMutationAllowed(noteStorageSourceRef.current)) {
      void notifyNoteLibraryMutationBlocked();
      return;
    }

    const normalizedFolder = normalizeFolderPath(folderPath);
    moveTabToFolder(noteId, normalizedFolder);
    queueMicrotask(() => {
      armAutoSaveForTab(noteId);
    });
  }, [armAutoSaveForTab, isNoteLibraryMutationAllowed, moveTabToFolder, notifyNoteLibraryMutationBlocked]);

  const resolveCurrentFolderContext = useCallback(() => {
    if (selectedFolder) {
      return normalizeFolderPath(selectedFolder);
    }

    return normalizeFolderPath(focusedTab?.folderPath ?? "");
  }, [focusedTab?.folderPath, selectedFolder]);

  const handleCreateTabFromCurrentContext = useCallback(() => {
    handleCreateTabInFocusedPane(resolveCurrentFolderContext());
  }, [handleCreateTabInFocusedPane, resolveCurrentFolderContext]);

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
    flushAutoSaveBeforeFocusChange(focusedTabId);
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
  }, [flushAutoSaveBeforeFocusChange, focusedTabId, openTabIds, primaryTabId, resolveWorkspaceDropTarget, secondaryTabId, setActiveTab]);

  const handleUnsplit = useCallback((targetTabId: string) => {
    if (!isSplit) {
      return;
    }

    const nextPrimaryTabId =
      (openTabIds.includes(targetTabId) ? targetTabId : null) ??
      (focusedTabId && openTabIds.includes(focusedTabId) ? focusedTabId : null) ??
      (primaryTabId && openTabIds.includes(primaryTabId) ? primaryTabId : null) ??
      (secondaryTabId && openTabIds.includes(secondaryTabId) ? secondaryTabId : null) ??
      openTabIds[0] ??
      null;

    if (!nextPrimaryTabId) {
      return;
    }

    flushAutoSaveBeforeFocusChange(focusedTabId);
    setSplitDropTarget(null);
    setPrimaryTabId(nextPrimaryTabId);
    setSecondaryTabId(null);
    setFocusedPane("primary");
    setIsSplit(false);
    if (activeTabId !== nextPrimaryTabId) {
      setActiveTab(nextPrimaryTabId);
    }
  }, [
    activeTabId,
    flushAutoSaveBeforeFocusChange,
    focusedTabId,
    isSplit,
    openTabIds,
    primaryTabId,
    secondaryTabId,
    setActiveTab
  ]);

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
    flushAutoSaveBeforeFocusChange(currentTabId);
    setPaneTab(focusedPane, nextTabId);
    setActiveTab(nextTabId);
  }, [flushAutoSaveBeforeFocusChange, focusedPane, isSplit, openTabIds, primaryTabId, secondaryTabId, setActiveTab, setPaneTab]);

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

  const promptCloseDecision = useCallback(async (tabId: string): Promise<CloseDecision> => {
    const tab = getTabById(tabId);
    if (!tab?.isDirty) {
      return "discard";
    }

    const title = tab.title.trim() || t("common.untitled");
    const saveLabel = t("common.save");
    const dontSaveLabel = t("common.dontSave");
    const cancelLabel = t("common.cancel");
    const result = await message(
      t("dialog.unsavedChangesMessage", { title }),
      {
        title: t("dialog.unsavedChangesTitle"),
        kind: "warning",
        buttons: {
          yes: saveLabel,
          no: dontSaveLabel,
          cancel: cancelLabel
        }
      }
    );

    if (result === "Yes" || result === saveLabel) {
      return "save";
    }

    if (result === "No" || result === dontSaveLabel) {
      return "discard";
    }

    return "cancel";
  }, [getTabById, t]);

  const performSaveTab = useCallback(async (tabId: string) => {
    clearAutoSaveTimer(tabId);

    flushTitleDraft(tabId);
    const tab = getTabById(tabId);
    if (!tab) {
      return false;
    }

    const noteApi = hwanNote.note;
    const persistence: NotePersistence = tab.persistence === "external" ? "external" : "library";
    const createCompletedSavedSnapshot = () =>
      createSavedSnapshot({
        revision: tab.revision,
        title: tab.title,
        isTitleManual: tab.isTitleManual,
        content: tab.content,
        plainText: tab.plainText,
        folderPath: tab.folderPath,
        fileFormat: tab.fileFormat,
        sourceFilePath: tab.sourceFilePath,
        updatedAt: tab.updatedAt,
        lastSavedAt: Date.now()
      });

    if (tab.fileFormat === "txt" && tab.sourceFilePath) {
      if (!noteApi?.saveTxt) {
        return false;
      }

      try {
        await noteApi.saveTxt(tab.sourceFilePath, tab.plainText);
        return markTabSaved(tab.id, {
          savedSnapshot: createCompletedSavedSnapshot(),
          persistence,
          sourceFilePath: tab.sourceFilePath
        });
      } catch (error) {
        console.error("Save txt failed:", error);
        return false;
      }
    }

    if (noteWritesSuspendedRef.current) {
      return false;
    }

    if (!noteApi?.autoSave) {
      window.localStorage.setItem(getDraftKey(tab.id), JSON.stringify(tab.content));
      return markTabSaved(tab.id, {
        savedSnapshot: createCompletedSavedSnapshot(),
        persistence: "library"
      });
    }

    try {
      const markdown = toStoredNoteDocument(tab, t("common.untitled"));

      await noteApi.autoSave(
        tab.id,
        tab.title,
        markdown,
        normalizeFolderPath(tab.folderPath),
        tab.isTitleManual,
        tab.isPinned,
        noteStorageSourceRef.current
      );

      return markTabSaved(tab.id, {
        savedSnapshot: createCompletedSavedSnapshot(),
        persistence: "library"
      });
    } catch (error) {
      console.error("Save failed:", error);
      return false;
    }
  }, [clearAutoSaveTimer, flushTitleDraft, getTabById, markTabSaved, t]);

  const handleSaveTab = useCallback((tabId: string) => {
    return saveQueueRef.current.run(tabId, () => performSaveTab(tabId));
  }, [performSaveTab]);

  useEffect(() => {
    saveTabRef.current = handleSaveTab;
  }, [handleSaveTab]);

  const handleManualSave = useCallback(async () => {
    if (!focusedTabId) {
      return false;
    }

    return handleSaveTab(focusedTabId);
  }, [focusedTabId, handleSaveTab]);

  const resolveDirtyTabs = useCallback(async (tabIds: string[], options: ResolveDirtyTabsOptions = {}) => {
    for (const tabId of tabIds) {
      flushTitleDraft(tabId);
      const tab = getTabById(tabId);
      if (!tab) {
        continue;
      }

      if (tab.isDirty) {
        const decision = await promptCloseDecision(tabId);
        if (decision === "cancel") {
          return false;
        }

        if (decision === "save") {
          const saved = await handleSaveTab(tabId);
          if (!saved) {
            return false;
          }
        } else {
          discardTabChanges(tabId);
        }
      }

      if (options.closeResolvedTabs) {
        const latestTab = getTabById(tabId);
        if (latestTab) {
          closeTab(tabId);
        }
      }
    }

    return true;
  }, [closeTab, discardTabChanges, flushTitleDraft, getTabById, handleSaveTab, promptCloseDecision]);

  const drainNoteSaveQueue = useCallback(async () => {
    const collectPendingTabIds = () => {
      Object.keys(pendingTitleDraftsRef.current).forEach(flushTitleDraft);

      return [...new Set([
        ...autoSaveDebouncerRef.current.takePendingKeys(),
        ...Object.values(useNoteStore.getState().notesById)
          .filter((tab) => tab.isDirty)
          .map((tab) => tab.id),
      ])];
    };

    let pendingTabIds = collectPendingTabIds();
    while (true) {
      if (pendingTabIds.length > 0) {
        const saveTab = saveTabRef.current;
        if (!saveTab) {
          return false;
        }

        const attemptedRevisions = new Map(
          pendingTabIds.map((tabId) => [tabId, getTabById(tabId)?.revision])
        );
        const results = await Promise.all(pendingTabIds.map((tabId) => saveTab(tabId)));
        const hasFailedDirtySave = pendingTabIds.some(
          (tabId, index) => {
            if (results[index]) {
              return false;
            }

            const latestTab = getTabById(tabId);
            return latestTab?.isDirty === true && latestTab.revision === attemptedRevisions.get(tabId);
          }
        );
        if (hasFailedDirtySave) {
          return false;
        }
      }

      await saveQueueRef.current.waitForIdle();
      pendingTabIds = collectPendingTabIds();
      if (pendingTabIds.length === 0) {
        return true;
      }
    }
  }, [flushTitleDraft, getTabById]);

  const runGuardedFlow = useCallback(async (action: () => Promise<boolean>) => {
    if (guardedFlowRef.current) {
      return false;
    }

    clearAutoSaveTimer();

    guardedFlowRef.current = true;
    try {
      return await action();
    } finally {
      guardedFlowRef.current = false;
    }
  }, [clearAutoSaveTimer]);

  const handleRequestCloseTab = useCallback(async (tabId: string) => {
    return runGuardedFlow(() => resolveDirtyTabs([tabId], { closeResolvedTabs: true }));
  }, [resolveDirtyTabs, runGuardedFlow]);

  const handleRequestCloseOtherTabs = useCallback(async (tabId: string) => {
    return runGuardedFlow(async () => {
      const state = useNoteStore.getState();
      const closableIds = state.openTabIds.filter(
        (openId) => openId !== tabId && state.notesById[openId]?.isPinned !== true
      );
      const didResolve = await resolveDirtyTabs(closableIds, { closeResolvedTabs: true });
      if (didResolve && getTabById(tabId)) {
        setActiveTab(tabId);
      }
      return didResolve;
    });
  }, [getTabById, resolveDirtyTabs, runGuardedFlow, setActiveTab]);

  const notifyCalendarSaveBlocked = useCallback(async () => {
    const { backupPath, loadError, loadState, sourcePath } = useCalendarStore.getState();
    console.error("Calendar save blocked until recovery or explicit reset:", {
      loadState,
      loadError,
      sourcePath,
      backupPath,
    });
    await message(
      backupPath
        ? t("settings.calendarRecoveryRequiredWithBackup", { path: backupPath })
        : t("settings.calendarRecoveryRequired"),
      {
        title: t("settings.calendarRecoveryRequiredTitle"),
        kind: "error"
      }
    );
  }, [t]);

  const handleRequestCloseWindow = useCallback(async () => {
    await runGuardedFlow(async () => {
      const state = useNoteStore.getState();
      const didResolve = await resolveDirtyTabs(state.openTabIds, { closeResolvedTabs: false });
      if (!didResolve) {
        return false;
      }

      const didSaveCalendar = await ensureCalendarSaved({
        save: () => useCalendarStore.getState().saveCalendarData(),
        onBlocked: notifyCalendarSaveBlocked,
        onError: async (error) => {
          console.error("Failed to save calendar data before exit:", error);
          await message(t("settings.calendarSaveFailed"), {
            title: t("settings.calendarSaveFailedTitle"),
            kind: "error"
          });
        },
      });
      if (!didSaveCalendar) {
        return false;
      }
      await hwanNote.window.exit();
      return true;
    });
  }, [notifyCalendarSaveBlocked, resolveDirtyTabs, runGuardedFlow, t]);

  const resolveOpenTabsBeforeReload = useCallback(async () => {
    return runGuardedFlow(async () => {
      const state = useNoteStore.getState();
      return resolveDirtyTabs(state.openTabIds, { closeResolvedTabs: false });
    });
  }, [resolveDirtyTabs, runGuardedFlow]);

  const confirmDeleteNote = useCallback(async (tab: NoteTab) => {
    const title = tab.title.trim() || t("common.untitled");
    return confirmDialog(t("sidebar.noteDeleteConfirm", { title }), {
      title: t("sidebar.noteDelete"),
      kind: "warning"
    });
  }, [t]);

  const handleDeleteNote = useCallback(async (id: string) => {
    const initialTab = getTabById(id);
    if (!initialTab) {
      return false;
    }

    const loadedFrom = noteStorageSourceRef.current;
    if (!(await ensureNoteLibraryMutationAllowed(loadedFrom))) {
      return false;
    }

    const confirmed = await confirmDeleteNote(initialTab);
    if (!confirmed) {
      return false;
    }

    return runGuardedFlow(async () => {
      if (!getTabById(id)) {
        return false;
      }

      const didResolve = await resolveDirtyTabs([id], { closeResolvedTabs: false });
      if (!didResolve) {
        return false;
      }

      if (!(await ensureNoteLibraryMutationAllowed(loadedFrom))) {
        return false;
      }

      try {
        await hwanNote.note.delete(id, loadedFrom);
        if (isNoteLibraryMutationAllowed(loadedFrom)) {
          removeNote(id);
          useCalendarStore.getState().removeNoteLinks(id);
        }
        return true;
      } catch (error) {
        console.error("Failed to delete note:", error);
        await message(t("sidebar.noteDeleteFailed"), { title: t("sidebar.noteDelete"), kind: "error" });
        return false;
      }
    });
  }, [confirmDeleteNote, ensureNoteLibraryMutationAllowed, getTabById, isNoteLibraryMutationAllowed, removeNote, resolveDirtyTabs, runGuardedFlow, t]);

  const flushCalendarBeforeStorageChange = useCallback(async () => {
    return ensureCalendarSaved({
      save: () => useCalendarStore.getState().saveCalendarData(),
      onBlocked: notifyCalendarSaveBlocked,
      onError: async (error) => {
        console.error("Failed to save calendar data before storage change:", error);
        await message(t("settings.calendarSaveFailed"), {
          title: t("settings.calendarSaveFailedTitle"),
          kind: "error"
        });
      },
    });
  }, [notifyCalendarSaveBlocked, t]);

  const handleBrowseAutoSaveDir = useCallback(async () => {
    const didResolve = await resolveOpenTabsBeforeReload();
    if (!didResolve) {
      return;
    }

    const settingsApi = hwanNote.settings;
    if (!settingsApi) return;

    const selected = await settingsApi.browseAutoSaveDir();
    if (!selected) return;

    const didSaveCalendar = await flushCalendarBeforeStorageChange();
    if (!didSaveCalendar) {
      return;
    }

    try {
      const result = await settingsApi.setAutoSaveDir(selected);
      setAutoSaveDir(result.effectiveDir);
      setAutoSaveDirIsDefault(result.isDefault);

      await loadLibraryState();
      await useCalendarStore.getState().loadCalendarData();
      useCalendarStore.getState().cleanOrphanNoteLinks();
    } catch (error) {
      console.error("Failed to set auto-save directory:", error);
    }
  }, [flushCalendarBeforeStorageChange, loadLibraryState, resolveOpenTabsBeforeReload]);

  const handleResetAutoSaveDir = useCallback(async () => {
    const didResolve = await resolveOpenTabsBeforeReload();
    if (!didResolve) {
      return;
    }

    const settingsApi = hwanNote.settings;
    if (!settingsApi) return;

    const didSaveCalendar = await flushCalendarBeforeStorageChange();
    if (!didSaveCalendar) {
      return;
    }

    try {
      const result = await settingsApi.setAutoSaveDir(null);
      setAutoSaveDir(result.effectiveDir);
      setAutoSaveDirIsDefault(result.isDefault);

      await loadLibraryState();
      await useCalendarStore.getState().loadCalendarData();
      useCalendarStore.getState().cleanOrphanNoteLinks();
    } catch (error) {
      console.error("Failed to reset auto-save directory:", error);
    }
  }, [flushCalendarBeforeStorageChange, loadLibraryState, resolveOpenTabsBeforeReload]);

  const handleCloudSyncChange = useCallback(async (provider: string | null, options?: { copyLocalNotes: boolean }) => {
    const didResolve = await resolveOpenTabsBeforeReload();
    if (!didResolve) {
      return;
    }

    const didSaveCalendar = await flushCalendarBeforeStorageChange();
    if (!didSaveCalendar) {
      return;
    }

    try {
      if (provider) {
        await hwanNote.cloud.enable(provider, options?.copyLocalNotes ?? false);
      } else {
        await hwanNote.cloud.disable();
      }
      await refreshLocalAutoSaveDir();
      await loadLibraryState();
      await useCalendarStore.getState().loadCalendarData();
      useCalendarStore.getState().cleanOrphanNoteLinks();
      await refreshCloudSyncState();
    } catch (error) {
      console.error("Failed to change cloud sync:", error);
    }
  }, [flushCalendarBeforeStorageChange, loadLibraryState, refreshCloudSyncState, refreshLocalAutoSaveDir, resolveOpenTabsBeforeReload]);

  const handleCloudSyncSourceChange = useCallback(async (source: CloudSyncSource) => {
    const didResolve = await resolveOpenTabsBeforeReload();
    if (!didResolve) {
      return;
    }

    const didSaveCalendar = await flushCalendarBeforeStorageChange();
    if (!didSaveCalendar) {
      return;
    }

    try {
      await hwanNote.cloud.setActiveSource(source);
      await loadLibraryState();
      await useCalendarStore.getState().loadCalendarData();
      useCalendarStore.getState().cleanOrphanNoteLinks();
      await refreshCloudSyncState();
    } catch (error) {
      console.error("Failed to switch library source:", error);
    }
  }, [flushCalendarBeforeStorageChange, loadLibraryState, refreshCloudSyncState, resolveOpenTabsBeforeReload]);

  const handleInstallUpdate = useCallback(async () => {
    const isReadyToInstall = await runGuardedFlow(async () => {
      const state = useNoteStore.getState();
      const didResolve = await resolveDirtyTabs(state.openTabIds, { closeResolvedTabs: false });
      if (!didResolve) {
        return false;
      }

      const didSaveCalendar = await ensureCalendarSaved({
        save: () => useCalendarStore.getState().saveCalendarData(),
        onBlocked: notifyCalendarSaveBlocked,
        onError: async (error) => {
          console.error("Failed to save calendar data before update installation:", error);
          await message(t("settings.calendarSaveFailed"), {
            title: t("settings.calendarSaveFailedTitle"),
            kind: "error"
          });
        },
      });
      if (!didSaveCalendar) {
        return false;
      }

      const didDrainNoteSaves = await drainNoteSaveQueue();
      if (!didDrainNoteSaves) {
        console.error("Failed to drain note saves before update installation.");
        try {
          await message(t("update.noteSaveFailed"), {
            title: t("update.noteSaveFailedTitle"),
            kind: "error"
          });
        } catch {
          // A failed notification must not release the close guard.
        }
      }
      return didDrainNoteSaves;
    });
    if (!isReadyToInstall) {
      return;
    }

    allowImmediateCloseRef.current = true;
    try {
      await hwanNote.updater.install();
    } catch (error) {
      allowImmediateCloseRef.current = false;
      console.error("Failed to install update:", error);
    }
  }, [drainNoteSaveQueue, notifyCalendarSaveBlocked, resolveDirtyTabs, runGuardedFlow, t]);

  useEffect(() => {
    void refreshLocalAutoSaveDir().catch(() => {
      setAutoSaveDir("");
      setAutoSaveDirIsDefault(true);
    });
  }, [refreshLocalAutoSaveDir]);

  useEffect(() => {
    void refreshCloudSyncState().catch(() => { /* ignore */ });
  }, [refreshCloudSyncState]);

  const suspendCloudWritesForRecovery = useCallback(() => {
    if (noteStorageSourceRef.current !== "cloud") {
      return;
    }

    noteRecoveryPendingRef.current = true;
    setNoteRecoveryPending(true);
    noteWritesSuspendedRef.current = true;
    clearAutoSaveTimer();
  }, [clearAutoSaveTimer]);

  useEffect(() => {
    if (
      noteStorageSource !== "cloud" &&
      noteStorageSource !== "local_fallback" &&
      !noteRecoveryPending
    ) {
      return;
    }

    let disposed = false;
    const checkForRecovery = async () => {
      try {
        const status = await hwanNote.cloud.status();
        if (disposed) {
          return;
        }

        if (status.resolvedSource === "local_fallback") {
          if (noteStorageSourceRef.current === "cloud") {
            suspendCloudWritesForRecovery();
          } else if (noteStorageSourceRef.current === "local_fallback") {
            noteRecoveryPendingRef.current = false;
            setNoteRecoveryPending(false);
            noteWritesSuspendedRef.current = false;
            recoveryFailureNotifiedRef.current = false;
          }
          return;
        }

        if (
          status.resolvedSource === "cloud" &&
          (noteStorageSourceRef.current === "local_fallback" || noteRecoveryPendingRef.current)
        ) {
          await recoverCloudLibrary();
        }
      } catch {
        // The next interval or focus event retries the read-only status check.
      }
    };
    const handleFocus = () => {
      void checkForRecovery();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkForRecovery();
      }
    };

    void checkForRecovery();
    const intervalId = window.setInterval(checkForRecovery, CLOUD_RECOVERY_POLL_INTERVAL_MS);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [noteRecoveryPending, noteStorageSource, recoverCloudLibrary, suspendCloudWritesForRecovery]);

  useEffect(() => {
    const unlisten = hwanNote.cloud.onFolderMissing((data) => {
      suspendCloudWritesForRecovery();
      window.alert(
        `${t("settings.cloudSyncFolderMissing")}\n${t("settings.cloudSyncFolderMissingDetail", { path: data.expectedPath })}`
      );
    });
    return () => unlisten();
  }, [suspendCloudWritesForRecovery, t]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void getCurrentWindow().onCloseRequested(async (event) => {
      if (allowImmediateCloseRef.current) {
        return;
      }
      event.preventDefault();
      if (!disposed) {
        await handleRequestCloseWindow();
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    }).catch((error) => {
      console.error("Failed to attach close-request listener:", error);
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [handleRequestCloseWindow]);

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

      if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void handleViewChange(activeView === "notes" ? "calendar" : "notes");
        return;
      }

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
            void handleRequestCloseTab(focusedTabId);
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
    activeView,
    focusPane,
    focusedEditor,
    focusedTabId,
    handleCreateTabInFocusedPane,
    handleCycleTabInFocusedPane,
    handleManualSave,
    handleRequestCloseTab,
    handleViewChange,
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
        splitTabIds={splitTabIds}
        activeView={activeView}
        onViewChange={(view) => void handleViewChange(view)}
        isMaximized={isMaximized}
        onToggleSidebar={toggleSidebar}
        onSelectTab={handleSelectTabInFocusedPane}
        onCloseTab={(tabId) => void handleRequestCloseTab(tabId)}
        onCloseOtherTabs={(tabId) => void handleRequestCloseOtherTabs(tabId)}
        onTogglePinTab={handleTogglePinTab}
        onReorderTabs={reorderTabs}
        onDropTabOutside={handleDropTabOutside}
        onTabDragPreview={handleTabDragPreview}
        onTabDragEnd={handleTabDragEnd}
        onUnsplit={handleUnsplit}
        onCreateTab={handleCreateTabFromCurrentContext}
        onMinimize={() => void hwanNote.window.minimize()}
        onToggleMaximize={() => void handleToggleMaximize()}
        onCloseWindow={() => void handleRequestCloseWindow()}
      />

      {activeView === "notes" && (
        <Toolbar
          editor={focusedEditor}
          activeTitle={focusedTab?.title ?? ""}
          activeTabId={focusedTab?.id ?? ""}
          isTitleManual={Boolean(focusedTab?.isTitleManual)}
          onTitleDraftChange={handleTitleDraftChange}
          onChangeTitle={handleTitleCommit}
          lastSavedAt={focusedTab?.lastSavedAt ?? 0}
          onOpenSettings={() => setSettingsOpen(true)}
          onImportTxt={() => void handleImportTxt()}
        />
      )}

      <div className="workspace">
        <Sidebar
          visible={sidebarVisible}
          activeView={activeView}
          onViewChange={(view) => void handleViewChange(view)}
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
          onTogglePinNote={handleTogglePinTab}
          onDeleteNote={(id) => { void handleDeleteNote(id); }}
          onCreateNoteInFolder={(folderPath) => {
            handleCreateTabInFocusedPane(folderPath);
          }}
          onMoveNoteToFolder={handleMoveNoteToFolder}
          onCreateFolder={async (folderPath) => {
            const normalized = normalizeFolderPath(folderPath);
            if (!normalized) {
              return;
            }

            const loadedFrom = noteStorageSourceRef.current;
            if (!(await ensureNoteLibraryMutationAllowed(loadedFrom))) {
              return;
            }

            try {
              const folders = await hwanNote.folder.create(normalized, loadedFrom);
              if (!isNoteLibraryMutationAllowed(loadedFrom)) {
                return;
              }
              setPersistedFolders(
                Array.from(
                  new Set(
                    folders
                      .filter((entry): entry is string => typeof entry === "string")
                      .map(normalizeFolderPath)
                      .filter(Boolean)
                  )
                ).sort((a, b) => a.localeCompare(b, localeTag))
              );
            } catch (error) {
              console.error("Failed to create folder:", error);
            }
          }}
          onRenameFolder={async (from, to) => {
            const normalizedFrom = normalizeFolderPath(from);
            const normalizedTo = normalizeFolderPath(to);
            if (!normalizedFrom || !normalizedTo || normalizedFrom === normalizedTo) {
              return;
            }

            const loadedFrom = noteStorageSourceRef.current;
            if (!(await ensureNoteLibraryMutationAllowed(loadedFrom))) {
              return;
            }

            const didResolve = await resolveOpenTabsBeforeReload();
            if (!didResolve) {
              return;
            }

            if (!(await ensureNoteLibraryMutationAllowed(loadedFrom))) {
              return;
            }

            try {
              await hwanNote.folder.rename(normalizedFrom, normalizedTo, loadedFrom);
              if (isNoteLibraryMutationAllowed(loadedFrom)) {
                await loadLibraryState();
                if (selectedFolder) {
                  setSelectedFolder(replaceFolderPrefix(selectedFolder, normalizedFrom, normalizedTo));
                }
              }
            } catch (error) {
              console.error("Failed to rename folder:", error);
            }
          }}
          onDeleteFolder={async (folderPath) => {
            const normalized = normalizeFolderPath(folderPath);
            if (!normalized) {
              return;
            }

            const loadedFrom = noteStorageSourceRef.current;
            if (!(await ensureNoteLibraryMutationAllowed(loadedFrom))) {
              return;
            }

            const didResolve = await resolveOpenTabsBeforeReload();
            if (!didResolve) {
              return;
            }

            if (!(await ensureNoteLibraryMutationAllowed(loadedFrom))) {
              return;
            }

            try {
              await hwanNote.folder.delete(normalized, loadedFrom);
              if (isNoteLibraryMutationAllowed(loadedFrom)) {
                await loadLibraryState();
                if (selectedFolder && (selectedFolder === normalized || selectedFolder.startsWith(`${normalized}/`))) {
                  setSelectedFolder(null);
                }
              }
            } catch (error) {
              console.error("Failed to delete folder:", error);
            }
          }}
        />

        {activeView === "notes" ? (
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
        ) : (
          <CalendarPage
            weekStartsOn={weekStartsOn}
            onNavigateToNote={(noteId) => {
              setActiveView("notes");
              handleSelectNoteInFocusedPane(noteId);
            }}
          />
        )}
      </div>

      {activeView === "notes" && (
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
            if (hasRichTextFormatting(focusedTab.content) && !window.confirm(t("status.confirmSwitchToTxt"))) {
              return;
            }
          }
          toggleFileFormat(focusedTab.id);
        }}
        cloudSyncProvider={cloudSyncProvider}
        cloudSyncSource={cloudSyncSource}
      />
      )}

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
        cloudSyncSource={cloudSyncSource}
        cloudSyncFolder={cloudSyncFolder}
        cloudProviders={cloudProviders}
        noteCount={allNotes.length}
        onCloudSyncChange={handleCloudSyncChange}
        onCloudSyncSourceChange={handleCloudSyncSourceChange}
        shortcuts={shortcuts}
        onThemeModeChange={setThemeMode}
        onEditorLineHeightChange={(value) => setEditorLineHeight(normalizeEditorLineHeight(value))}
        onEditorFontSizeChange={(value) => setEditorFontSize(normalizeEditorFontSize(value))}
        onEditorSpellcheckChange={setEditorSpellcheck}
        onTabSizeChange={(size) => setTabSize(VALID_TAB_SIZES.includes(size) ? size : DEFAULT_TAB_SIZE)}
        onShortcutChange={handleShortcutChange}
        onResetShortcuts={handleShortcutReset}
        weekStartsOn={weekStartsOn}
        onWeekStartsOnChange={setWeekStartsOn}
        onClose={() => {
          setSettingsOpen(false);
          restoreEditorFocus(focusedEditor);
        }}
      />

      <UpdateToast language={language} onInstall={handleInstallUpdate} />
    </div>
  );
}
