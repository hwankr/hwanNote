import type { JSONContent } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import type { NoteTab } from "../stores/noteStore";
import { mergeRecoveredNoteTabs } from "./noteRecovery";

function documentWithText(text: string): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text ? [{ type: "text", text }] : []
      }
    ]
  };
}

function createTab(overrides: Partial<NoteTab> = {}): NoteTab {
  const plainText = overrides.plainText ?? "same content";

  return {
    id: "note-1",
    revision: 0,
    title: "Same title",
    isTitleManual: true,
    content: documentWithText(plainText),
    plainText,
    isDirty: false,
    isPinned: false,
    folderPath: "",
    createdAt: 1_000,
    updatedAt: 2_000,
    lastSavedAt: 2_000,
    fileFormat: "md",
    persistence: "library",
    savedSnapshot: null,
    ...overrides
  };
}

describe("mergeRecoveredNoteTabs", () => {
  it("uses the authoritative tabs without a recovery copy when user-visible state is unchanged", () => {
    const reloaded = createTab();
    const current = createTab({
      revision: 7,
      isDirty: true,
      updatedAt: 9_000,
      lastSavedAt: 8_000
    });
    const createId = vi.fn(() => "recovery-1");

    const result = mergeRecoveredNoteTabs({
      reloadedLibraryTabs: [reloaded],
      currentTabs: [current],
      currentSession: { openTabIds: [current.id], activeTabId: current.id },
      createId,
      recoveryTitle: (title) => `${title} (recovered)`
    });

    expect(result).toEqual({
      tabs: [reloaded],
      session: { openTabIds: [reloaded.id], activeTabId: reloaded.id },
      recoveredCount: 0
    });
    expect(createId).not.toHaveBeenCalled();
  });

  it("keeps the cloud note and creates an active unsaved copy for a same-ID conflict", () => {
    const reloaded = createTab({ plainText: "cloud", content: documentWithText("cloud") });
    const current = createTab({
      title: "Local title",
      plainText: "local edit",
      content: documentWithText("local edit"),
      folderPath: "local-folder",
      isPinned: true,
      revision: 4,
      isDirty: false,
      sourceFilePath: "C:\\fallback\\note.md",
      savedSnapshot: {
        revision: 4,
        title: "Local title",
        isTitleManual: true,
        content: documentWithText("local edit"),
        plainText: "local edit",
        folderPath: "local-folder",
        fileFormat: "md",
        sourceFilePath: "C:\\fallback\\note.md",
        updatedAt: 5_000,
        lastSavedAt: 5_000
      }
    });
    const recoveryTitle = vi.fn((title: string) => `[Recovered] ${title}`);

    const result = mergeRecoveredNoteTabs({
      reloadedLibraryTabs: [reloaded],
      currentTabs: [current],
      currentSession: { openTabIds: [current.id], activeTabId: current.id },
      createId: () => "recovery-1",
      recoveryTitle
    });

    expect(result.recoveredCount).toBe(1);
    expect(result.tabs[0]).toBe(reloaded);
    expect(result.tabs[1]).toMatchObject({
      id: "recovery-1",
      revision: 0,
      title: "[Recovered] Local title",
      isTitleManual: true,
      content: documentWithText("local edit"),
      plainText: "local edit",
      isDirty: true,
      isPinned: true,
      folderPath: "local-folder",
      lastSavedAt: 0,
      persistence: "transient",
      savedSnapshot: null,
      sourceFilePath: undefined
    });
    expect(result.session).toEqual({
      openTabIds: [reloaded.id, "recovery-1"],
      activeTabId: "recovery-1"
    });
    expect(recoveryTitle).toHaveBeenCalledWith("Local title");
  });

  it("recovers a local-only library note whose ID is absent from the cloud", () => {
    const reloaded = createTab({ id: "cloud-note" });
    const localOnly = createTab({ id: "local-only", plainText: "not in cloud", content: documentWithText("not in cloud") });

    const result = mergeRecoveredNoteTabs({
      reloadedLibraryTabs: [reloaded],
      currentTabs: [localOnly],
      currentSession: { openTabIds: [localOnly.id], activeTabId: localOnly.id },
      createId: () => "recovered-local-only",
      recoveryTitle: (title) => `${title} (recovered)`
    });

    expect(result.tabs.map((tab) => tab.id)).toEqual(["cloud-note", "recovered-local-only"]);
    expect(result.tabs[1].plainText).toBe("not in cloud");
    expect(result.session).toEqual({
      openTabIds: ["recovered-local-only"],
      activeTabId: "recovered-local-only"
    });
    expect(result.recoveredCount).toBe(1);
  });

  it("preserves non-library tabs and retains valid session entries while opening recovery copies", () => {
    const reloaded = createTab({ plainText: "cloud", content: documentWithText("cloud") });
    const currentLibrary = createTab({ plainText: "fallback", content: documentWithText("fallback") });
    const transient = createTab({ id: "draft", persistence: "transient", savedSnapshot: null });
    const external = createTab({
      id: "external",
      persistence: "external",
      sourceFilePath: "C:\\notes\\external.txt",
      fileFormat: "txt"
    });

    const result = mergeRecoveredNoteTabs({
      reloadedLibraryTabs: [reloaded],
      currentTabs: [currentLibrary, transient, external],
      currentSession: {
        openTabIds: [reloaded.id, transient.id, "missing", external.id, transient.id],
        activeTabId: transient.id
      },
      createId: () => reloaded.id,
      recoveryTitle: (title) => `${title} (recovered)`
    });

    expect(result.tabs[1]).toBe(transient);
    expect(result.tabs[2]).toBe(external);
    expect(result.tabs[3].id).toBe("note-1-2");
    expect(result.session).toEqual({
      openTabIds: [reloaded.id, transient.id, external.id, "note-1-2"],
      activeTabId: transient.id
    });
    expect(result.recoveredCount).toBe(1);
  });

  it.each([
    ["title", { title: "Changed title" }],
    ["manual-title mode", { isTitleManual: false }],
    ["document", { content: documentWithText("different document") }],
    ["plain text", { plainText: "different plain text" }],
    ["pin", { isPinned: true }],
    ["folder", { folderPath: "moved" }],
    ["file format", { fileFormat: "txt" as const }]
  ])("detects changed user-visible %s metadata", (_label, overrides) => {
    const reloaded = createTab();
    const current = createTab(overrides);

    const result = mergeRecoveredNoteTabs({
      reloadedLibraryTabs: [reloaded],
      currentTabs: [current],
      currentSession: { openTabIds: [], activeTabId: null },
      createId: () => "recovery-1",
      recoveryTitle: (title) => title
    });

    expect(result.recoveredCount).toBe(1);
  });
});
