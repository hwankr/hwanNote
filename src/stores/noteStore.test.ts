import type { JSONContent } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteTab, SavedNoteSnapshot } from "./noteStore";
import { useNoteStore } from "./noteStore";

vi.mock("../lib/tauriApi", () => ({
  hwanNote: {
    session: {
      save: vi.fn().mockResolvedValue(undefined)
    }
  }
}));

const TAB_ID = "note-race";

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

function snapshotOf(tab: NoteTab, lastSavedAt = tab.lastSavedAt): SavedNoteSnapshot {
  return {
    revision: tab.revision,
    title: tab.title,
    isTitleManual: tab.isTitleManual,
    content: tab.content,
    plainText: tab.plainText,
    folderPath: tab.folderPath,
    fileFormat: tab.fileFormat,
    sourceFilePath: tab.sourceFilePath,
    updatedAt: tab.updatedAt,
    lastSavedAt
  };
}

function createLibraryTab(id = TAB_ID, plainText = "saved"): NoteTab {
  const now = 1_000;
  const tab: NoteTab = {
    id,
    revision: 0,
    title: "Manual title",
    isTitleManual: true,
    content: documentWithText(plainText),
    plainText,
    isDirty: false,
    isPinned: false,
    folderPath: "",
    createdAt: now,
    updatedAt: now,
    lastSavedAt: now,
    fileFormat: "md",
    persistence: "library",
    savedSnapshot: null
  };

  tab.savedSnapshot = snapshotOf(tab);
  return tab;
}

function hydrate(tabs: NoteTab[]) {
  useNoteStore.getState().hydrateTabs(tabs, {
    openTabIds: tabs.map((tab) => tab.id),
    activeTabId: tabs[0]?.id ?? null
  });
}

beforeEach(() => {
  hydrate([createLibraryTab()]);
});

describe("note save revisions", () => {
  it("keeps a newer edit dirty when an older save completes", () => {
    const store = useNoteStore.getState();
    store.updateTabContent(TAB_ID, documentWithText("A"), "A");
    const savingA = useNoteStore.getState().notesById[TAB_ID];

    store.updateTabContent(TAB_ID, documentWithText("B"), "B");
    const savedCurrentRevision = store.markTabSaved(TAB_ID, {
      savedSnapshot: snapshotOf(savingA, 2_000),
      persistence: "library"
    });

    const current = useNoteStore.getState().notesById[TAB_ID];
    expect(savedCurrentRevision).toBe(false);
    expect(current.plainText).toBe("B");
    expect(current.content).toEqual(documentWithText("B"));
    expect(current.revision).toBe(2);
    expect(current.isDirty).toBe(true);
    expect(current.lastSavedAt).toBe(2_000);
    expect(current.savedSnapshot).toMatchObject({
      revision: 1,
      plainText: "A",
      lastSavedAt: 2_000
    });
  });

  it("marks clean only when the completed save matches the current revision", () => {
    const store = useNoteStore.getState();
    store.updateTabContent(TAB_ID, documentWithText("current"), "current");
    const savingCurrent = useNoteStore.getState().notesById[TAB_ID];

    const savedCurrentRevision = store.markTabSaved(TAB_ID, {
      savedSnapshot: snapshotOf(savingCurrent, 3_000),
      persistence: "library"
    });

    const current = useNoteStore.getState().notesById[TAB_ID];
    expect(savedCurrentRevision).toBe(true);
    expect(current.revision).toBe(1);
    expect(current.isDirty).toBe(false);
    expect(current.savedSnapshot).toMatchObject({
      revision: 1,
      plainText: "current",
      lastSavedAt: 3_000
    });
  });

  it("restores the persisted snapshot while keeping revisions monotonic on discard", () => {
    const store = useNoteStore.getState();
    store.updateTabContent(TAB_ID, documentWithText("A"), "A");
    const savingA = useNoteStore.getState().notesById[TAB_ID];
    store.updateTabContent(TAB_ID, documentWithText("B"), "B");
    store.markTabSaved(TAB_ID, {
      savedSnapshot: snapshotOf(savingA, 2_000),
      persistence: "library"
    });

    expect(store.discardTabChanges(TAB_ID)).toBe("reverted");

    const current = useNoteStore.getState().notesById[TAB_ID];
    expect(current.plainText).toBe("A");
    expect(current.revision).toBe(3);
    expect(current.isDirty).toBe(false);
    expect(current.savedSnapshot?.revision).toBe(1);
  });

  it("increments only the changed tab for every dirty-producing mutation", () => {
    const otherId = "note-other";
    hydrate([createLibraryTab(TAB_ID), createLibraryTab(otherId, "other")]);
    const store = useNoteStore.getState();

    store.moveTabToFolder(TAB_ID, "first");
    store.renameFolderPath("first", "second");
    store.clearFolderPath("second");
    store.setTabTitle(TAB_ID, "Renamed");
    store.updateTabContent(TAB_ID, documentWithText("changed"), "changed");
    store.toggleFileFormat(TAB_ID);

    const state = useNoteStore.getState();
    expect(state.notesById[TAB_ID].revision).toBe(6);
    expect(state.notesById[TAB_ID].isDirty).toBe(true);
    expect(state.notesById[otherId].revision).toBe(0);
    expect(state.notesById[otherId].isDirty).toBe(false);
  });

  it("normalizes missing runtime revisions during hydration", () => {
    const legacy = createLibraryTab();
    delete (legacy as Partial<NoteTab>).revision;
    delete (legacy.savedSnapshot as Partial<SavedNoteSnapshot>).revision;

    hydrate([legacy]);

    const current = useNoteStore.getState().notesById[TAB_ID];
    expect(current.revision).toBe(0);
    expect(current.savedSnapshot?.revision).toBe(0);
  });
});
