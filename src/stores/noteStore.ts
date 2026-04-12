import { create } from "zustand";
import { hwanNote } from "../lib/tauriApi";
import { normalizeFolderPath } from "../lib/folderPaths";

export const OPEN_TAB_IDS_KEY = "hwan-note:open-tab-ids";
export const ACTIVE_TAB_ID_KEY = "hwan-note:active-tab-id";

export type NotePersistence = "transient" | "library" | "external";

export interface SavedNoteSnapshot {
  title: string;
  isTitleManual: boolean;
  content: string;
  plainText: string;
  folderPath: string;
  fileFormat: "md" | "txt";
  sourceFilePath?: string;
  updatedAt: number;
  lastSavedAt: number;
}

export interface NoteTab {
  id: string;
  title: string;
  isTitleManual: boolean;
  content: string;
  plainText: string;
  isDirty: boolean;
  isPinned: boolean;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
  lastSavedAt: number;
  sourceFilePath?: string;
  fileFormat: "md" | "txt";
  persistence: NotePersistence;
  savedSnapshot: SavedNoteSnapshot | null;
}

export interface PersistedTabSession {
  openTabIds: string[];
  activeTabId: string | null;
}

export interface SaveTabOptions {
  lastSavedAt?: number;
  persistence?: NotePersistence;
  sourceFilePath?: string;
}

export type DiscardTabResult = "none" | "reverted" | "removed";

interface NoteStore {
  notesById: Record<string, NoteTab>;
  noteIds: string[];
  openTabIds: string[];
  activeTabId: string | null;
  allNotes: NoteTab[];
  openTabs: NoteTab[];
  activeOpenTab: NoteTab | null;
  sidebarVisible: boolean;
  hydrateTabs: (tabs: NoteTab[], persistedSession?: PersistedTabSession) => void;
  createTab: () => void;
  addImportedTab: (title: string, content: string, plainText: string, sourceFilePath?: string) => void;
  openNote: (id: string) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  reorderTabs: (sourceId: string, targetId: string) => void;
  removeNote: (id: string) => void;
  togglePinTab: (id: string) => void;
  moveTabToFolder: (id: string, folderPath: string) => void;
  renameFolderPath: (from: string, to: string) => void;
  clearFolderPath: (folderPath: string) => void;
  activateNextTab: () => void;
  activatePrevTab: () => void;
  setTabTitle: (id: string, title: string) => void;
  setActiveTitle: (title: string) => void;
  updateTabContent: (id: string, content: string, plainText: string) => void;
  updateActiveContent: (content: string, plainText: string) => void;
  markTabSaved: (id: string, options?: SaveTabOptions) => void;
  discardTabChanges: (id: string) => DiscardTabResult;
  toggleFileFormat: (id: string) => void;
  toggleSidebar: () => void;
}

