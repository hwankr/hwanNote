import { create } from "zustand";

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

interface NoteStore {
  tabs: NoteTab[];
  activeTabId: string;
  sidebarVisible: boolean;
  hydrateTabs: (tabs: NoteTab[]) => void;
  createTab: () => void;
  addImportedTab: (title: string, content: string, plainText: string, sourceFilePath?: string) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  reorderTabs: (sourceId: string, targetId: string) => void;
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
    return "\uC81C\uBAA9 \uC5C6\uC74C";
  }

  const stripped = firstLine.replace(/^#{1,3}\s+/, "");
  return stripped.slice(0, 50) || "\uC81C\uBAA9 \uC5C6\uC74C";
}

function createEmptyTab(): NoteTab {
  const now = Date.now();

  return {
    id: createId(),
    title: "\uC81C\uBAA9 \uC5C6\uC74C",
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

export const useNoteStore = create<NoteStore>((set, get) => {
  const firstTab = createEmptyTab();

  return {
    tabs: [firstTab],
    activeTabId: firstTab.id,
    sidebarVisible: false,
    hydrateTabs: (tabs) => {
      const normalizedTabs = tabs.length > 0 ? tabs : [createEmptyTab()];
      const currentActiveId = get().activeTabId;
      const nextActiveId = normalizedTabs.some((tab) => tab.id === currentActiveId)
        ? currentActiveId
        : normalizedTabs[0].id;

      set({
        tabs: normalizedTabs,
        activeTabId: nextActiveId
      });
    },
    createTab: () => {
      const tab = createEmptyTab();
      set((state) => ({
        tabs: [...state.tabs, tab],
        activeTabId: tab.id
      }));
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

      set((state) => ({
        tabs: [...state.tabs, tab],
        activeTabId: tab.id
      }));
    },
    setActiveTab: (id) => {
      if (get().tabs.some((tab) => tab.id === id)) {
        set({ activeTabId: id });
      }
    },
    closeTab: (id) => {
      set((state) => {
        const targetIndex = state.tabs.findIndex((tab) => tab.id === id);

        if (targetIndex === -1) {
          return state;
        }

        if (state.tabs.length === 1) {
          const freshTab = createEmptyTab();
          return {
            tabs: [freshTab],
            activeTabId: freshTab.id
          };
        }

        const nextTabs = state.tabs.filter((tab) => tab.id !== id);
        const fallbackIndex = Math.max(0, targetIndex - 1);
        const nextActiveId =
          state.activeTabId === id
            ? (nextTabs[fallbackIndex]?.id ?? nextTabs[0].id)
            : state.activeTabId;

        return {
          tabs: nextTabs,
          activeTabId: nextActiveId
        };
      });
    },
    closeOtherTabs: (id) => {
      set((state) => {
        const target = state.tabs.find((tab) => tab.id === id);
        if (!target) {
          return state;
        }

        const keptTabs = state.tabs.filter((tab) => tab.id === id || tab.isPinned);
        const dedupedTabs = keptTabs.filter(
          (tab, index, array) => array.findIndex((candidate) => candidate.id === tab.id) === index
        );

        const nextTabs = dedupedTabs.length > 0 ? dedupedTabs : [createEmptyTab()];
        const nextActiveId = nextTabs.some((tab) => tab.id === id) ? id : nextTabs[0].id;

        return {
          tabs: nextTabs,
          activeTabId: nextActiveId
        };
      });
    },
    reorderTabs: (sourceId, targetId) => {
      if (sourceId === targetId) {
        return;
      }

      set((state) => {
        const sourceIndex = state.tabs.findIndex((tab) => tab.id === sourceId);
        const targetIndex = state.tabs.findIndex((tab) => tab.id === targetId);

        if (sourceIndex === -1 || targetIndex === -1) {
          return state;
        }

        const nextTabs = [...state.tabs];
        const [movedTab] = nextTabs.splice(sourceIndex, 1);
        nextTabs.splice(targetIndex, 0, movedTab);

        return {
          tabs: nextTabs
        };
      });
    },
    togglePinTab: (id) => {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === id ? { ...tab, isPinned: !tab.isPinned, updatedAt: Date.now() } : tab
        )
      }));
    },
    moveTabToFolder: (id, folderPath) => {
      const normalized = folderPath.trim();

      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === id ? { ...tab, folderPath: normalized, updatedAt: Date.now(), isDirty: true } : tab
        )
      }));
    },
    renameFolderPath: (from, to) => {
      const fromPath = from.trim();
      const toPath = to.trim();
      if (!fromPath || fromPath === toPath) {
        return;
      }

      set((state) => ({
        tabs: state.tabs.map((tab) => {
          if (tab.folderPath === fromPath || tab.folderPath.startsWith(`${fromPath}/`)) {
            const nextFolderPath = tab.folderPath.replace(fromPath, toPath);
            return {
              ...tab,
              folderPath: nextFolderPath,
              updatedAt: Date.now(),
              isDirty: true
            };
          }

          return tab;
        })
      }));
    },
    clearFolderPath: (folderPath) => {
      const normalized = folderPath.trim();
      if (!normalized) {
        return;
      }

      set((state) => ({
        tabs: state.tabs.map((tab) => {
          if (tab.folderPath === normalized || tab.folderPath.startsWith(`${normalized}/`)) {
            return {
              ...tab,
              folderPath: "",
              updatedAt: Date.now(),
              isDirty: true
            };
          }

          return tab;
        })
      }));
    },
    activateNextTab: () => {
      const { tabs, activeTabId } = get();
      if (tabs.length <= 1) {
        return;
      }

      const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
      if (currentIndex === -1) {
        set({ activeTabId: tabs[0].id });
        return;
      }

      const nextIndex = (currentIndex + 1) % tabs.length;
      set({ activeTabId: tabs[nextIndex].id });
    },
    activatePrevTab: () => {
      const { tabs, activeTabId } = get();
      if (tabs.length <= 1) {
        return;
      }

      const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
      if (currentIndex === -1) {
        set({ activeTabId: tabs[0].id });
        return;
      }

      const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      set({ activeTabId: tabs[prevIndex].id });
    },
    setActiveTitle: (title) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => {
          if (tab.id !== state.activeTabId) {
            return tab;
          }

          const manualTitle = title.trim().slice(0, 50);
          const currentTitle = tab.title.trim().slice(0, 50);
          if (manualTitle && manualTitle === currentTitle) {
            return tab;
          }

          if (!manualTitle) {
            const derived = deriveTitle(tab.plainText);
            if (!tab.isTitleManual && tab.title === derived) {
              return tab;
            }

            return {
              ...tab,
              title: derived,
              isTitleManual: false,
              isDirty: true,
              updatedAt: Date.now()
            };
          }

          if (tab.isTitleManual && tab.title === manualTitle) {
            return tab;
          }

          return {
            ...tab,
            title: manualTitle,
            isTitleManual: true,
            isDirty: true,
            updatedAt: Date.now()
          };
        })
      }));
    },
    updateActiveContent: (content, plainText) => {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === state.activeTabId
            ? {
                ...tab,
                content,
                plainText,
                title: tab.isTitleManual ? tab.title : deriveTitle(plainText),
                isDirty: true,
                updatedAt: Date.now()
              }
            : tab
        )
      }));
    },
    markTabSaved: (id) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, isDirty: false, lastSavedAt: Date.now() } : tab))
      }));
    },
    toggleFileFormat: (id) => {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === id
            ? { ...tab, fileFormat: tab.fileFormat === "md" ? "txt" : "md", isDirty: true, updatedAt: Date.now() }
            : tab
        )
      }));
    },
    toggleSidebar: () => {
      set((state) => ({ sidebarVisible: !state.sidebarVisible }));
    }
  };
});
