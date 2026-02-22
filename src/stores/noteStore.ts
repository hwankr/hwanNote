import { create } from "zustand";

export interface NoteTab {
  id: string;
  title: string;
  content: string;
  plainText: string;
  isDirty: boolean;
  isPinned: boolean;
  updatedAt: number;
}

interface NoteStore {
  tabs: NoteTab[];
  activeTabId: string;
  sidebarVisible: boolean;
  createTab: () => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  reorderTabs: (sourceId: string, targetId: string) => void;
  togglePinTab: (id: string) => void;
  activateNextTab: () => void;
  activatePrevTab: () => void;
  updateActiveContent: (content: string, plainText: string) => void;
  markTabSaved: (id: string) => void;
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
  return {
    id: createId(),
    title: "\uC81C\uBAA9 \uC5C6\uC74C",
    content: "<p></p>",
    plainText: "",
    isDirty: false,
    isPinned: false,
    updatedAt: Date.now()
  };
}

export const useNoteStore = create<NoteStore>((set, get) => {
  const firstTab = createEmptyTab();

  return {
    tabs: [firstTab],
    activeTabId: firstTab.id,
    sidebarVisible: false,
    createTab: () => {
      const tab = createEmptyTab();
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
    updateActiveContent: (content, plainText) => {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === state.activeTabId
            ? {
                ...tab,
                content,
                plainText,
                title: deriveTitle(plainText),
                isDirty: true,
                updatedAt: Date.now()
              }
            : tab
        )
      }));
    },
    markTabSaved: (id) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, isDirty: false } : tab))
      }));
    },
    toggleSidebar: () => {
      set((state) => ({ sidebarVisible: !state.sidebarVisible }));
    }
  };
});
