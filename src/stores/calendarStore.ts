import { create } from "zustand";
import { hwanNote } from "../lib/tauriApi";
import {
  compareCalendarTodoRows,
  createEmptyCalendarData,
  deriveCalendarTodoRows,
  formatDateKey,
  generateTodoId,
  groupCalendarTodoRows,
  isDateKey,
  isTodoOverdue,
  parseCalendarData,
  serializeCalendarData,
  type CalendarData,
  type CalendarTodoGroup,
  type CalendarTodoQueryOptions,
  type CalendarTodoRow,
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
  setTodoDueDate: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  clearTodoDueDate: (dateKey: string, todoId: string) => void;

  addNoteLink: (dateKey: string, noteId: string) => void;
  removeNoteLink: (dateKey: string, noteId: string) => void;
  removeNoteLinks: (noteId: string) => void;
  cleanOrphanNoteLinks: () => void;
}

export type CalendarStoreSelectorState = Pick<CalendarStore, "data">;

export function selectAllTodoRows(
  state: CalendarStoreSelectorState,
  options: CalendarTodoQueryOptions = {}
): CalendarTodoRow[] {
  return deriveCalendarTodoRows(state.data, options).sort((left, right) =>
    compareCalendarTodoRows(left, right, options)
  );
}

export function selectTodoRowsByGroup(
  state: CalendarStoreSelectorState,
  options: CalendarTodoQueryOptions = {}
): Record<CalendarTodoGroup, CalendarTodoRow[]> {
  return groupCalendarTodoRows(selectAllTodoRows(state, options), options);
}

export function selectOverdueTodoRows(
  state: CalendarStoreSelectorState,
  todayDateKey = formatDateKey(new Date())
): CalendarTodoRow[] {
  return selectAllTodoRows(state, { todayDateKey }).filter((row) => isTodoOverdue(row, todayDateKey));
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

function mutateAndSave(mutator: (data: CalendarData) => boolean) {
  const state = useCalendarStore.getState();
  const next = structuredClone(state.data);
  const changed = mutator(next);
  if (!changed) {
    return;
  }
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
        dueDateKey: null,
      });
      return true;
    });
  },

  updateTodo: (dateKey, todoId, updates) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return false;

      let changed = false;
      if (updates.text !== undefined && updates.text !== item.text) {
        item.text = updates.text;
        changed = true;
      }
      if (updates.done !== undefined && updates.done !== item.done) {
        item.done = updates.done;
        changed = true;
      }
      if (!changed) {
        return false;
      }
      item.updatedAt = Date.now();
      return true;
    });
  },

  deleteTodo: (dateKey, todoId) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const nextItems = day.items.filter((t) => t.id !== todoId);
      if (nextItems.length === day.items.length) {
        return false;
      }
      day.items = nextItems;
      if (day.items.length === 0) {
        delete data.todos[dateKey];
      }
      return true;
    });
  },

  toggleTodo: (dateKey, todoId) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return false;
      item.done = !item.done;
      item.updatedAt = Date.now();
      return true;
    });
  },

  setTodoDueDate: (dateKey, todoId, dueDateKey) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return false;

      if (dueDateKey !== null && !isDateKey(dueDateKey)) {
        console.warn("Ignored invalid dueDateKey update:", dueDateKey);
        return false;
      }

      const normalizedDueDateKey = dueDateKey;
      if (item.dueDateKey === normalizedDueDateKey) {
        return false;
      }

      item.dueDateKey = normalizedDueDateKey;
      item.updatedAt = Date.now();
      return true;
    });
  },

  clearTodoDueDate: (dateKey, todoId) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const item = day.items.find((t) => t.id === todoId);
      if (!item || item.dueDateKey === null) return false;
      item.dueDateKey = null;
      item.updatedAt = Date.now();
      return true;
    });
  },

  addNoteLink: (dateKey, noteId) => {
    mutateAndSave((data) => {
      if (!data.noteLinks[dateKey]) {
        data.noteLinks[dateKey] = [];
      }
      if (data.noteLinks[dateKey].includes(noteId)) {
        return false;
      }
      data.noteLinks[dateKey].push(noteId);
      return true;
    });
  },

  removeNoteLink: (dateKey, noteId) => {
    mutateAndSave((data) => {
      const links = data.noteLinks[dateKey];
      if (!links) return false;
      const nextLinks = links.filter((id) => id !== noteId);
      if (nextLinks.length === links.length) {
        return false;
      }
      data.noteLinks[dateKey] = nextLinks;
      if (data.noteLinks[dateKey].length === 0) {
        delete data.noteLinks[dateKey];
      }
      return true;
    });
  },

  removeNoteLinks: (noteId) => {
    mutateAndSave((data) => {
      let changed = false;
      for (const dateKey of Object.keys(data.noteLinks)) {
        const currentLinks = data.noteLinks[dateKey];
        const nextLinks = currentLinks.filter((id) => id !== noteId);
        if (nextLinks.length !== currentLinks.length) {
          changed = true;
        }
        data.noteLinks[dateKey] = nextLinks;
        if (data.noteLinks[dateKey].length === 0) {
          delete data.noteLinks[dateKey];
        }
      }
      return changed;
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
      let changed = false;
      for (const dateKey of Object.keys(d.noteLinks)) {
        const currentLinks = d.noteLinks[dateKey];
        const nextLinks = currentLinks.filter((id) => noteIds.has(id));
        if (nextLinks.length !== currentLinks.length) {
          changed = true;
        }
        d.noteLinks[dateKey] = nextLinks;
        if (d.noteLinks[dateKey].length === 0) {
          delete d.noteLinks[dateKey];
        }
      }
      return changed;
    });
  },
}));
