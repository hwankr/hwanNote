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

export type CalendarLoadState = "idle" | "loading" | "ready" | "corrupt" | "load_error";
export type CalendarSaveResult = "saved" | "blocked";

interface CalendarStore {
  data: CalendarData;
  selectedDate: string;
  currentMonth: Date;
  loaded: boolean;
  loadedFrom: CalendarStorageSource;
  cloudUnavailable: boolean;
  loadState: CalendarLoadState;
  loadError: string | null;
  sourcePath: string | null;
  backupPath: string | null;

  loadCalendarData: () => Promise<void>;
  saveCalendarData: () => Promise<CalendarSaveResult>;
  resetCalendarData: () => Promise<CalendarSaveResult>;

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
let loadRequestId = 0;
const CALENDAR_RECOVERY_GUARD_ERROR = "calendar.json recovery guard could not be cleared.";

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

function cancelPendingSave() {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingSave = false;
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

async function executeSave(options: ExecuteSaveOptions = {}): Promise<CalendarSaveResult> {
  if (useCalendarStore.getState().loadState !== "ready") {
    return "blocked";
  }

  if (isSaving) {
    pendingSave = true;
    if (options.throwOnError) {
      await waitForSaveIdle();
      return executeSave(options);
    }
    return "saved";
  }

  isSaving = true;
  try {
    const state = useCalendarStore.getState();
    if (state.loadState !== "ready") {
      return "blocked";
    }
    const json = serializeCalendarData(state.data);
    await hwanNote.calendar.save(json, state.loadedFrom);
    return "saved";
  } catch (error) {
    console.error("Failed to save calendar data:", error);
    if (options.throwOnError) {
      throw error;
    }
    return "blocked";
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
  if (state.loadState !== "ready") {
    return;
  }
  const next = structuredClone(state.data);
  const changed = mutator(next);
  if (!changed) {
    return;
  }
  useCalendarStore.setState({ data: next });
  scheduleSave();
}

async function confirmCalendarLoaded(
  data: string | null,
  loadedFrom: CalendarStorageSource
): Promise<boolean> {
  try {
    await hwanNote.calendar.confirmLoaded(data, loadedFrom);
    return true;
  } catch (error) {
    console.error("Failed to clear calendar recovery guard:", error);
    return false;
  }
}

export const useCalendarStore = create<CalendarStore>((set) => ({
  data: createEmptyCalendarData(),
  selectedDate: formatDateKey(new Date()),
  currentMonth: new Date(),
  loaded: false,
  loadedFrom: "local",
  cloudUnavailable: false,
  loadState: "idle",
  loadError: null,
  sourcePath: null,
  backupPath: null,

  loadCalendarData: async () => {
    const requestId = ++loadRequestId;
    cancelPendingSave();
    set({
      loaded: false,
      loadState: "loading",
      loadError: null,
      backupPath: null,
    });

    try {
      const result = await hwanNote.calendar.load();
      if (requestId !== loadRequestId) {
        return;
      }

      if (result.status === "missing") {
        const cleared = await confirmCalendarLoaded(null, result.loadedFrom);
        if (requestId !== loadRequestId) {
          return;
        }
        if (!cleared) {
          set({
            data: createEmptyCalendarData(),
            loaded: true,
            loadedFrom: result.loadedFrom,
            cloudUnavailable: result.cloudUnavailable,
            loadState: "corrupt",
            loadError: CALENDAR_RECOVERY_GUARD_ERROR,
            sourcePath: result.sourcePath,
            backupPath: null,
          });
          return;
        }
        set({
          data: createEmptyCalendarData(),
          loaded: true,
          loadedFrom: result.loadedFrom,
          cloudUnavailable: result.cloudUnavailable,
          loadState: "ready",
          loadError: null,
          sourcePath: result.sourcePath,
          backupPath: null,
        });
        return;
      }

      if (result.status === "read_error") {
        set({
          data: createEmptyCalendarData(),
          loaded: true,
          loadedFrom: result.loadedFrom,
          cloudUnavailable: result.cloudUnavailable,
          loadState: "corrupt",
          loadError: result.error ?? "calendar.json could not be read.",
          sourcePath: result.sourcePath,
          backupPath: result.backupPath,
        });
        return;
      }

      const parsed = parseCalendarData(result.data);
      if (!parsed.ok) {
        set({
          data: createEmptyCalendarData(),
          loaded: true,
          loadedFrom: result.loadedFrom,
          cloudUnavailable: result.cloudUnavailable,
          loadState: "corrupt",
          loadError: parsed.error.message,
          sourcePath: result.sourcePath,
          backupPath: null,
        });

        try {
          const backupPath = await hwanNote.calendar.backup(result.data, result.loadedFrom);
          if (requestId !== loadRequestId) {
            return;
          }
          const state = useCalendarStore.getState();
          if (state.loadState === "corrupt" && state.sourcePath === result.sourcePath) {
            set({ backupPath });
          }
        } catch (error) {
          console.error("Failed to back up invalid calendar data:", error);
        }
        return;
      }

      const cleared = await confirmCalendarLoaded(result.data, result.loadedFrom);
      if (requestId !== loadRequestId) {
        return;
      }
      if (!cleared) {
        set({
          data: parsed.data,
          loaded: true,
          loadedFrom: result.loadedFrom,
          cloudUnavailable: result.cloudUnavailable,
          loadState: "corrupt",
          loadError: CALENDAR_RECOVERY_GUARD_ERROR,
          sourcePath: result.sourcePath,
          backupPath: null,
        });
        return;
      }
      set({
        data: parsed.data,
        loaded: true,
        loadedFrom: result.loadedFrom,
        cloudUnavailable: result.cloudUnavailable,
        loadState: "ready",
        loadError: null,
        sourcePath: result.sourcePath,
        backupPath: null,
      });
    } catch (error) {
      if (requestId !== loadRequestId) {
        return;
      }
      console.error("Failed to load calendar data:", error);
      set({
        data: createEmptyCalendarData(),
        loaded: true,
        loadedFrom: "local",
        cloudUnavailable: false,
        loadState: "load_error",
        loadError: error instanceof Error ? error.message : String(error),
        sourcePath: null,
        backupPath: null,
      });
    }
  },

  saveCalendarData: async () => {
    cancelPendingSave();
    return executeSave({ throwOnError: true });
  },

  resetCalendarData: async () => {
    if (useCalendarStore.getState().loadState !== "corrupt") {
      return "blocked";
    }

    const requestId = ++loadRequestId;
    cancelPendingSave();
    if (isSaving) {
      await waitForSaveIdle();
    }

    const state = useCalendarStore.getState();
    if (state.loadState !== "corrupt") {
      return "blocked";
    }

    const data = createEmptyCalendarData();
    try {
      await hwanNote.calendar.reset(serializeCalendarData(data), state.loadedFrom);
      if (requestId === loadRequestId) {
        set({
          data,
          loaded: true,
          loadState: "ready",
          loadError: null,
          backupPath: null,
        });
      }
      return "saved";
    } catch (error) {
      console.error("Failed to reset calendar data:", error);
      return "blocked";
    }
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
