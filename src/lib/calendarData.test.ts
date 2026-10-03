import { describe, expect, it } from "vitest";
import {
  CALENDAR_DATA_VERSION,
  parseCalendarData,
} from "./calendarData";

describe("parseCalendarData", () => {
  it("returns a parse failure when an existing file is blank", () => {
    const result = parseCalendarData("   ");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "empty_file",
        message: expect.any(String),
      },
    });
  });

  it("returns a parse failure when the JSON is malformed", () => {
    const result = parseCalendarData("{");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected parse failure");
    }
    expect(result.error).toMatchObject({
      code: "invalid_json",
      message: expect.any(String),
    });
  });

  it("returns a failure when the parsed root is not an object", () => {
    const result = parseCalendarData("[]");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid-root failure");
    }
    expect(result.error).toMatchObject({
      code: "invalid_root",
      message: expect.any(String),
    });
  });

  it("returns a failure when version metadata is missing without a migratable shape", () => {
    const result = parseCalendarData(JSON.stringify({ inbox: [] }));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected missing-version failure");
    }
    expect(result.error).toMatchObject({
      code: "missing_version",
      message: expect.any(String),
    });
  });

  it("returns a failure when the numeric version is unsupported", () => {
    const result = parseCalendarData(JSON.stringify({ version: 999, todos: {}, inbox: [], noteLinks: {} }));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected unsupported-version failure");
    }
    expect(result.error).toMatchObject({
      code: "unsupported_version",
      message: expect.any(String),
    });
  });

  it("returns a failure instead of normalizing an invalid current schema to empty data", () => {
    const result = parseCalendarData(JSON.stringify({
      version: CALENDAR_DATA_VERSION,
      todos: [],
      inbox: [],
      noteLinks: {},
    }));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_schema",
        message: expect.any(String),
      },
    });
  });

  it("migrates legacy versioned data into the current calendar schema", () => {
    const result = parseCalendarData(
      JSON.stringify({
        version: 1,
        todos: {
          "2026-08-11": {
            items: [
              {
                id: "todo-1",
                text: "legacy",
                done: false,
                createdAt: 10,
                updatedAt: 20,
              },
            ],
          },
        },
        noteLinks: {
          "2026-08-11": ["note-1"],
        },
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected migration success");
    }
    expect(result.data).toEqual({
      version: CALENDAR_DATA_VERSION,
      todos: {
        "2026-08-11": {
          items: [
            {
              id: "todo-1",
              text: "legacy",
              done: false,
              createdAt: 10,
              updatedAt: 20,
              dueDateKey: null,
              completedAt: null,
            },
          ],
        },
      },
      inbox: [],
      noteLinks: {
        "2026-08-11": ["note-1"],
      },
    });
  });

  it.each([
    { name: "missing task ID", day: { items: [{ text: "recoverable task" }] } },
    { name: "empty task ID", day: { items: [{ id: "", text: "recoverable task" }] } },
    { name: "invalid task text", day: { items: [{ id: "task", text: 123 }] } },
    { name: "items object", day: { items: { id: "task", text: "recoverable task" } } },
    { name: "missing items", day: {} },
    { name: "null day", day: null },
    { name: "duplicate task IDs", day: { items: [{ id: "task", text: "first" }, { id: "task", text: "second" }] } },
  ])("rejects $name instead of silently losing task data", ({ day }) => {
    const result = parseCalendarData(JSON.stringify({
      version: CALENDAR_DATA_VERSION,
      todos: { "2026-08-11": day },
      inbox: [],
      noteLinks: {},
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
  });

  it.each([
    { inbox: [{ text: "inbox task without ID" }] },
    { noteLinks: { "2026-08-11": ["note-1", null] } },
    { noteLinks: { "2026-08-11": "note-1" } },
    { todos: { "2026-02-30": { items: [{ id: "task", text: "invalid date" }] } } },
    { inbox: [{ id: "task", text: "invalid due date", dueDateKey: "2026-02-30" }] },
    { inbox: [{ id: "task", text: "invalid completion flag", done: "true" }] },
    { inbox: [{ id: "task", text: "invalid timestamp", updatedAt: "yesterday" }] },
  ])("rejects malformed nested calendar data: %j", (invalidFields) => {
    const result = parseCalendarData(JSON.stringify({
      version: CALENDAR_DATA_VERSION,
      todos: {},
      inbox: [],
      noteLinks: {},
      ...invalidFields,
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
  });

  it.each([undefined, 1, 2, 3, 4])("keeps legacy optional fields compatible for version %s", (version) => {
    const result = parseCalendarData(JSON.stringify({
      ...(version === undefined ? {} : { version }),
      todos: { "2026-08-11": { items: [{ id: "legacy", text: "retained" }] } },
      ...(version !== undefined && version >= 3 ? { inbox: [] } : {}),
      noteLinks: { "2026-08-11": ["note-1"] },
    }));

    expect(result).toMatchObject({
      ok: true,
      data: {
        version: CALENDAR_DATA_VERSION,
        todos: { "2026-08-11": { items: [{ id: "legacy", text: "retained", done: false, dueDateKey: null }] } },
        noteLinks: { "2026-08-11": ["note-1"] },
      },
    });
  });

  it.each([undefined, 1, 2, 3])("also protects malformed legacy version %s task data", (version) => {
    const result = parseCalendarData(JSON.stringify({
      ...(version === undefined ? {} : { version }),
      todos: { "2026-08-11": { items: [{ text: "recoverable legacy text" }] } },
      ...(version === 3 ? { inbox: [] } : {}),
      noteLinks: {},
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
  });

  it.each(["event", "deadline"])("rejects a current inbox %s instead of converting it to a task", (kind) => {
    const result = parseCalendarData(JSON.stringify({
      version: CALENDAR_DATA_VERSION,
      todos: {},
      inbox: [{ id: "task-1", text: "keep my kind", kind }],
      noteLinks: {},
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
  });

  it.each([
    { done: true },
    { dueDateKey: "2026-08-12" },
    { completedAt: 123 },
    { showSpan: true },
    { showSpan: false },
  ])("rejects task-only event state instead of discarding it: %j", (taskState) => {
    for (const kind of ["event", "deadline"]) {
      const result = parseCalendarData(JSON.stringify({
        version: CALENDAR_DATA_VERSION,
        todos: { "2026-08-11": { items: [{ id: "event-1", text: "preserve metadata", kind, ...taskState }] } },
        inbox: [],
        noteLinks: {},
      }));
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
    }
  });

  it.each(["event", "deadline"])("keeps valid current %s metadata unchanged", (kind) => {
    const item = { id: "event-1", text: "valid date item", kind, done: false, dueDateKey: null, completedAt: null };
    const result = parseCalendarData(JSON.stringify({
      version: CALENDAR_DATA_VERSION,
      todos: { "2026-08-11": { items: [item] } },
      inbox: [],
      noteLinks: {},
    }));

    expect(result).toMatchObject({ ok: true, data: { todos: { "2026-08-11": { items: [item] } } } });
  });

  it("accepts the current versioned schema", () => {
    const current = {
      version: CALENDAR_DATA_VERSION,
      todos: {},
      inbox: [],
      noteLinks: {},
    };

    const result = parseCalendarData(JSON.stringify(current));

    expect(result).toEqual({ ok: true, data: current });
  });
});
