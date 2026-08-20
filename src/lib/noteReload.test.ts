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
      authoritativeSnapshot: true,
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
      authoritativeSnapshot: true,
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
      authoritativeSnapshot: true,
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

  it("preserves every missing library tab when the disk snapshot is not authoritative", () => {
    const visible = createTab({ id: "visible" });
    const missedByScan = createTab({
      id: "stable-note-id",
      title: "Pinned historical note",
      isPinned: true,
      createdAt: 123_456,
      updatedAt: 789_012,
      plainText: "must survive an incomplete scan",
      content: documentWithText("must survive an incomplete scan")
    });

    const result = mergeReloadedNoteTabs({
      reloadedLibraryTabs: [visible],
      currentTabs: [visible, missedByScan],
      currentSession: {
        openTabIds: [missedByScan.id],
        activeTabId: missedByScan.id
      },
      sameStorageSource: true,
      authoritativeSnapshot: false,
      createRecoveryId: () => "unused",
      recoveryTitle: (title) => title
    });

    expect(result.tabs).toEqual([visible, missedByScan]);
    expect(result.tabs[1]).toBe(missedByScan);
    expect(result.tabs[1]).toMatchObject({
      id: "stable-note-id",
      isPinned: true,
      createdAt: 123_456,
      updatedAt: 789_012
    });
    expect(result.session).toEqual({
      openTabIds: [missedByScan.id],
      activeTabId: missedByScan.id
    });
    expect(result.recoveredCount).toBe(0);
  });

  it("drops a missing clean library tab only when the snapshot is authoritative", () => {
    const visible = createTab({ id: "visible" });
    const deletedOnDisk = createTab({ id: "deleted-on-disk" });

    const result = mergeReloadedNoteTabs({
      reloadedLibraryTabs: [visible],
      currentTabs: [visible, deletedOnDisk],
      currentSession: {
        openTabIds: [deletedOnDisk.id],
        activeTabId: deletedOnDisk.id
      },
      sameStorageSource: true,
      authoritativeSnapshot: true,
      createRecoveryId: () => "unused",
      recoveryTitle: (title) => title
    });

    expect(result.tabs).toEqual([visible]);
    expect(result.session).toEqual({ openTabIds: [], activeTabId: null });
  });

  it("preserves an absent library tab across a source change when the snapshot is incomplete", () => {
    const newSourceNote = createTab({ id: "new-source-note" });
    const missedOldNote = createTab({
      id: "missed-old-note",
      isPinned: true,
      createdAt: 42
    });

    const result = mergeReloadedNoteTabs({
      reloadedLibraryTabs: [newSourceNote],
      currentTabs: [missedOldNote],
      currentSession: {
        openTabIds: [missedOldNote.id],
        activeTabId: missedOldNote.id
      },
      sameStorageSource: false,
      authoritativeSnapshot: false,
      createRecoveryId: () => "unused",
      recoveryTitle: (title) => title
    });

    expect(result.tabs).toEqual([newSourceNote, missedOldNote]);
    expect(result.tabs[1]).toBe(missedOldNote);
    expect(result.session).toEqual({
      openTabIds: [missedOldNote.id],
      activeTabId: missedOldNote.id
    });
    expect(result.recoveredCount).toBe(0);
  });
});
