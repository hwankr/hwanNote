import { create } from "zustand";

export const OPEN_TAB_IDS_KEY = "hwan-note:open-tab-ids";
export const ACTIVE_TAB_ID_KEY = "hwan-note:active-tab-id";

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
}

export interface PersistedTabSession {
  openTabIds: string[];
  activeTabId: string | null;
}

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
  setActiveTitle: (title: string) => void;
  updateActiveContent: (content: string, plainText: string) => void;
  markTabSaved: (id: string) => void;
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
    fileFormat: "md"
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
  const normalizedOpenTabIds = dedupeIds(openTabIds.filter((id) => Boolean(notesById[id])));
  const normalizedActiveTabId =
    activeTabId && normalizedOpenTabIds.includes(activeTabId) ? activeTabId : (normalizedOpenTabIds[0] ?? null);
  const allNotes = noteIds.map((id) => notesById[id]).filter(Boolean);
  const openTabs = normalizedOpenTabIds.map((id) => notesById[id]).filter(Boolean);

  return {
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

export const useNoteStore = create<NoteStore>((set, get) => {
  const firstTab = createEmptyTab();
  const notesById: Record<string, NoteTab> = { [firstTab.id]: firstTab };
  const noteIds = [firstTab.id];
  const openTabIds = [firstTab.id];
  const baseCollections = buildCollections(notesById, noteIds, openTabIds, firstTab.id);

  return {
    notesById,
    noteIds,
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
        nextNoteIds.push(tab.id);
      });

      const session = persistedSession ?? readTabSessionFromStorage();
      let nextOpenTabIds = session.openTabIds.filter((id) => Boolean(nextNotesById[id]));
      if (nextOpenTabIds.length === 0) {
        nextOpenTabIds = [nextNoteIds[0]];
      }

      const nextActiveTabId =
        session.activeTabId && nextOpenTabIds.includes(session.activeTabId)
          ? session.activeTabId
          : nextOpenTabIds[0];

      const nextCollections = buildCollections(nextNotesById, nextNoteIds, nextOpenTabIds, nextActiveTabId);
      persistSession(nextCollections.openTabIds, nextCollections.activeTabId);

      set({
        notesById: nextNotesById,
        noteIds: nextNoteIds,
        openTabIds: nextCollections.openTabIds,
        activeTabId: nextCollections.activeTabId,
        allNotes: nextCollections.allNotes,
        openTabs: nextCollections.openTabs,
        activeOpenTab: nextCollections.activeOpenTab
      });
    },
    createTab: () => {
      const tab = createEmptyTab();
      set((state) => {
        const nextNotesById = { ...state.notesById, [tab.id]: tab };
        const nextNoteIds = [...state.noteIds, tab.id];
        const nextOpenTabIds = [...state.openTabIds, tab.id];
        const nextCollections = buildCollections(nextNotesById, nextNoteIds, nextOpenTabIds, tab.id);
        persistSession(nextCollections.openTabIds, nextCollections.activeTabId);

        return {
          notesById: nextNotesById,
          noteIds: nextNoteIds,
          openTabIds: nextCollections.openTabIds,
          activeTabId: nextCollections.activeTabId,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
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
        isDirty: true,
        isPinned: false,
        folderPath: "",
        createdAt: now,
        updatedAt: now,
        lastSavedAt: 0,
        sourceFilePath,
        fileFormat: sourceFilePath ? ("txt" as const) : ("md" as const)
      };

      set((state) => {
        const nextNotesById = { ...state.notesById, [tab.id]: tab };
        const nextNoteIds = [...state.noteIds, tab.id];
        const nextOpenTabIds = [...state.openTabIds, tab.id];
        const nextCollections = buildCollections(nextNotesById, nextNoteIds, nextOpenTabIds, tab.id);
        persistSession(nextCollections.openTabIds, nextCollections.activeTabId);

        return {
          notesById: nextNotesById,
          noteIds: nextNoteIds,
          openTabIds: nextCollections.openTabIds,
          activeTabId: nextCollections.activeTabId,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
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

        let nextOpenTabIds = state.openTabIds.filter((openId) => openId !== id);
        if (nextOpenTabIds.length === 0) {
          if (state.noteIds.length === 0) {
            const freshTab = createEmptyTab();
            const nextNotesById = { [freshTab.id]: freshTab };
            const nextNoteIds = [freshTab.id];
            const freshCollections = buildCollections(nextNotesById, nextNoteIds, nextNoteIds, freshTab.id);
            persistSession(freshCollections.openTabIds, freshCollections.activeTabId);

            return {
              notesById: nextNotesById,
              noteIds: nextNoteIds,
              openTabIds: freshCollections.openTabIds,
              activeTabId: freshCollections.activeTabId,
              allNotes: freshCollections.allNotes,
              openTabs: freshCollections.openTabs,
              activeOpenTab: freshCollections.activeOpenTab
            };
          }

          const fallbackOpenId = state.noteIds.find((noteId) => noteId !== id) ?? state.noteIds[0];
          nextOpenTabIds = [fallbackOpenId];
        }

        const fallbackIndex = Math.max(0, targetIndex - 1);
        const nextActiveTabId =
          state.activeTabId === id ? (nextOpenTabIds[fallbackIndex] ?? nextOpenTabIds[0]) : state.activeTabId;
        const nextCollections = buildCollections(state.notesById, state.noteIds, nextOpenTabIds, nextActiveTabId);
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
    closeOtherTabs: (id) => {
      set((state) => {
        if (!state.openTabIds.includes(id)) {
          return state;
        }

        const nextOpenTabIds = state.openTabIds.filter(
          (openId) => openId === id || state.notesById[openId]?.isPinned === true
        );
        const nextCollections = buildCollections(state.notesById, state.noteIds, nextOpenTabIds, id);
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
        let nextNoteIds = state.noteIds.filter((noteId) => noteId !== id);
        let nextOpenTabIds = state.openTabIds.filter((openId) => openId !== id);

        if (nextNoteIds.length === 0) {
          const freshTab = createEmptyTab();
          nextNotesById[freshTab.id] = freshTab;
          nextNoteIds = [freshTab.id];
          nextOpenTabIds = [freshTab.id];
        } else if (nextOpenTabIds.length === 0) {
          nextOpenTabIds = [nextNoteIds[0]];
        }

        const nextActiveTabId = state.activeTabId === id ? nextOpenTabIds[0] : state.activeTabId;
        const nextCollections = buildCollections(nextNotesById, nextNoteIds, nextOpenTabIds, nextActiveTabId);
        persistSession(nextCollections.openTabIds, nextCollections.activeTabId);

        return {
          notesById: nextNotesById,
          noteIds: nextNoteIds,
          openTabIds: nextCollections.openTabIds,
          activeTabId: nextCollections.activeTabId,
          allNotes: nextCollections.allNotes,
          openTabs: nextCollections.openTabs,
          activeOpenTab: nextCollections.activeOpenTab
        };
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
      const normalized = folderPath.trim();

      set((state) => {
        const target = state.notesById[id];
        if (!target) {
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
      const fromPath = from.trim();
      const toPath = to.trim();
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
      const normalized = folderPath.trim();
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
    setActiveTitle: (title) => {
      set((state) => {
        if (!state.activeTabId) {
          return state;
        }

        const active = state.notesById[state.activeTabId];
        if (!active) {
          return state;
        }

        const manualTitle = title.trim().slice(0, 50);
        const currentTitle = active.title.trim().slice(0, 50);

        let nextActive = active;
        if (manualTitle && manualTitle !== currentTitle) {
          nextActive = {
            ...active,
            title: manualTitle,
            isTitleManual: true,
            isDirty: true,
            updatedAt: Date.now()
          };
        } else if (!manualTitle) {
          const derived = deriveTitle(active.plainText);
          if (active.isTitleManual || active.title !== derived) {
            nextActive = {
              ...active,
              title: derived,
              isTitleManual: false,
              isDirty: true,
              updatedAt: Date.now()
            };
          }
        } else {
          return state;
        }

        const nextNotesById = { ...state.notesById, [active.id]: nextActive };
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
      set((state) => {
        if (!state.activeTabId) {
          return state;
        }

        const active = state.notesById[state.activeTabId];
        if (!active) {
          return state;
        }

        const nextNotesById = {
          ...state.notesById,
          [active.id]: {
            ...active,
            content,
            plainText,
            title: active.isTitleManual ? active.title : deriveTitle(plainText),
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
    markTabSaved: (id) => {
      set((state) => {
        const target = state.notesById[id];
        if (!target) {
          return state;
        }

        const nextNotesById = {
          ...state.notesById,
          [id]: {
            ...target,
            isDirty: false,
            lastSavedAt: Date.now()
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
