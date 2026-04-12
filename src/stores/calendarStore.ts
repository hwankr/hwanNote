import { create } from "zustand";
import { hwanNote } from "../lib/tauriApi";
import {
  createEmptyCalendarData,
  formatDateKey,
  generateTodoId,
  parseCalendarData,
  serializeCalendarData,
  type CalendarData,
  type TodoItem,
} from "../lib/calendarData";
import { useNoteStore } from "./noteStore";

const AUTO_SAVE_DELAY_MS = 1750;

interface CalendarStore {
  data: CalendarData;
  selectedDate: string;
  currentMonth: Date;
  loaded: boolean;

  loadCalendarData: () => Promise<void>;
  saveCalendarData: () => Promise<void>;

  setSelectedDate: (dateKey: string) => void;
  setCurrentMonth: (date: Date) => void;

  createTodo: (dateKey: string, text: string) => void;
  updateTodo: (dateKey: string, todoId: string, updates: Partial<Pick<TodoItem, "text" | "done">>) => void;
  deleteTodo: (dateKey: string, todoId: string) => void;
  toggleTodo: (dateKey: string, todoId: string) => void;

  addNoteLink: (dateKey: string, noteId: string) => void;
  removeNoteLink: (dateKey: string, noteId: string) => void;
  removeNoteLinks: (noteId: string) => void;
  cleanOrphanNoteLinks: () => void;
}

let saveTimer: number | null = null;
let isSaving = false;
let pendingSave = false;

function scheduleSave() {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void executeSave();
  }, AUTO_SAVE_DELAY_MS);
}

async function executeSave() {
  if (isSaving) {
    pendingSave = true;
    return;
  }

  isSaving = true;
  try {
    const state = useCalendarStore.getState();
    const json = serializeCalendarData(state.data);
    await hwanNote.calendar.save(json);
  } catch (error) {
    console.error("Failed to save calendar data:", error);
  } finally {
    isSaving = false;
    if (pendingSave) {
      pendingSave = false;
      void executeSave();
    }
  }
}

function mutateAndSave(mutator: (data: CalendarData) => void) {
  const state = useCalendarStore.getState();
  const next = structuredClone(state.data);
  mutator(next);
  useCalendarStore.setState({ data: next });
  scheduleSave();
}

export const useCalendarStore = create<CalendarStore>((set) => ({
  data: createEmptyCalendarData(),
  selectedDate: formatDateKey(new Date()),
  currentMonth: new Date(),
  loaded: false,

  loadCalendarData: async () => {
    try {
      const raw = await hwanNote.calendar.load();
      const data = parseCalendarData(raw);
      set({ data, loaded: true });
    } catch {
      set({ data: createEmptyCalendarData(), loaded: true });
    }
  },

  saveCalendarData: async () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    await executeSave();
  },

  setSelectedDate: (dateKey) => set({ selectedDate: dateKey }),
  setCurrentMonth: (date) => set({ currentMonth: date }),

  createTodo: (dateKey, text) => {
    mutateAndSave((data) => {
      if (!data.todos[dateKey]) {
        data.todos[dateKey] = { items: [] };
      }
      const now = Date.now();
      data.todos[dateKey].items.push({
        id: generateTodoId(),
        text,
        done: false,
        createdAt: now,
        updatedAt: now,
      });
    });
  },

  updateTodo: (dateKey, todoId, updates) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return;
      if (updates.text !== undefined) item.text = updates.text;
      if (updates.done !== undefined) item.done = updates.done;
      item.updatedAt = Date.now();
    });
  },

  deleteTodo: (dateKey, todoId) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return;
      day.items = day.items.filter((t) => t.id !== todoId);
      if (day.items.length === 0) {
        delete data.todos[dateKey];
      }
    });
  },

  toggleTodo: (dateKey, todoId) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return;
      item.done = !item.done;
      item.updatedAt = Date.now();
    });
  },

  addNoteLink: (dateKey, noteId) => {
    mutateAndSave((data) => {
      if (!data.noteLinks[dateKey]) {
        data.noteLinks[dateKey] = [];
      }
      if (!data.noteLinks[dateKey].includes(noteId)) {
        data.noteLinks[dateKey].push(noteId);
      }
    });
  },

  removeNoteLink: (dateKey, noteId) => {
    mutateAndSave((data) => {
      const links = data.noteLinks[dateKey];
      if (!links) return;
      data.noteLinks[dateKey] = links.filter((id) => id !== noteId);
      if (data.noteLinks[dateKey].length === 0) {
        delete data.noteLinks[dateKey];
      }
    });
  },

  removeNoteLinks: (noteId) => {
    mutateAndSave((data) => {
      for (const dateKey of Object.keys(data.noteLinks)) {
        data.noteLinks[dateKey] = data.noteLinks[dateKey].filter((id) => id !== noteId);
        if (data.noteLinks[dateKey].length === 0) {
          delete data.noteLinks[dateKey];
        }
      }
    });
  },

  cleanOrphanNoteLinks: () => {
    const noteIds = new Set(Object.keys(useNoteStore.getState().notesById));
    const { data } = useCalendarStore.getState();
    let hasOrphans = false;

    for (const dateKey of Object.keys(data.noteLinks)) {
      for (const id of data.noteLinks[dateKey]) {
        if (!noteIds.has(id)) {
          hasOrphans = true;
          break;
        }
      }
      if (hasOrphans) break;
    }

    if (!hasOrphans) return;

    mutateAndSave((d) => {
      for (const dateKey of Object.keys(d.noteLinks)) {
        d.noteLinks[dateKey] = d.noteLinks[dateKey].filter((id) => noteIds.has(id));
        if (d.noteLinks[dateKey].length === 0) {
          delete d.noteLinks[dateKey];
        }
      }
    });
  },
}));
