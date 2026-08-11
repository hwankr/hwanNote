import { describe, expect, it, vi } from "vitest";
import { ensureCalendarSaved } from "./calendarSaveGuard";

describe("ensureCalendarSaved", () => {
  it("allows the protected action after a successful save", async () => {
    const onBlocked = vi.fn();
    const onError = vi.fn();

    await expect(ensureCalendarSaved({
      save: async () => "saved",
      onBlocked,
      onError,
    })).resolves.toBe(true);
    expect(onBlocked).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("blocks the protected action and reports a corruption guard", async () => {
    const onBlocked = vi.fn();
    const onError = vi.fn();

    await expect(ensureCalendarSaved({
      save: async () => "blocked",
      onBlocked,
      onError,
    })).resolves.toBe(false);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("blocks the protected action and reports a save error", async () => {
    const error = new Error("save failed");
    const onBlocked = vi.fn();
    const onError = vi.fn();

    await expect(ensureCalendarSaved({
      save: async () => { throw error; },
      onBlocked,
      onError,
    })).resolves.toBe(false);
    expect(onBlocked).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(error);
  });
});
