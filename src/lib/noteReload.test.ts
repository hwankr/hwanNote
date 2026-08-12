import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import type { NoteTab } from "../stores/noteStore";
import { mergeReloadedNoteTabs } from "./noteReload";

function documentWithText(text: string): JSONContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }]
  };
}

function createTab(overrides: Partial<NoteTab> = {}): NoteTab {
  const plainText = overrides.plainText ?? "disk";
  return {
    id: "note-1",
    revision: 0,
    title: "Note",
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

describe("mergeReloadedNoteTabs", () => {
  it("keeps dirty library state in place when the same storage source reloads", () => {
    const reloaded = createTab();
    const dirty = createTab({
      revision: 3,
      plainText: "unsaved",
      content: documentWithText("unsaved"),
      isDirty: true
    });
    const draft = createTab({ id: "draft", persistence: "transient", isDirty: true });

    const result = mergeReloadedNoteTabs({
      reloadedLibraryTabs: [reloaded],
      currentTabs: [dirty, draft],
      currentSession: { openTabIds: [dirty.id, draft.id], activeTabId: dirty.id },
      sameStorageSource: true,
      createRecoveryId: () => "unused",
      recoveryTitle: (title) => `${title} (recovered)`
    });

    expect(result.tabs).toEqual([dirty, draft]);
    expect(result.session).toEqual({ openTabIds: [dirty.id, draft.id], activeTabId: dirty.id });
    expect(result.preservedDirtyTabIds).toEqual([dirty.id]);
    expect(result.recoveredCount).toBe(0);
  });

  it("retains a dirty same-source note that disappeared from the disk snapshot", () => {
    const dirty = createTab({ id: "missing", isDirty: true });

    const result = mergeReloadedNoteTabs({
      reloadedLibraryTabs: [createTab({ id: "disk-only" })],
      currentTabs: [dirty],
      currentSession: { openTabIds: [dirty.id], activeTabId: dirty.id },
      sameStorageSource: true,
      createRecoveryId: () => "unused",
      recoveryTitle: (title) => title
    });

    expect(result.tabs.map((tab) => tab.id)).toEqual(["disk-only", "missing"]);
    expect(result.session).toEqual({ openTabIds: ["missing"], activeTabId: "missing" });
    expect(result.preservedDirtyTabIds).toEqual(["missing"]);
  });

  it("turns only dirty library tabs into unsaved copies when the storage source changes", () => {
    const reloaded = createTab({ plainText: "new source", content: documentWithText("new source") });
    const dirty = createTab({
      revision: 4,
      plainText: "concurrent edit",
      content: documentWithText("concurrent edit"),
      isDirty: true
    });
    const cleanOldSource = createTab({ id: "clean-old-source", plainText: "old source" });

    const result = mergeReloadedNoteTabs({
      reloadedLibraryTabs: [reloaded],
      currentTabs: [dirty, cleanOldSource],
      currentSession: { openTabIds: [dirty.id, cleanOldSource.id], activeTabId: dirty.id },
      sameStorageSource: false,
      createRecoveryId: () => reloaded.id,
      recoveryTitle: (title) => `${title} (recovered)`
    });

    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[0]).toBe(reloaded);
    expect(result.tabs[1]).toMatchObject({
      id: "note-1-2",
      title: "Note (recovered)",
      plainText: "concurrent edit",
      persistence: "transient",
      isDirty: true,
      savedSnapshot: null
    });
    expect(result.tabs.some((tab) => tab.id === cleanOldSource.id)).toBe(false);
    expect(result.session).toEqual({
      openTabIds: [reloaded.id, "note-1-2"],
      activeTabId: "note-1-2"
    });
    expect(result.preservedDirtyTabIds).toEqual([]);
    expect(result.recoveredCount).toBe(1);
  });
});