function createId() {
  return `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveTitle(plainText: string) {
  const firstLine = plainText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return "제목 없음";
  }

  const stripped = firstLine.replace(/^#{1,3}\s+/, "");
  return stripped.slice(0, 50) || "제목 없음";
}

function createSavedSnapshot(tab: Pick<
  NoteTab,
  "title" | "isTitleManual" | "content" | "plainText" | "folderPath" | "fileFormat" | "sourceFilePath" | "updatedAt" | "lastSavedAt"
>): SavedNoteSnapshot {
  return {
    title: tab.title,
    isTitleManual: tab.isTitleManual,
    content: tab.content,
    plainText: tab.plainText,
    folderPath: tab.folderPath,
    fileFormat: tab.fileFormat,
    sourceFilePath: tab.sourceFilePath,
    updatedAt: tab.updatedAt,
    lastSavedAt: tab.lastSavedAt
  };
}

function createEmptyTab(): NoteTab {
  const now = Date.now();

  return {
    id: createId(),
    title: "제목 없음",
    isTitleManual: false,
    content: "<p></p>",
    plainText: "",
    isDirty: false,
    isPinned: false,
    folderPath: "",
    createdAt: now,
    updatedAt: now,
    lastSavedAt: 0,
    fileFormat: "md",
    persistence: "transient",
    savedSnapshot: null
  };
}

function dedupeIds(ids: string[]) {
  return Array.from(new Set(ids));
}

function buildCollections(
  notesById: Record<string, NoteTab>,
  noteIds: string[],
  openTabIds: string[],
  activeTabId: string | null
) {
  const normalizedNoteIds = dedupeIds(
    noteIds.filter((id) => Boolean(notesById[id]) && notesById[id].persistence === "library")
  );
  const normalizedOpenTabIds = dedupeIds(openTabIds.filter((id) => Boolean(notesById[id])));
  const normalizedActiveTabId =
    activeTabId && normalizedOpenTabIds.includes(activeTabId) ? activeTabId : (normalizedOpenTabIds[0] ?? null);
  const allNotes = normalizedNoteIds.map((id) => notesById[id]).filter(Boolean);
  const openTabs = normalizedOpenTabIds.map((id) => notesById[id]).filter(Boolean);

  return {
    noteIds: normalizedNoteIds,
    openTabIds: normalizedOpenTabIds,
    activeTabId: normalizedActiveTabId,
    allNotes,
    openTabs,
    activeOpenTab: normalizedActiveTabId ? (notesById[normalizedActiveTabId] ?? null) : null
  };
}

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function persistSession(openTabIds: string[], activeTabId: string | null) {
  // Save to file (primary) — fire-and-forget
  hwanNote.session?.save(openTabIds, activeTabId).catch(() => {});

  // Keep localStorage as fallback
  if (!canUseStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(OPEN_TAB_IDS_KEY, JSON.stringify(openTabIds));
    window.localStorage.setItem(ACTIVE_TAB_ID_KEY, activeTabId ?? "");
  } catch {
    // ignore localStorage failures
  }
}

export function readTabSessionFromStorage(): PersistedTabSession {
  if (!canUseStorage()) {
    return { openTabIds: [], activeTabId: null };
  }

  let openTabIds: string[] = [];
  let activeTabId: string | null = null;

  try {
    const rawOpenTabIds = window.localStorage.getItem(OPEN_TAB_IDS_KEY);
    if (rawOpenTabIds) {
      const parsed = JSON.parse(rawOpenTabIds) as unknown;
      if (Array.isArray(parsed)) {
        openTabIds = parsed.filter((entry): entry is string => typeof entry === "string");
      }
    }
  } catch {
    openTabIds = [];
  }

  try {
    const rawActiveTabId = window.localStorage.getItem(ACTIVE_TAB_ID_KEY) ?? "";
    activeTabId = rawActiveTabId.trim() ? rawActiveTabId : null;
  } catch {
    activeTabId = null;
  }

  return { openTabIds, activeTabId };
}

function buildStateSlice(
  notesById: Record<string, NoteTab>,
  noteIds: string[],
  openTabIds: string[],
  activeTabId: string | null
) {
  const nextNotesById = { ...notesById };
  let nextNoteIds = noteIds.filter((id) => Boolean(nextNotesById[id]) && nextNotesById[id].persistence === "library");
  let nextOpenTabIds = openTabIds.filter((id) => Boolean(nextNotesById[id]));
  let nextActiveTabId = activeTabId;

  if (nextOpenTabIds.length === 0) {
    const fallbackOpenId = nextNoteIds[0] ?? null;
    if (fallbackOpenId) {
      nextOpenTabIds = [fallbackOpenId];
      nextActiveTabId = fallbackOpenId;
    } else {
      const freshTab = createEmptyTab();
      nextNotesById[freshTab.id] = freshTab;
      nextOpenTabIds = [freshTab.id];
      nextActiveTabId = freshTab.id;
    }
  }

  const nextCollections = buildCollections(nextNotesById, nextNoteIds, nextOpenTabIds, nextActiveTabId);
  persistSession(nextCollections.openTabIds, nextCollections.activeTabId);

  return {
    notesById: nextNotesById,
    noteIds: nextCollections.noteIds,
    openTabIds: nextCollections.openTabIds,
    activeTabId: nextCollections.activeTabId,
    allNotes: nextCollections.allNotes,
    openTabs: nextCollections.openTabs,
    activeOpenTab: nextCollections.activeOpenTab
  };
}

export const useNoteStore = create<NoteStore>((set, get) => {
  const firstTab = createEmptyTab();
  const notesById: Record<string, NoteTab> = { [firstTab.id]: firstTab };
  const noteIds: string[] = [];
  const openTabIds = [firstTab.id];
  const baseCollections = buildCollections(notesById, noteIds, openTabIds, firstTab.id);

  return {
    notesById,
    noteIds: baseCollections.noteIds,
    openTabIds: baseCollections.openTabIds,
    activeTabId: baseCollections.activeTabId,
    allNotes: baseCollections.allNotes,
    openTabs: baseCollections.openTabs,
    activeOpenTab: baseCollections.activeOpenTab,
    sidebarVisible: false,
    hydrateTabs: (tabs, persistedSession) => {
      const loadedTabs = tabs.length > 0 ? tabs : [createEmptyTab()];
      const nextNotesById: Record<string, NoteTab> = {};
      const nextNoteIds: string[] = [];

      loadedTabs.forEach((tab) => {
        nextNotesById[tab.id] = tab;
        if (tab.persistence === "library") {
          nextNoteIds.push(tab.id);
        }
      });

      const session = persistedSession ?? readTabSessionFromStorage();
      let nextOpenTabIds = session.openTabIds.filter((id) => Boolean(nextNotesById[id]));
      if (nextOpenTabIds.length === 0) {
        const fallbackOpenId = nextNoteIds[0] ?? loadedTabs[0]?.id ?? null;
        nextOpenTabIds = fallbackOpenId ? [fallbackOpenId] : [];
      }

      const nextActiveTabId =
        session.activeTabId && nextOpenTabIds.includes(session.activeTabId)
          ? session.activeTabId
          : (nextOpenTabIds[0] ?? null);

      set(buildStateSlice(nextNotesById, nextNoteIds, nextOpenTabIds, nextActiveTabId));
    },
    createTab: () => {
      const tab = createEmptyTab();
      set((state) => {
        const nextNotesById = { ...state.notesById, [tab.id]: tab };
        const nextOpenTabIds = [...state.openTabIds, tab.id];
        return buildStateSlice(nextNotesById, state.noteIds, nextOpenTabIds, tab.id);
      });
    },
    addImportedTab: (title, content, plainText, sourceFilePath) => {
      const now = Date.now();
      const tab: NoteTab = {
        id: createId(),
        title: title.trim().slice(0, 50) || "제목 없음",
        isTitleManual: true,
        content,
        plainText,
        isDirty: false,
        isPinned: false,
        folderPath: "",
        createdAt: now,
        updatedAt: now,
        lastSavedAt: 0,
        sourceFilePath,
        fileFormat: sourceFilePath ? "txt" : "md",
        persistence: sourceFilePath ? "external" : "transient",
        savedSnapshot: null
      };

      if (tab.persistence === "external") {
        tab.savedSnapshot = createSavedSnapshot(tab);
      }

      set((state) => {
        const nextNotesById = { ...state.notesById, [tab.id]: tab };
        const nextOpenTabIds = [...state.openTabIds, tab.id];
        return buildStateSlice(nextNotesById, state.noteIds, nextOpenTabIds, tab.id);
      });
    },
    openNote: (id) => {
      set((state) => {
        if (!state.notesById[id]) {
          return state;
        }

        const nextOpenTabIds = state.openTabIds.includes(id) ? state.openTabIds : [...state.openTabIds, id];
        const nextCollections = buildCollections(state.notesById, state.noteIds, nextOpenTabIds, id);
        if (
          nextCollections.activeTabId === state.activeTabId &&
          nextCollections.openTabIds.length === state.openTabIds.length
        ) {
          return state;
        }

        persistSession(nextCollections.openTabIds, nextCollections.activeTabId);
        return {
          openTabIds: nextCollections.openTabIds,
          activeTabId: nextCollections.activeTabId,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    setActiveTab: (id) => {
      set((state) => {
        if (!state.openTabIds.includes(id) || state.activeTabId === id) {
          return state;
        }

        const nextCollections = buildCollections(state.notesById, state.noteIds, state.openTabIds, id);
        persistSession(nextCollections.openTabIds, nextCollections.activeTabId);
        return {
          activeTabId: nextCollections.activeTabId,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    closeTab: (id) => {
      set((state) => {
        const targetIndex = state.openTabIds.findIndex((openId) => openId === id);
        if (targetIndex === -1) {
          return state;
        }

        const target = state.notesById[id];
        const nextNotesById = { ...state.notesById };
        if (target?.persistence !== "library") {
          delete nextNotesById[id];
        }

        let nextOpenTabIds = state.openTabIds.filter((openId) => openId !== id);
        if (nextOpenTabIds.length === 0 && target?.persistence === "library") {
          const fallbackOpenId = state.noteIds.find((noteId) => noteId !== id && Boolean(nextNotesById[noteId])) ?? id;
          nextOpenTabIds = fallbackOpenId ? [fallbackOpenId] : [];
        }
        const fallbackIndex = Math.max(0, targetIndex - 1);
        const preferredActiveTabId =
          state.activeTabId === id ? (nextOpenTabIds[fallbackIndex] ?? nextOpenTabIds[0] ?? null) : state.activeTabId;

        return buildStateSlice(nextNotesById, state.noteIds, nextOpenTabIds, preferredActiveTabId);
      });
    },
    closeOtherTabs: (id) => {
      set((state) => {
        if (!state.openTabIds.includes(id)) {
          return state;
        }

        const closableIds = state.openTabIds.filter(
          (openId) => openId !== id && state.notesById[openId]?.isPinned !== true
        );
        const nextNotesById = { ...state.notesById };

        closableIds.forEach((openId) => {
          if (nextNotesById[openId]?.persistence !== "library") {
            delete nextNotesById[openId];
          }
        });

        const nextOpenTabIds = state.openTabIds.filter(
          (openId) => openId === id || state.notesById[openId]?.isPinned === true
        );

        return buildStateSlice(nextNotesById, state.noteIds, nextOpenTabIds, id);
      });
    },
    reorderTabs: (sourceId, targetId) => {
      if (sourceId === targetId) {
        return;
      }

      set((state) => {
        const sourceIndex = state.openTabIds.findIndex((tabId) => tabId === sourceId);
        const targetIndex = state.openTabIds.findIndex((tabId) => tabId === targetId);
        if (sourceIndex === -1 || targetIndex === -1) {
          return state;
        }

        const nextOpenTabIds = [...state.openTabIds];
        const [movedId] = nextOpenTabIds.splice(sourceIndex, 1);
        nextOpenTabIds.splice(targetIndex, 0, movedId);

        const nextCollections = buildCollections(state.notesById, state.noteIds, nextOpenTabIds, state.activeTabId);
        persistSession(nextCollections.openTabIds, nextCollections.activeTabId);

        return {
          openTabIds: nextCollections.openTabIds,
          activeTabId: nextCollections.activeTabId,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    removeNote: (id) => {
      set((state) => {
        if (!state.notesById[id]) {
          return state;
        }

        const nextNotesById = { ...state.notesById };
        delete nextNotesById[id];
        const nextNoteIds = state.noteIds.filter((noteId) => noteId !== id);
        const nextOpenTabIds = state.openTabIds.filter((openId) => openId !== id);
        const preferredActiveTabId = state.activeTabId === id ? (nextOpenTabIds[0] ?? null) : state.activeTabId;

        return buildStateSlice(nextNotesById, nextNoteIds, nextOpenTabIds, preferredActiveTabId);
      });
    },
    togglePinTab: (id) => {
      set((state) => {
        if (!state.notesById[id]) {
          return state;
        }

        const nextNotesById = {
          ...state.notesById,
          [id]: {
            ...state.notesById[id],
            isPinned: !state.notesById[id].isPinned,
            updatedAt: Date.now()
          }
        };

        const nextCollections = buildCollections(nextNotesById, state.noteIds, state.openTabIds, state.activeTabId);
        return {
          notesById: nextNotesById,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    moveTabToFolder: (id, folderPath) => {
      const normalized = normalizeFolderPath(folderPath);

      set((state) => {
        const target = state.notesById[id];
        if (!target) {
          return state;
        }

        if (normalizeFolderPath(target.folderPath) === normalized) {
          return state;
        }

        const nextNotesById = {
          ...state.notesById,
          [id]: { ...target, folderPath: normalized, updatedAt: Date.now(), isDirty: true }
        };
        const nextCollections = buildCollections(nextNotesById, state.noteIds, state.openTabIds, state.activeTabId);
        return {
          notesById: nextNotesById,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    renameFolderPath: (from, to) => {
      const fromPath = normalizeFolderPath(from);
      const toPath = normalizeFolderPath(to);
      if (!fromPath || fromPath === toPath) {
        return;
      }

      set((state) => {
        const nextNotesById = { ...state.notesById };
        let changed = false;

        state.noteIds.forEach((noteId) => {
          const note = nextNotesById[noteId];
          if (!note) {
            return;
          }

          if (note.folderPath === fromPath || note.folderPath.startsWith(`${fromPath}/`)) {
            nextNotesById[noteId] = {
              ...note,
              folderPath: note.folderPath.replace(fromPath, toPath),
              updatedAt: Date.now(),
              isDirty: true
            };
            changed = true;
          }
        });

        if (!changed) {
          return state;
        }

        const nextCollections = buildCollections(nextNotesById, state.noteIds, state.openTabIds, state.activeTabId);
        return {
          notesById: nextNotesById,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    clearFolderPath: (folderPath) => {
      const normalized = normalizeFolderPath(folderPath);
      if (!normalized) {
        return;
      }

      set((state) => {
        const nextNotesById = { ...state.notesById };
        let changed = false;

        state.noteIds.forEach((noteId) => {
          const note = nextNotesById[noteId];
          if (!note) {
            return;
          }

          if (note.folderPath === normalized || note.folderPath.startsWith(`${normalized}/`)) {
            nextNotesById[noteId] = {
              ...note,
              folderPath: "",
              updatedAt: Date.now(),
              isDirty: true
            };
            changed = true;
          }
        });

        if (!changed) {
          return state;
        }

        const nextCollections = buildCollections(nextNotesById, state.noteIds, state.openTabIds, state.activeTabId);
        return {
          notesById: nextNotesById,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    activateNextTab: () => {
      const { openTabIds, activeTabId, notesById, noteIds } = get();
      if (openTabIds.length <= 1) {
        return;
      }

      const currentIndex = openTabIds.findIndex((tabId) => tabId === activeTabId);
      if (currentIndex === -1) {
        const nextCollections = buildCollections(notesById, noteIds, openTabIds, openTabIds[0]);
        persistSession(nextCollections.openTabIds, nextCollections.activeTabId);
        set({
          activeTabId: nextCollections.activeTabId,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        });
        return;
      }

      const nextIndex = (currentIndex + 1) % openTabIds.length;
      const nextCollections = buildCollections(notesById, noteIds, openTabIds, openTabIds[nextIndex]);
      persistSession(nextCollections.openTabIds, nextCollections.activeTabId);
      set({
        activeTabId: nextCollections.activeTabId,
        allNotes: nextCollections.allNotes,
        openTabs: nextCollections.openTabs,
        activeOpenTab: nextCollections.activeOpenTab
      });
    },
    activatePrevTab: () => {
      const { openTabIds, activeTabId, notesById, noteIds } = get();
      if (openTabIds.length <= 1) {
        return;
      }

      const currentIndex = openTabIds.findIndex((tabId) => tabId === activeTabId);
      if (currentIndex === -1) {
        const nextCollections = buildCollections(notesById, noteIds, openTabIds, openTabIds[0]);
        persistSession(nextCollections.openTabIds, nextCollections.activeTabId);
        set({
          activeTabId: nextCollections.activeTabId,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        });
        return;
      }

      const prevIndex = (currentIndex - 1 + openTabIds.length) % openTabIds.length;
      const nextCollections = buildCollections(notesById, noteIds, openTabIds, openTabIds[prevIndex]);
      persistSession(nextCollections.openTabIds, nextCollections.activeTabId);
      set({
        activeTabId: nextCollections.activeTabId,
        allNotes: nextCollections.allNotes,
        openTabs: nextCollections.openTabs,
        activeOpenTab: nextCollections.activeOpenTab
      });
    },
    setTabTitle: (id, title) => {
      set((state) => {
        const target = state.notesById[id];
        if (!target) {
          return state;
        }

        const manualTitle = title.trim().slice(0, 50);
        const currentTitle = target.title.trim().slice(0, 50);

        let nextTab = target;
        if (manualTitle && manualTitle !== currentTitle) {
          nextTab = {
            ...target,
            title: manualTitle,
            isTitleManual: true,
            isDirty: true,
            updatedAt: Date.now()
          };
        } else if (!manualTitle) {
          const derived = deriveTitle(target.plainText);
          if (target.isTitleManual || target.title !== derived) {
            nextTab = {
              ...target,
              title: derived,
              isTitleManual: false,
              isDirty: true,
              updatedAt: Date.now()
            };
          }
        } else {
          return state;
        }

        const nextNotesById = { ...state.notesById, [id]: nextTab };
        const nextCollections = buildCollections(nextNotesById, state.noteIds, state.openTabIds, state.activeTabId);
        return {
          notesById: nextNotesById,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    setActiveTitle: (title) => {
      const activeTabId = get().activeTabId;
      if (!activeTabId) {
        return;
      }
      get().setTabTitle(activeTabId, title);
    },
    updateTabContent: (id, content, plainText) => {
      set((state) => {
        const target = state.notesById[id];
        if (!target) {
          return state;
        }

        const nextNotesById = {
          ...state.notesById,
          [id]: {
            ...target,
            content,
            plainText,
            title: target.isTitleManual ? target.title : deriveTitle(plainText),
            isDirty: true,
            updatedAt: Date.now()
          }
        };

        const nextCollections = buildCollections(nextNotesById, state.noteIds, state.openTabIds, state.activeTabId);
        return {
          notesById: nextNotesById,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    updateActiveContent: (content, plainText) => {
      const activeTabId = get().activeTabId;
      if (!activeTabId) {
        return;
      }
      get().updateTabContent(activeTabId, content, plainText);
    },
    markTabSaved: (id, options) => {
      set((state) => {
        const target = state.notesById[id];
        if (!target) {
          return state;
        }

        const nextPersistence = options?.persistence ?? target.persistence;
        const nextSourceFilePath = options?.sourceFilePath !== undefined ? options.sourceFilePath : target.sourceFilePath;
        const nextLastSavedAt = options?.lastSavedAt ?? Date.now();
        const savedTab: NoteTab = {
          ...target,
          persistence: nextPersistence,
          sourceFilePath: nextSourceFilePath,
          isDirty: false,
          lastSavedAt: nextLastSavedAt
        };
        const nextSavedSnapshot = createSavedSnapshot(savedTab);
        const nextNotesById = {
          ...state.notesById,
          [id]: {
            ...savedTab,
            savedSnapshot: nextSavedSnapshot
          }
        };

        let nextNoteIds = state.noteIds.filter((noteId) => noteId !== id);
        if (nextPersistence === "library") {
          nextNoteIds = [...nextNoteIds, id];
        }

        const nextCollections = buildCollections(nextNotesById, nextNoteIds, state.openTabIds, state.activeTabId);
        return {
          notesById: nextNotesById,
          noteIds: nextCollections.noteIds,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    discardTabChanges: (id) => {
      let result: DiscardTabResult = "none";

      set((state) => {
        const target = state.notesById[id];
        if (!target) {
          return state;
        }

        if (target.persistence === "transient" && !target.savedSnapshot) {
          result = "removed";
          const nextNotesById = { ...state.notesById };
          delete nextNotesById[id];
          const nextOpenTabIds = state.openTabIds.filter((openId) => openId !== id);
          const preferredActiveTabId = state.activeTabId === id ? (nextOpenTabIds[0] ?? null) : state.activeTabId;
          return buildStateSlice(nextNotesById, state.noteIds, nextOpenTabIds, preferredActiveTabId);
        }

        if (!target.savedSnapshot) {
          return state;
        }

        result = "reverted";
        const snapshot = target.savedSnapshot;
        const nextNotesById = {
          ...state.notesById,
          [id]: {
            ...target,
            title: snapshot.title,
            isTitleManual: snapshot.isTitleManual,
            content: snapshot.content,
            plainText: snapshot.plainText,
            folderPath: snapshot.folderPath,
            fileFormat: snapshot.fileFormat,
            sourceFilePath: snapshot.sourceFilePath,
            isDirty: false,
            updatedAt: snapshot.updatedAt,
            lastSavedAt: snapshot.lastSavedAt
          }
        };
        const nextCollections = buildCollections(nextNotesById, state.noteIds, state.openTabIds, state.activeTabId);
        return {
          notesById: nextNotesById,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });

      return result;
    },
    toggleFileFormat: (id) => {
      set((state) => {
        const target = state.notesById[id];
        if (!target) {
          return state;
        }

        const nextFileFormat: NoteTab["fileFormat"] = target.fileFormat === "md" ? "txt" : "md";
        const nextNotesById: Record<string, NoteTab> = {
          ...state.notesById,
          [id]: {
            ...target,
            fileFormat: nextFileFormat,
            isDirty: true,
            updatedAt: Date.now()
          }
        };

        const nextCollections = buildCollections(nextNotesById, state.noteIds, state.openTabIds, state.activeTabId);
        return {
          notesById: nextNotesById,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
      });
    },
    toggleSidebar: () => {
      set((state) => ({ sidebarVisible: !state.sidebarVisible }));
    }
  };
});
