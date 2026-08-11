import type { NoteTab, PersistedTabSession } from "../stores/noteStore";

export interface MergeRecoveredNoteTabsInput {
  reloadedLibraryTabs: readonly NoteTab[];
  currentTabs: readonly NoteTab[];
  currentSession: PersistedTabSession;
  createId: (sourceTab: NoteTab) => string;
  recoveryTitle: (originalTitle: string) => string;
}

export interface MergeRecoveredNoteTabsResult {
  tabs: NoteTab[];
  session: PersistedTabSession;
  recoveredCount: number;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => deepEqual(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key])
  );
}

function hasSameUserVisibleState(current: NoteTab, reloaded: NoteTab): boolean {
  return (
    current.title === reloaded.title &&
    current.isTitleManual === reloaded.isTitleManual &&
    deepEqual(current.content, reloaded.content) &&
    current.plainText === reloaded.plainText &&
    current.isPinned === reloaded.isPinned &&
    current.folderPath === reloaded.folderPath &&
    current.fileFormat === reloaded.fileFormat
  );
}

function claimUniqueId(candidate: string, usedIds: Set<string>): string {
  const baseId = candidate || "recovered-note";
  let id = baseId;
  let suffix = 2;

  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(id);
  return id;
}

function dedupeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

export function mergeRecoveredNoteTabs({
  reloadedLibraryTabs,
  currentTabs,
  currentSession,
  createId,
  recoveryTitle
}: MergeRecoveredNoteTabsInput): MergeRecoveredNoteTabsResult {
  const reloadedById = new Map(reloadedLibraryTabs.map((tab) => [tab.id, tab]));
  const preservedNonLibraryTabs = currentTabs.filter((tab) => tab.persistence !== "library");
  const usedIds = new Set([...reloadedLibraryTabs, ...currentTabs].map((tab) => tab.id));
  const recoveryTabs: NoteTab[] = [];
  const recoveryIdBySourceId = new Map<string, string>();

  for (const currentTab of currentTabs) {
    if (currentTab.persistence !== "library") {
      continue;
    }

    const reloadedTab = reloadedById.get(currentTab.id);
    if (reloadedTab && hasSameUserVisibleState(currentTab, reloadedTab)) {
      continue;
    }

    const recoveryId = claimUniqueId(createId(currentTab), usedIds);
    const recoveryTab: NoteTab = {
      ...currentTab,
      id: recoveryId,
      revision: 0,
      title: recoveryTitle(currentTab.title),
      isTitleManual: true,
      isDirty: true,
      lastSavedAt: 0,
      sourceFilePath: undefined,
      persistence: "transient",
      savedSnapshot: null
    };

    recoveryTabs.push(recoveryTab);
    recoveryIdBySourceId.set(currentTab.id, recoveryId);
  }

  const tabs = [...reloadedLibraryTabs, ...preservedNonLibraryTabs, ...recoveryTabs];
  const availableIds = new Set(tabs.map((tab) => tab.id));
  const retainedOpenTabIds = dedupeIds(currentSession.openTabIds).filter((id) => availableIds.has(id));
  const openTabIds = dedupeIds([...retainedOpenTabIds, ...recoveryTabs.map((tab) => tab.id)]);
  const recoveredActiveTabId = currentSession.activeTabId
    ? (recoveryIdBySourceId.get(currentSession.activeTabId) ?? null)
    : null;
  const retainedActiveTabId =
    currentSession.activeTabId && openTabIds.includes(currentSession.activeTabId)
      ? currentSession.activeTabId
      : null;
  const activeTabId = recoveredActiveTabId ?? retainedActiveTabId ?? openTabIds[0] ?? null;

  return {
    tabs,
    session: { openTabIds, activeTabId },
    recoveredCount: recoveryTabs.length
  };
}
