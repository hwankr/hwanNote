import type { NoteTab, PersistedTabSession } from "../stores/noteStore";
import { mergeRecoveredNoteTabs } from "./noteRecovery";

export interface MergeReloadedNoteTabsInput {
  reloadedLibraryTabs: readonly NoteTab[];
  currentTabs: readonly NoteTab[];
  currentSession: PersistedTabSession;
  sameStorageSource: boolean;
  createRecoveryId: (sourceTab: NoteTab) => string;
  recoveryTitle: (originalTitle: string) => string;
}

export interface MergeReloadedNoteTabsResult {
  tabs: NoteTab[];
  session: PersistedTabSession;
  preservedDirtyTabIds: string[];
  recoveredCount: number;
}

function dedupeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

export function mergeReloadedNoteTabs({
  reloadedLibraryTabs,
  currentTabs,
  currentSession,
  sameStorageSource,
  createRecoveryId,
  recoveryTitle
}: MergeReloadedNoteTabsInput): MergeReloadedNoteTabsResult {
  const dirtyLibraryTabs = currentTabs.filter(
    (tab) => tab.persistence === "library" && tab.isDirty
  );
  const dirtyLibraryById = new Map(dirtyLibraryTabs.map((tab) => [tab.id, tab]));
  const preservedNonLibraryTabs = currentTabs.filter((tab) => tab.persistence !== "library");

  if (sameStorageSource) {
    const reloadedIds = new Set(reloadedLibraryTabs.map((tab) => tab.id));
    const mergedLibraryTabs = reloadedLibraryTabs.map(
      (tab) => dirtyLibraryById.get(tab.id) ?? tab
    );
    const missingDirtyTabs = dirtyLibraryTabs.filter((tab) => !reloadedIds.has(tab.id));
    const tabs = [...mergedLibraryTabs, ...missingDirtyTabs, ...preservedNonLibraryTabs];
    const availableIds = new Set(tabs.map((tab) => tab.id));
    const openTabIds = dedupeIds(currentSession.openTabIds).filter((id) => availableIds.has(id));
    const activeTabId =
      currentSession.activeTabId && openTabIds.includes(currentSession.activeTabId)
        ? currentSession.activeTabId
        : (openTabIds[0] ?? null);

    return {
      tabs,
      session: { openTabIds, activeTabId },
      preservedDirtyTabIds: dirtyLibraryTabs.map((tab) => tab.id),
      recoveredCount: 0
    };
  }

  const recovered = mergeRecoveredNoteTabs({
    reloadedLibraryTabs,
    currentTabs: [...dirtyLibraryTabs, ...preservedNonLibraryTabs],
    currentSession,
    createId: createRecoveryId,
    recoveryTitle
  });

  return {
    tabs: recovered.tabs,
    session: recovered.session,
    preservedDirtyTabIds: [],
    recoveredCount: recovered.recoveredCount
  };
}
