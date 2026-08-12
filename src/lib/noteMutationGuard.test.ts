import { describe, expect, it } from "vitest";
import { canRunNoteLibraryMutation } from "./noteMutationGuard";

describe("canRunNoteLibraryMutation", () => {
  it("allows destructive actions when recovery is idle", () => {
    expect(
      canRunNoteLibraryMutation({
        recoveryPending: false,
        recoveryInFlight: false,
        writesSuspended: false,
        loadedFrom: "cloud",
        currentSource: "cloud",
      })
    ).toBe(true);
  });

  it("blocks destructive actions while recovery is pending", () => {
    expect(
      canRunNoteLibraryMutation({
        recoveryPending: true,
        recoveryInFlight: false,
        writesSuspended: true,
        loadedFrom: "cloud",
        currentSource: "cloud",
      })
    ).toBe(false);
  });

  it("blocks destructive actions while recovery is in flight", () => {
    expect(
      canRunNoteLibraryMutation({
        recoveryPending: false,
        recoveryInFlight: true,
        writesSuspended: true,
        loadedFrom: "cloud",
        currentSource: "cloud",
      })
    ).toBe(false);
  });

  it("blocks destructive actions after the loaded source changes", () => {
    expect(
      canRunNoteLibraryMutation({
        recoveryPending: false,
        recoveryInFlight: false,
        writesSuspended: false,
        loadedFrom: "local_fallback",
        currentSource: "cloud",
      })
    ).toBe(false);
  });

  it("blocks destructive actions while library writes are suspended", () => {
    expect(
      canRunNoteLibraryMutation({
        recoveryPending: false,
        recoveryInFlight: false,
        writesSuspended: true,
        loadedFrom: "local",
        currentSource: "local",
      })
    ).toBe(false);
  });
});
