import { create } from "zustand";
import { hwanNote, type CalendarStorageSource } from "../lib/tauriApi";
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
  type TodoKind,
} from "../lib/calendarData";
import { useNoteStore } from "./noteStore";

const AUTO_SAVE_DELAY_MS = 1750;

interface CalendarStore {
  data: CalendarData;
  selectedDate: string;
  currentMonth: Date;
  loaded: boolean;
  loadedFrom: CalendarStorageSource;
  cloudUnavailable: boolean;

  loadCalendarData: () => Promise<void>;
  saveCalendarData: () => Promise<void>;

  setSelectedDate: (dateKey: string) => void;
  setCurrentMonth: (date: Date) => void;

  createTodo: (dateKey: string, text: string, kind?: TodoKind) => void;
  updateTodo: (dateKey: string, todoId: string, updates: Partial<Pick<TodoItem, "text" | "done">>) => void;
  deleteTodo: (dateKey: string, todoId: string) => void;
  toggleTodo: (dateKey: string, todoId: string) => void;
  setTodoDueDate: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  clearTodoDueDate: (dateKey: string, todoId: string) => void;
  setTodoShowSpan: (dateKey: string, todoId: string, showSpan: boolean) => void;
  createInboxTodo: (text: string) => void;
  updateInboxTodo: (todoId: string, updates: Partial<Pick<TodoItem, "text" | "done">>) => void;
  toggleInboxTodo: (todoId: string) => void;
  deleteInboxTodo: (todoId: string) => void;
  setInboxTodoDueDate: (todoId: string, dueDateKey: string | null) => void;

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

interface ExecuteSaveOptions {
  throwOnError?: boolean;
}

function scheduleSave() {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void executeSave();
  }, AUTO_SAVE_DELAY_MS);
}

function waitForSaveIdle(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!isSaving) {
        resolve();
        return;
      }
      window.setTimeout(check, 25);
    };
    check();
  });
}

async function executeSave(options: ExecuteSaveOptions = {}) {
  if (isSaving) {
    pendingSave = true;
    if (options.throwOnError) {
      await waitForSaveIdle();
      return executeSave(options);
    }
    return;
  }

  isSaving = true;
  try {
    const state = useCalendarStore.getState();
    const json = serializeCalendarData(state.data);
    await hwanNote.calendar.save(json, state.loadedFrom);
  } catch (error) {
    console.error("Failed to save calendar data:", error);
    if (options.throwOnError) {
      throw error;
    }
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
  loadedFrom: "local",
  cloudUnavailable: false,

  loadCalendarData: async () => {
    try {
      const result = await hwanNote.calendar.load();
      const data = parseCalendarData(result.data);
      set({
        data,
        loaded: true,
        loadedFrom: result.loadedFrom,
        cloudUnavailable: result.cloudUnavailable,
      });
    } catch {
      set({
        data: createEmptyCalendarData(),
        loaded: true,
        loadedFrom: "local",
        cloudUnavailable: false,
      });
    }
  },

  saveCalendarData: async () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    await executeSave({ throwOnError: true });
  },

  setSelectedDate: (dateKey) => set({ selectedDate: dateKey }),
  setCurrentMonth: (date) => set({ currentMonth: date }),

  createTodo: (dateKey, text, kind = "task") => {
    mutateAndSave((data) => {
      if (!data.todos[dateKey]) {
        data.todos[dateKey] = { items: [] };
      }
      const now = Date.now();
      const item: TodoItem = {
        id: generateTodoId(),
        text,
        done: false,
        createdAt: now,
        updatedAt: now,
        dueDateKey: null,
        completedAt: null,
      };
      if (kind !== "task") {
        item.kind = kind;
      }
      data.todos[dateKey].items.push(item);
      return true;
    });
  },

  updateTodo: (dateKey, todoId, updates) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return false;

      const itemKind: TodoKind = item.kind ?? "task";

      let changed = false;
      if (updates.text !== undefined && updates.text !== item.text) {
        item.text = updates.text;
        changed = true;
      }
      if (updates.done !== undefined && itemKind === "task" && updates.done !== item.done) {
        item.done = updates.done;
        item.completedAt = updates.done ? Date.now() : null;
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
      if ((item.kind ?? "task") !== "task") return false;
      item.done = !item.done;
      const now = Date.now();
      item.completedAt = item.done ? now : null;
      item.updatedAt = now;
      return true;
    });
  },

  setTodoDueDate: (dateKey, todoId, dueDateKey) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return false;
      if ((item.kind ?? "task") !== "task") return false;

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
      if ((item.kind ?? "task") !== "task") return false;
      item.dueDateKey = null;
      item.updatedAt = Date.now();
      return true;
    });
  },

  setTodoShowSpan: (dateKey, todoId, showSpan) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return false;
      if ((item.kind ?? "task") !== "task") return false;

      const nextShowSpan = showSpan ? undefined : false;
      if ((item.showSpan ?? undefined) === nextShowSpan) {
        return false;
      }

      if (nextShowSpan === undefined) {
        delete item.showSpan;
      } else {
        item.showSpan = nextShowSpan;
      }
      item.updatedAt = Date.now();
      return true;
    });
  },

  createInboxTodo: (text) => {
    mutateAndSave((data) => {
      const now = Date.now();
      data.inbox.push({
        id: generateTodoId(),
        text,
        done: false,
        createdAt: now,
        updatedAt: now,
        dueDateKey: null,
        completedAt: null,
      });
      return true;
    });
  },

  updateInboxTodo: (todoId, updates) => {
    mutateAndSave((data) => {
      const item = data.inbox.find((t) => t.id === todoId);
      if (!item) return false;

      let changed = false;
      if (updates.text !== undefined && updates.text !== item.text) {
        item.text = updates.text;
        changed = true;
      }
      if (updates.done !== undefined && updates.done !== item.done) {
        item.done = updates.done;
        item.completedAt = updates.done ? Date.now() : null;
        changed = true;
      }
      if (!changed) {
        return false;
      }
      item.updatedAt = Date.now();
      return true;
    });
  },

  toggleInboxTodo: (todoId) => {
    mutateAndSave((data) => {
      const item = data.inbox.find((t) => t.id === todoId);
      if (!item) return false;
      item.done = !item.done;
      const now = Date.now();
      item.completedAt = item.done ? now : null;
      item.updatedAt = now;
      return true;
    });
  },

  deleteInboxTodo: (todoId) => {
    mutateAndSave((data) => {
      const nextInbox = data.inbox.filter((t) => t.id !== todoId);
      if (nextInbox.length === data.inbox.length) {
        return false;
      }
      data.inbox = nextInbox;
      return true;
    });
  },

  setInboxTodoDueDate: (todoId, dueDateKey) => {
    mutateAndSave((data) => {
      const item = data.inbox.find((t) => t.id === todoId);
      if (!item) return false;

      if (dueDateKey !== null && !isDateKey(dueDateKey)) {
        console.warn("Ignored invalid dueDateKey update:", dueDateKey);
        return false;
      }

      if (item.dueDateKey === dueDateKey) {
        return false;
      }

      item.dueDateKey = dueDateKey;
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
