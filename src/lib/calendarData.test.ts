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
