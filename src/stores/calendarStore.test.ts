import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyCalendarData,
  serializeCalendarData,
  type CalendarData,
} from "../lib/calendarData";

const calendarLoad = vi.fn();
const calendarSave = vi.fn();
const calendarBackup = vi.fn();
const calendarConfirmLoaded = vi.fn();
const calendarReset = vi.fn();

vi.mock("../lib/tauriApi", () => ({
  hwanNote: {
    calendar: {
      load: calendarLoad,
      save: calendarSave,
      backup: calendarBackup,
      confirmLoaded: calendarConfirmLoaded,
      reset: calendarReset,
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTodoData(): CalendarData {
  return {
    version: 4,
    todos: {
      "2026-08-11": {
        items: [
          {
            id: "todo-1",
            text: "existing",
            done: false,
            createdAt: 10,
            updatedAt: 10,
            dueDateKey: null,
            completedAt: null,
          },
        ],
      },
    },
    inbox: [],
    noteLinks: {},
  };
}

type CalendarStoreModule = typeof import("./calendarStore");
type CalendarStoreApi = ReturnType<CalendarStoreModule["useCalendarStore"]["getState"]> & {
  loadState: string;
  loadError: string | null;
  sourcePath: string | null;
  backupPath: string | null;
  saveCalendarData: () => Promise<"saved" | "blocked">;
  resetCalendarData: () => Promise<"saved" | "blocked">;
};

let useCalendarStore: CalendarStoreModule["useCalendarStore"];

async function importStore() {
  const module = await import("./calendarStore");
  useCalendarStore = module.useCalendarStore;
}

function storeState(): CalendarStoreApi {
  return useCalendarStore.getState() as unknown as CalendarStoreApi;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  calendarConfirmLoaded.mockResolvedValue(undefined);
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  await importStore();
  useCalendarStore.setState({
    data: createEmptyCalendarData(),
    selectedDate: "2026-08-11",
    currentMonth: new Date("2026-08-11T00:00:00.000Z"),
    loaded: false,
    loadedFrom: "local",
    cloudUnavailable: false,
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useCalendarStore corruption handling", () => {
  it("treats a missing calendar file as a new ready calendar", async () => {
    calendarLoad.mockResolvedValue({
      status: "missing",
      data: "",
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
      backupPath: null,
      error: null,
    });
    calendarSave.mockResolvedValue(undefined);

    await storeState().loadCalendarData();

    expect(storeState()).toMatchObject({
      data: createEmptyCalendarData(),
      loadState: "ready",
      loadError: null,
      sourcePath: "C:\\data\\calendar.json",
      backupPath: null,
    });
    expect(calendarBackup).not.toHaveBeenCalled();
    expect(calendarConfirmLoaded).toHaveBeenCalledWith(null, "local");
    await expect(storeState().saveCalendarData()).resolves.toBe("saved");
  });

  it("treats an existing empty calendar file as corrupt and backs it up", async () => {
    calendarLoad.mockResolvedValue({
      status: "ok",
      data: "",
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
      backupPath: null,
      error: null,
    });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");

    await storeState().loadCalendarData();

    expect(storeState()).toMatchObject({
      loadState: "corrupt",
      backupPath: "C:\\data\\calendar.json.bak",
    });
    expect(calendarBackup).toHaveBeenCalledWith("", "local");
    expect(calendarSave).not.toHaveBeenCalled();
  });

  it("preserves parse failure state and backs up the original raw data", async () => {
    calendarLoad.mockResolvedValue({
      status: "ok",
      data: "{",
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
    });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");

    await storeState().loadCalendarData();

    expect(storeState()).toMatchObject({
      data: createEmptyCalendarData(),
      loadState: "corrupt",
      loadError: expect.any(String),
      sourcePath: "C:\\data\\calendar.json",
      backupPath: "C:\\data\\calendar.json.bak",
    });
    expect(calendarBackup).toHaveBeenCalledWith("{", "local");
  });

  it("stays corrupt when backup creation fails during parse recovery", async () => {
    calendarLoad.mockResolvedValue({
      status: "ok",
      data: "{",
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
    });
    calendarBackup.mockRejectedValue(new Error("backup failed"));

    await storeState().loadCalendarData();

    expect(storeState()).toMatchObject({
      loadState: "corrupt",
      backupPath: null,
      sourcePath: "C:\\data\\calendar.json",
      loadError: expect.any(String),
    });
  });

  it("uses backend read_error backup metadata without invoking parse backup", async () => {
    calendarLoad.mockResolvedValue({
      status: "read_error",
      data: "",
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
      backupPath: "C:\\data\\calendar.json.read-error.bak",
      error: "Access denied",
    });

    await storeState().loadCalendarData();

    expect(storeState()).toMatchObject({
      data: createEmptyCalendarData(),
      loadState: "corrupt",
      loadError: "Access denied",
      sourcePath: "C:\\data\\calendar.json",
      backupPath: "C:\\data\\calendar.json.read-error.bak",
    });
    expect(calendarBackup).not.toHaveBeenCalled();
  });

  it("blocks explicit saves while corrupt", async () => {
    calendarLoad.mockResolvedValue({
      status: "ok",
      data: "{",
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
    });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");

    await storeState().loadCalendarData();

    await expect(storeState().saveCalendarData()).resolves.toBe("blocked");
    expect(calendarSave).not.toHaveBeenCalled();
  });

  it("ignores data mutations and does not schedule autosave while corrupt", async () => {
    calendarLoad.mockResolvedValue({
      status: "ok",
      data: "{",
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
    });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");

    await storeState().loadCalendarData();
    const before = storeState().data;

    storeState().createTodo("2026-08-12", "blocked change");
    vi.runAllTimers();

    expect(storeState().data).toEqual(before);
    expect(calendarSave).not.toHaveBeenCalled();
  });

  it("cancels an autosave that was scheduled before a corrupt reload", async () => {
    calendarLoad
      .mockResolvedValueOnce({
        status: "missing",
        data: "",
        loadedFrom: "local",
        cloudUnavailable: false,
        sourcePath: "C:\\data\\calendar.json",
        backupPath: null,
        error: null,
      })
      .mockResolvedValueOnce({
        status: "ok",
        data: "{",
        loadedFrom: "local",
        cloudUnavailable: false,
        sourcePath: "C:\\data\\calendar.json",
        backupPath: null,
        error: null,
      });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");

    await storeState().loadCalendarData();
    storeState().createTodo("2026-08-12", "pending change");
    await storeState().loadCalendarData();
    vi.runAllTimers();

    expect(storeState().loadState).toBe("corrupt");
    expect(calendarSave).not.toHaveBeenCalled();
  });

  it("writes empty data on reset and becomes ready only after save succeeds", async () => {
    const save = deferred<void>();
    calendarLoad.mockResolvedValue({
      status: "ok",
      data: "{",
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
    });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");
    calendarReset.mockReturnValue(save.promise);

    await storeState().loadCalendarData();
    const resetPromise = storeState().resetCalendarData();

    expect(storeState()).toMatchObject({
      loadState: "corrupt",
      backupPath: "C:\\data\\calendar.json.bak",
    });
    expect(calendarReset).toHaveBeenCalledWith(serializeCalendarData(createEmptyCalendarData()), "local");
    expect(calendarSave).not.toHaveBeenCalled();

    save.resolve(undefined);
    await expect(resetPromise).resolves.toBe("saved");
    expect(storeState()).toMatchObject({
      data: createEmptyCalendarData(),
      loadState: "ready",
      loadError: null,
      backupPath: null,
    });
  });

  it("remains corrupt when reset save fails", async () => {
    calendarLoad.mockResolvedValue({
      status: "ok",
      data: "{",
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
    });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");
    calendarReset.mockRejectedValue(new Error("save failed"));

    await storeState().loadCalendarData();

    await expect(storeState().resetCalendarData()).resolves.toBe("blocked");
    expect(storeState()).toMatchObject({
      loadState: "corrupt",
      backupPath: "C:\\data\\calendar.json.bak",
      sourcePath: "C:\\data\\calendar.json",
    });
    expect(calendarSave).not.toHaveBeenCalled();
  });

  it("clears corruption after a successful reload and allows save", async () => {
    calendarLoad
      .mockResolvedValueOnce({
        status: "ok",
        data: "{",
        loadedFrom: "local",
        cloudUnavailable: false,
        sourcePath: "C:\\data\\calendar.json",
      })
      .mockResolvedValueOnce({
        status: "ok",
        data: serializeCalendarData(createTodoData()),
        loadedFrom: "local",
        cloudUnavailable: false,
        sourcePath: "C:\\data\\calendar.json",
      });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");
    calendarSave.mockResolvedValue(undefined);

    await storeState().loadCalendarData();
    await storeState().loadCalendarData();

    expect(storeState()).toMatchObject({
      data: createTodoData(),
      loadState: "ready",
      loadError: null,
      sourcePath: "C:\\data\\calendar.json",
      backupPath: null,
    });
    expect(calendarConfirmLoaded).toHaveBeenCalledWith(
      serializeCalendarData(createTodoData()),
      "local"
    );
    await expect(storeState().saveCalendarData()).resolves.toBe("saved");
    expect(calendarSave).toHaveBeenCalledTimes(1);
  });

  it("stays corrupt when a successful reload cannot clear the recovery guard", async () => {
    calendarLoad
      .mockResolvedValueOnce({
        status: "ok",
        data: "{",
        loadedFrom: "local",
        cloudUnavailable: false,
        sourcePath: "C:\\data\\calendar.json",
      })
      .mockResolvedValueOnce({
        status: "ok",
        data: serializeCalendarData(createTodoData()),
        loadedFrom: "local",
        cloudUnavailable: false,
        sourcePath: "C:\\data\\calendar.json",
      });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");
    calendarConfirmLoaded.mockRejectedValueOnce(new Error("guard blocked"));

    await storeState().loadCalendarData();
    await storeState().loadCalendarData();

    expect(storeState()).toMatchObject({
      data: createTodoData(),
      loadState: "corrupt",
      loadError: expect.any(String),
      sourcePath: "C:\\data\\calendar.json",
      backupPath: null,
    });
    await expect(storeState().saveCalendarData()).resolves.toBe("blocked");
    expect(calendarSave).not.toHaveBeenCalled();
  });

  it("enters load_error when the load invocation itself fails and blocks save", async () => {
    calendarLoad.mockRejectedValue(new Error("invoke failed"));

    await storeState().loadCalendarData();

    expect(storeState()).toMatchObject({
      data: createEmptyCalendarData(),
      loadState: "load_error",
      loadError: expect.any(String),
      sourcePath: null,
      backupPath: null,
    });
    await expect(storeState().saveCalendarData()).resolves.toBe("blocked");
    expect(calendarSave).not.toHaveBeenCalled();
  });

  it("does not let an older load overwrite a newer corruption result", async () => {
    const olderLoad = deferred<{
      status: "ok";
      data: string;
      loadedFrom: "local";
      cloudUnavailable: false;
      sourcePath: string;
      backupPath: null;
      error: null;
    }>();
    calendarLoad
      .mockReturnValueOnce(olderLoad.promise)
      .mockResolvedValueOnce({
        status: "ok",
        data: "{",
        loadedFrom: "local",
        cloudUnavailable: false,
        sourcePath: "C:\\data\\calendar.json",
        backupPath: null,
        error: null,
      });
    calendarBackup.mockResolvedValue("C:\\data\\calendar.json.bak");

    const first = storeState().loadCalendarData();
    await storeState().loadCalendarData();
    olderLoad.resolve({
      status: "ok",
      data: serializeCalendarData(createTodoData()),
      loadedFrom: "local",
      cloudUnavailable: false,
      sourcePath: "C:\\data\\calendar.json",
      backupPath: null,
      error: null,
    });
    await first;

    expect(storeState()).toMatchObject({
      data: createEmptyCalendarData(),
      loadState: "corrupt",
      backupPath: "C:\\data\\calendar.json.bak",
    });
  });
});
