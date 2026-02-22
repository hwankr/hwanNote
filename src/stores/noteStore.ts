import { create } from "zustand";

export interface NoteTab {
  id: string;
  title: string;
  content: string;
  plainText: string;
  isDirty: boolean;
  updatedAt: number;
}

interface NoteStore {
  tabs: NoteTab[];
  activeTabId: string;
  sidebarVisible: boolean;
  createTab: () => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
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
    return "제목 없음";
  }

  const stripped = firstLine.replace(/^#{1,3}\s+/, "");
  return stripped.slice(0, 50) || "제목 없음";
}

function createEmptyTab(): NoteTab {
  return {
    id: createId(),
    title: "제목 없음",
    content: "<p></p>",
    plainText: "",
    isDirty: false,
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
