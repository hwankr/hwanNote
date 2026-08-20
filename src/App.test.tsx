// @vitest-environment jsdom

import type { JSONContent } from "@tiptap/core";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  autoSave: vi.fn(),
  browseAutoSaveDir: vi.fn(),
  calendarLoadState: "ready" as "idle" | "loading" | "ready" | "corrupt" | "load_error",
  cleanOrphanNoteLinks: vi.fn(),
  closeRequestHandlers: [] as Array<(event: { preventDefault: () => void }) => void | Promise<void>>,
  detectCloudProviders: vi.fn(),
  dialogMessage: vi.fn(),
  getAutoSaveDir: vi.fn(),
  loadAll: vi.fn(),
  loadCalendarData: vi.fn(),
  loadSession: vi.fn(),
  onFolderMissing: vi.fn(),
  openIntentHandler: null as ((filePath: string) => void) | null,
  onOpenIntent: vi.fn(),
  readExternalTxt: vi.fn(),
  recoverCalendarDataFromCloud: vi.fn(),
  saveCalendarData: vi.fn(),
  saveSession: vi.fn(),
  setAutoSaveDir: vi.fn(),
  setActiveSource: vi.fn(),
  cloudStatus: vi.fn(),
  updaterInstall: vi.fn(),
  windowExit: vi.fn(),
}));

vi.mock("./lib/tauriApi", () => ({
  hwanNote: {
    window: {
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(false),
      close: vi.fn().mockResolvedValue(undefined),
      exit: mocks.windowExit,
    },
    note: {
      autoSave: mocks.autoSave,
      loadAll: mocks.loadAll,
      importTxt: vi.fn().mockResolvedValue(null),
      readExternalTxt: mocks.readExternalTxt,
      drainOpenIntents: vi.fn().mockResolvedValue([]),
      onOpenIntent: mocks.onOpenIntent,
      pickSavePath: vi.fn().mockResolvedValue(null),
      saveTxt: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(true),
    },
    folder: {
      create: vi.fn().mockResolvedValue([]),
      rename: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue({ folders: [], movedNoteIds: [] }),
    },
    updater: {
      install: mocks.updaterInstall,
    },
    settings: {
      browseAutoSaveDir: mocks.browseAutoSaveDir,
      setAutoSaveDir: mocks.setAutoSaveDir,
      getAutoSaveDir: mocks.getAutoSaveDir,
    },
    session: {
      load: mocks.loadSession,
      save: mocks.saveSession,
    },
    cloud: {
      status: mocks.cloudStatus,
      detectProviders: mocks.detectCloudProviders,
      enable: vi.fn(),
      disable: vi.fn(),
      setActiveSource: mocks.setActiveSource,
      onFolderMissing: mocks.onFolderMissing,
    },
  },
}));

vi.mock("./stores/calendarStore", () => ({
  useCalendarStore: {
    getState: () => ({
      backupPath: null,
      cleanOrphanNoteLinks: mocks.cleanOrphanNoteLinks,
      loadCalendarData: mocks.loadCalendarData,
      loadError: null,
      loadState: mocks.calendarLoadState,
      removeNoteLinks: vi.fn(),
      recoverCalendarDataFromCloud: mocks.recoverCalendarDataFromCloud,
      saveCalendarData: mocks.saveCalendarData,
      sourcePath: "",
    }),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn((handler) => {
      mocks.closeRequestHandlers.push(handler);
      return Promise.resolve(() => undefined);
    }),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  message: mocks.dialogMessage,
}));

vi.mock("./components/Editor", async () => {
  const { createElement } = await import("react");

  return {
    default: ({ onChange }: { onChange: (content: JSONContent, plainText: string) => void }) => {
      const edit = (plainText: string) =>
        onChange(
          {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: plainText }],
              },
            ],
          },
          plainText,
        );

      return createElement(
        "div",
        null,
        createElement(
          "button",
          { "data-testid": "edit-note", onClick: () => edit("dirty draft") },
          "edit note",
        ),
        createElement(
          "button",
          { "data-testid": "edit-concurrently", onClick: () => edit("concurrent edit") },
          "edit concurrently",
        ),
      );
    },
    restoreEditorFocus: vi.fn(),
  };
});

vi.mock("./components/SettingsPanel", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      onCloudSyncSourceChange,
    }: {
      onCloudSyncSourceChange: (source: "local" | "cloud") => Promise<void>;
    }) =>
      createElement(
        "button",
        {
          "data-testid": "switch-cloud-source",
          onClick: () => void onCloudSyncSourceChange("cloud"),
        },
        "switch cloud source",
      ),
  };
});

vi.mock("./components/Sidebar", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ folders }: { folders: string[] }) =>
      createElement("div", {
        "data-testid": "sidebar",
        "data-folders": JSON.stringify(folders),
      }),
  };
});

vi.mock("./components/StatusBar", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("div") };
});

vi.mock("./components/TitleBar", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("div") };
});

vi.mock("./components/Toolbar", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("div") };
});

vi.mock("./components/UpdateToast", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ onInstall }: { onInstall: () => Promise<void> }) =>
      createElement(
        "button",
        {
          "data-testid": "install-update",
          onClick: () => void onInstall(),
        },
        "install update",
      ),
  };
});

vi.mock("./components/calendar/CalendarPage", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("div") };
});

import App from "./App";
import { I18nProvider, useI18n } from "./i18n/context";
import { useNoteStore } from "./stores/noteStore";

const NOTE_ID = "library-note";
const AUTO_SAVE_DELAY_MS = 1_750;

function createLoadResult(
  loadedFrom: "local" | "cloud" | "local_fallback",
  markdown = "disk copy",
  noteOverrides: Partial<{
    noteId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    isPinned: boolean;
  }> = {},
  folders: string[] = [],
) {
  return {
    notes: [
      {
        noteId: noteOverrides.noteId ?? NOTE_ID,
        title: noteOverrides.title ?? (loadedFrom === "cloud" ? "Cloud title" : "Disk title"),
        isTitleManual: true,
        plainText: markdown,
        markdown,
        folderPath: "",
        createdAt: noteOverrides.createdAt ?? 1_000,
        updatedAt: noteOverrides.updatedAt ?? (loadedFrom === "cloud" ? 3_000 : 1_000),
        filePath: `C:/notes/${noteOverrides.noteId ?? NOTE_ID}.md`,
        isPinned: noteOverrides.isPinned ?? false,
      },
    ],
    folders,
    loadedFrom,
    cloudUnavailable: false,
    loadState: "ready" as const,
    issues: [],
    indexSourcePath: "C:/notes/.hwan-note-index.json",
    indexBackupPath: null,
  };
}

function createRecoveryLoadResult({
  loadState,
  loadedFrom = "local",
  operation,
  path,
  reason,
  kind = loadState === "index_corrupt" ? "index" : "scan",
  indexBackupPath = null,
}: {
  loadState: "incomplete" | "index_corrupt";
  loadedFrom?: "local" | "cloud" | "local_fallback";
  operation: string;
  path: string;
  reason: string;
  kind?: "scan" | "file_read" | "file_metadata" | "index";
  indexBackupPath?: string | null;
}) {
  return {
    ...createLoadResult(loadedFrom, "partial scan"),
    notes: [],
    folders: ["partial-folder"],
    loadState,
    issues: [{ kind, operation, path, reason }],
    indexSourcePath: "C:/notes/.hwan-note-index.json",
    indexBackupPath,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function LanguageSwitcher() {
  const { language, setLanguage } = useI18n();

  return (
    <button data-testid="switch-language" data-language={language} onClick={() => setLanguage("en")}>
      switch language
    </button>
  );
}

async function flushReactWork(rounds = 8) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function flushUntil(predicate: () => boolean, description: string) {
  for (let round = 0; round < 20; round += 1) {
    if (predicate()) {
      return;
    }
    await flushReactWork(1);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function requiredElement<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Expected element matching ${selector}`);
  }
  return element;
}

async function renderApp(root: Root) {
  await act(async () => {
    root.render(
      <StrictMode>
        <I18nProvider>
          <LanguageSwitcher />
          <App />
        </I18nProvider>
      </StrictMode>,
    );
  });
  await flushReactWork();
}

describe("App locale changes", () => {
  let container: HTMLDivElement;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null;
  let root: Root;

  beforeEach(() => {
    consoleErrorSpy = null;
    vi.useFakeTimers();
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    useNoteStore.setState({
      notesById: {},
      noteIds: [],
      openTabIds: [],
      activeTabId: null,
      allNotes: [],
      openTabs: [],
      activeOpenTab: null,
      sidebarVisible: false,
    });

    mocks.autoSave.mockReset().mockResolvedValue({
      filePath: "C:/notes/library-note.md",
      noteId: NOTE_ID,
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    mocks.loadAll.mockReset().mockResolvedValue(createLoadResult("local"));
    mocks.loadSession.mockReset().mockResolvedValue({
      openTabIds: [NOTE_ID],
      activeTabId: NOTE_ID,
    });
    mocks.dialogMessage.mockReset().mockResolvedValue("Yes");
    mocks.saveCalendarData.mockReset().mockResolvedValue("saved");
    mocks.saveSession.mockReset().mockResolvedValue(undefined);
    mocks.setActiveSource.mockReset().mockResolvedValue(undefined);
    mocks.getAutoSaveDir.mockReset().mockResolvedValue({
      customDir: null,
      effectiveDir: "C:/notes",
      isDefault: true,
      status: "unset",
      expectedDir: "C:/notes",
      error: null,
    });
    mocks.browseAutoSaveDir.mockReset().mockResolvedValue(null);
    mocks.setAutoSaveDir.mockReset().mockResolvedValue({
      customDir: null,
      effectiveDir: "C:/notes",
      isDefault: true,
      status: "unset",
      expectedDir: "C:/notes",
      error: null,
    });
    mocks.calendarLoadState = "ready";
    mocks.cloudStatus.mockReset().mockResolvedValue({
      enabled: false,
      provider: null,
      syncFolder: null,
      activeSource: "local",
      resolvedSource: "local",
      cloudUnavailable: false,
    });
    mocks.detectCloudProviders.mockReset().mockResolvedValue([]);
    mocks.onFolderMissing.mockReset().mockReturnValue(() => undefined);
    mocks.openIntentHandler = null;
    mocks.onOpenIntent.mockReset().mockImplementation((handler: (filePath: string) => void) => {
      mocks.openIntentHandler = handler;
      return () => undefined;
    });
    mocks.readExternalTxt.mockReset().mockResolvedValue({
      title: "External note",
      content: "external content",
      filePath: "C:/external.txt",
    });
    mocks.loadCalendarData.mockReset().mockResolvedValue(undefined);
    mocks.recoverCalendarDataFromCloud.mockReset().mockResolvedValue({
      status: "recovered",
      loadedFrom: "cloud",
      recoveryCopyPath: null,
    });
    mocks.cleanOrphanNoteLinks.mockReset();
    mocks.closeRequestHandlers.length = 0;
    mocks.updaterInstall.mockReset().mockResolvedValue(undefined);
    mocks.windowExit.mockReset().mockResolvedValue(undefined);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    consoleErrorSpy?.mockRestore();
  });

  it("shows the unavailable custom path in Korean and English without claiming a default fallback", async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getAutoSaveDir.mockResolvedValue({
      customDir: "Z:/Detached/HwanNote",
      effectiveDir: null,
      isDefault: false,
      status: "unavailable",
      expectedDir: "Z:/Detached/HwanNote",
      error: "custom_auto_save_dir_unavailable",
    });
    mocks.loadAll.mockRejectedValue(new Error("custom path unavailable"));

    await renderApp(root);

    const banner = requiredElement<HTMLElement>(container, ".storage-unavailable-banner");
    expect(banner.textContent).toContain("사용자 지정 저장 경로에 연결할 수 없습니다");
    expect(banner.textContent).toContain("Z:/Detached/HwanNote");
    expect(banner.textContent).toContain("기본 Documents 폴더는 자동으로 사용하지 않습니다");
    expect(banner.textContent).not.toContain("기본 경로를 사용합니다");
    expect(mocks.loadAll).toHaveBeenCalledTimes(1);

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="switch-language"]').click();
    });
    await flushReactWork();

    expect(banner.textContent).toContain("The custom storage path is unavailable");
    expect(banner.textContent).toContain("will not use the default Documents folder automatically");
  });

  it("keeps an initial corrupt-index result non-authoritative until a ready retry", async () => {
    mocks.loadAll
      .mockReset()
      .mockResolvedValueOnce(createRecoveryLoadResult({
        loadState: "index_corrupt",
        operation: "parse_index",
        path: "C:/notes/.hwan-note-index.json",
        reason: "expected value at line 1 column 2",
        indexBackupPath: "C:/notes/.hwan-note-index.corrupt-1234.json",
      }))
      .mockResolvedValueOnce(createRecoveryLoadResult({
        loadState: "incomplete",
        kind: "file_read",
        operation: "read_markdown",
        path: "C:/notes/private/blocked.md",
        reason: "access denied",
      }))
      .mockResolvedValueOnce(createLoadResult("local", "recovered library"));

    await renderApp(root);

    const panel = requiredElement<HTMLElement>(container, ".note-recovery-panel");
    expect(panel.textContent).toContain("노트 인덱스를 복구해야 합니다");
    expect(panel.textContent).toContain("C:/notes/.hwan-note-index.json");
    expect(panel.textContent).toContain("C:/notes/.hwan-note-index.corrupt-1234.json");
    expect(panel.textContent).toContain("expected value at line 1 column 2");
    expect(useNoteStore.getState().noteIds).toEqual([]);
    expect(mocks.cleanOrphanNoteLinks).not.toHaveBeenCalled();

    await act(async () => {
      requiredElement<HTMLButtonElement>(panel, "button").click();
    });
    await flushUntil(() => mocks.loadAll.mock.calls.length === 2, "the still-incomplete rescan");
    await flushReactWork();

    const stillBlockedPanel = requiredElement<HTMLElement>(container, ".note-recovery-panel");
    expect(stillBlockedPanel.textContent).toContain("C:/notes/private/blocked.md");
    expect(stillBlockedPanel.textContent).toContain("access denied");
    expect(useNoteStore.getState().noteIds).toEqual([]);
    expect(mocks.cleanOrphanNoteLinks).not.toHaveBeenCalled();

    await act(async () => {
      requiredElement<HTMLButtonElement>(stillBlockedPanel, "button").click();
    });
    await flushUntil(() => mocks.loadAll.mock.calls.length === 3, "the authoritative rescan");
    await flushReactWork();

    expect(container.querySelector(".note-recovery-panel")).toBeNull();
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      id: NOTE_ID,
      plainText: "recovered library",
    });
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(1);
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledWith(true);

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-note"]').click();
      await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    });
    await flushUntil(() => mocks.autoSave.mock.calls.length === 1, "autosave after recovery");
    expect(mocks.autoSave).toHaveBeenCalledWith(
      NOTE_ID,
      "Disk title",
      expect.stringContaining("dirty draft"),
      "",
      true,
      false,
      "local",
    );
  });

  it("preserves note identity, metadata, folders, and calendar links on an incomplete storage reload", async () => {
    mocks.loadAll
      .mockReset()
      .mockResolvedValueOnce(createLoadResult(
        "local",
        "original library",
        { createdAt: 321, isPinned: true },
        ["kept-folder"],
      ))
      .mockResolvedValueOnce(createRecoveryLoadResult({
        loadState: "incomplete",
        loadedFrom: "cloud",
        kind: "file_metadata",
        operation: "read_metadata",
        path: "G:/HwanNote/nested/note.md",
        reason: "device not ready",
      }));

    await renderApp(root);
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(1);

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="switch-cloud-source"]').click();
    });
    await flushUntil(() => mocks.loadAll.mock.calls.length === 2, "the incomplete storage reload");
    await flushReactWork();

    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      id: NOTE_ID,
      plainText: "original library",
      createdAt: 321,
      isPinned: true,
    });
    const renderedFolders = JSON.parse(
      requiredElement<HTMLElement>(container, '[data-testid="sidebar"]').dataset.folders ?? "[]",
    ) as string[];
    expect(renderedFolders).toContain("kept-folder");
    expect(renderedFolders).not.toContain("partial-folder");
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(1);
    expect(requiredElement<HTMLElement>(container, ".note-recovery-panel").textContent)
      .toContain("G:/HwanNote/nested/note.md");
  });

  it("aborts an incomplete cloud recovery before calendar recovery and cleans only after a ready retry", async () => {
    mocks.loadAll.mockReset().mockResolvedValueOnce(
      createLoadResult("local_fallback", "local fallback", { createdAt: 555, isPinned: true }),
    );
    mocks.cloudStatus.mockReset().mockResolvedValue({
      enabled: true,
      provider: "google-drive",
      syncFolder: "G:/HwanNote",
      activeSource: "cloud",
      resolvedSource: "local_fallback",
      cloudUnavailable: true,
    });

    await renderApp(root);
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(1);

    mocks.loadAll.mockResolvedValue(createRecoveryLoadResult({
      loadState: "incomplete",
      loadedFrom: "cloud",
      operation: "read_dir",
      path: "G:/HwanNote/notes/nested",
      reason: "the cloud folder is offline",
    }));
    mocks.cloudStatus.mockResolvedValue({
      enabled: true,
      provider: "google-drive",
      syncFolder: "G:/HwanNote",
      activeSource: "cloud",
      resolvedSource: "cloud",
      cloudUnavailable: false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flushUntil(() => mocks.loadAll.mock.calls.length >= 2, "the incomplete cloud rescan");
    await flushReactWork();

    expect(mocks.recoverCalendarDataFromCloud).not.toHaveBeenCalled();
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(1);
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "local fallback",
      createdAt: 555,
      isPinned: true,
    });
    expect(requiredElement<HTMLElement>(container, ".note-recovery-panel").textContent)
      .toContain("G:/HwanNote/notes/nested");

    mocks.loadAll.mockResolvedValue(createLoadResult("cloud", "authoritative cloud"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flushUntil(
      () => mocks.recoverCalendarDataFromCloud.mock.calls.length === 1,
      "calendar recovery after an authoritative cloud scan",
    );
    await flushReactWork();

    expect(container.querySelector(".note-recovery-panel")).toBeNull();
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "authoritative cloud",
    });
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(2);
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenNthCalledWith(2, true);
  });

  it("uses an incomplete initial fallback source to arm a later authoritative cloud recovery", async () => {
    mocks.loadAll.mockReset().mockResolvedValueOnce(createRecoveryLoadResult({
      loadState: "incomplete",
      loadedFrom: "local_fallback",
      operation: "read_dir",
      path: "C:/Users/test/Documents/HwanNote/notes",
      reason: "fallback scan interrupted",
    }));
    mocks.cloudStatus.mockReset().mockResolvedValue({
      enabled: true,
      provider: "google-drive",
      syncFolder: "G:/HwanNote",
      activeSource: "cloud",
      resolvedSource: "local_fallback",
      cloudUnavailable: true,
    });

    await renderApp(root);

    expect(mocks.loadAll).toHaveBeenCalledTimes(1);
    expect(mocks.recoverCalendarDataFromCloud).not.toHaveBeenCalled();
    expect(mocks.cleanOrphanNoteLinks).not.toHaveBeenCalled();
    expect(requiredElement<HTMLElement>(container, ".note-recovery-panel").textContent)
      .toContain("fallback scan interrupted");

    mocks.loadAll.mockResolvedValue(createLoadResult("cloud", "cloud after fallback scan"));
    mocks.cloudStatus.mockResolvedValue({
      enabled: true,
      provider: "google-drive",
      syncFolder: "G:/HwanNote",
      activeSource: "cloud",
      resolvedSource: "cloud",
      cloudUnavailable: false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flushUntil(
      () => mocks.recoverCalendarDataFromCloud.mock.calls.length === 1,
      "cloud recovery armed by the reported fallback source",
    );
    await flushReactWork();

    expect(mocks.loadAll.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".note-recovery-panel")).toBeNull();
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "cloud after fallback scan",
    });
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(1);
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledWith(true);

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-note"]').click();
      await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    });
    await flushUntil(() => mocks.autoSave.mock.calls.length === 1, "cloud autosave after recovery");
    expect(mocks.autoSave).toHaveBeenCalledWith(
      NOTE_ID,
      "Cloud title",
      expect.stringContaining("dirty draft"),
      "",
      true,
      false,
      "cloud",
    );
  });

  it("allows an explicit reset after an unavailable path blocked initial loading", async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.calendarLoadState = "idle";
    mocks.getAutoSaveDir.mockResolvedValue({
      customDir: "Z:/Detached/HwanNote",
      effectiveDir: null,
      isDefault: false,
      status: "unavailable",
      expectedDir: "Z:/Detached/HwanNote",
      error: "custom_auto_save_dir_unavailable",
    });
    mocks.loadAll.mockRejectedValue(new Error("custom path unavailable"));

    await renderApp(root);
    mocks.loadAll.mockResolvedValue(createLoadResult("local", "default library"));

    const resetButton = Array.from(
      requiredElement<HTMLElement>(container, ".storage-unavailable-actions").querySelectorAll("button")
    ).find((button) => button.textContent === "기본값으로 복원");
    if (!resetButton) {
      throw new Error("Expected the explicit reset action");
    }

    await act(async () => {
      resetButton.click();
    });
    await flushUntil(() => mocks.setAutoSaveDir.mock.calls.length === 1, "the path reset");
    await flushUntil(() => mocks.loadAll.mock.calls.length === 2, "the default library reload");

    expect(mocks.setAutoSaveDir).toHaveBeenCalledWith(null);
    expect(mocks.saveCalendarData).not.toHaveBeenCalled();
    expect(container.querySelector(".storage-unavailable-banner")).toBeNull();

    await act(async () => {
      mocks.openIntentHandler?.("C:/external.txt");
    });
    await flushUntil(
      () => mocks.readExternalTxt.mock.calls.length === 1,
      "external open handling after recovered hydration",
    );
    expect(mocks.readExternalTxt).toHaveBeenCalledWith("C:/external.txt");
  });

  it("restores the existing custom setting when the path reappears", async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.calendarLoadState = "idle";
    mocks.getAutoSaveDir.mockResolvedValue({
      customDir: "Z:/Detached/HwanNote",
      effectiveDir: null,
      isDefault: false,
      status: "unavailable",
      expectedDir: "Z:/Detached/HwanNote",
      error: "custom_auto_save_dir_unavailable",
    });
    mocks.loadAll.mockRejectedValue(new Error("custom path unavailable"));

    await renderApp(root);
    mocks.getAutoSaveDir.mockResolvedValue({
      customDir: "Z:/Detached/HwanNote",
      effectiveDir: "Z:/Detached/HwanNote",
      isDefault: false,
      status: "available",
      expectedDir: "Z:/Detached/HwanNote",
      error: null,
    });
    mocks.loadAll.mockResolvedValue(createLoadResult("local", "restored custom library"));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flushUntil(
      () => container.textContent?.includes("사용자 지정 저장 경로가 다시 연결되었습니다") === true,
      "the recovered-path status",
    );
    expect(mocks.loadAll).toHaveBeenCalledTimes(1);
    expect(mocks.setAutoSaveDir).not.toHaveBeenCalled();

    const reloadButton = Array.from(
      requiredElement<HTMLElement>(container, ".storage-unavailable-actions").querySelectorAll("button")
    ).find((button) => button.textContent === "라이브러리 다시 불러오기");
    if (!reloadButton) {
      throw new Error("Expected the recovered-library reload action");
    }

    await act(async () => {
      reloadButton.click();
    });
    await flushUntil(() => mocks.loadAll.mock.calls.length === 2, "the restored custom library reload");

    expect(mocks.setAutoSaveDir).not.toHaveBeenCalled();
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "restored custom library",
    });
    expect(container.querySelector(".storage-unavailable-banner")).toBeNull();
  });

  it("changes storage only after the user explicitly selects a new directory", async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.calendarLoadState = "idle";
    mocks.getAutoSaveDir.mockResolvedValue({
      customDir: "Z:/Detached/HwanNote",
      effectiveDir: null,
      isDefault: false,
      status: "unavailable",
      expectedDir: "Z:/Detached/HwanNote",
      error: "custom_auto_save_dir_unavailable",
    });
    mocks.loadAll.mockRejectedValue(new Error("custom path unavailable"));
    mocks.browseAutoSaveDir.mockResolvedValue("E:/NewLibrary");
    mocks.setAutoSaveDir.mockResolvedValue({
      customDir: "E:/NewLibrary",
      effectiveDir: "E:/NewLibrary",
      isDefault: false,
      status: "available",
      expectedDir: "E:/NewLibrary",
      error: null,
    });

    await renderApp(root);
    expect(mocks.setAutoSaveDir).not.toHaveBeenCalled();
    mocks.loadAll.mockResolvedValue(createLoadResult("local", "new custom library"));

    const browseButton = Array.from(
      requiredElement<HTMLElement>(container, ".storage-unavailable-actions").querySelectorAll("button")
    ).find((button) => button.textContent === "변경");
    if (!browseButton) {
      throw new Error("Expected the new-directory action");
    }

    await act(async () => {
      browseButton.click();
    });
    await flushUntil(() => mocks.setAutoSaveDir.mock.calls.length === 1, "the explicit directory change");
    await flushUntil(() => mocks.loadAll.mock.calls.length === 2, "the selected library reload");

    expect(mocks.browseAutoSaveDir).toHaveBeenCalledTimes(1);
    expect(mocks.setAutoSaveDir).toHaveBeenCalledWith("E:/NewLibrary");
    expect(container.querySelector(".storage-unavailable-banner")).toBeNull();
  });

  it("detects a missing custom local path without suspending an available cloud library", async () => {
    mocks.loadAll.mockResolvedValue(createLoadResult("cloud", "cloud library"));
    mocks.getAutoSaveDir.mockResolvedValue({
      customDir: "Z:/ExternalLocal",
      effectiveDir: "Z:/ExternalLocal",
      isDefault: false,
      status: "available",
      expectedDir: "Z:/ExternalLocal",
      error: null,
    });
    mocks.cloudStatus.mockResolvedValue({
      enabled: true,
      provider: "google_drive",
      syncFolder: "G:/Cloud",
      activeSource: "cloud",
      resolvedSource: "cloud",
      cloudUnavailable: false,
    });

    await renderApp(root);
    mocks.getAutoSaveDir.mockResolvedValue({
      customDir: "Z:/ExternalLocal",
      effectiveDir: null,
      isDefault: false,
      status: "unavailable",
      expectedDir: "Z:/ExternalLocal",
      error: "custom_auto_save_dir_unavailable",
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flushUntil(
      () => container.querySelector(".storage-unavailable-banner") !== null,
      "the missing custom path warning",
    );

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-note"]').click();
      await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    });
    await flushUntil(() => mocks.autoSave.mock.calls.length === 1, "the cloud note autosave");

    expect(mocks.autoSave).toHaveBeenCalledWith(
      NOTE_ID,
      "Cloud title",
      expect.stringContaining("dirty draft"),
      "",
      true,
      false,
      "cloud",
    );
    expect(mocks.recoverCalendarDataFromCloud).not.toHaveBeenCalled();
  });

  it("can switch to an available cloud library when the custom local path blocked startup", async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.calendarLoadState = "idle";
    mocks.getAutoSaveDir.mockResolvedValue({
      customDir: "Z:/ExternalLocal",
      effectiveDir: null,
      isDefault: false,
      status: "unavailable",
      expectedDir: "Z:/ExternalLocal",
      error: "custom_auto_save_dir_unavailable",
    });
    mocks.cloudStatus.mockResolvedValue({
      enabled: true,
      provider: "google_drive",
      syncFolder: "G:/Cloud",
      activeSource: "local",
      resolvedSource: null,
      cloudUnavailable: false,
    });
    mocks.loadAll.mockRejectedValue(new Error("custom path unavailable"));

    await renderApp(root);
    mocks.loadAll.mockResolvedValue(createLoadResult("cloud", "available cloud library"));

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="switch-cloud-source"]').click();
    });
    await flushUntil(() => mocks.setActiveSource.mock.calls.length === 1, "the cloud source switch");
    await flushUntil(() => mocks.loadAll.mock.calls.length === 2, "the cloud library load");

    expect(mocks.setActiveSource).toHaveBeenCalledWith("cloud");
    expect(mocks.saveCalendarData).not.toHaveBeenCalled();
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "available cloud library",
    });
  });

  it("hydrates once and preserves a pending dirty note across a language change", async () => {
    await renderApp(root);

    expect(mocks.loadAll).toHaveBeenCalledTimes(1);
    expect(useNoteStore.getState()).toMatchObject({
      openTabIds: [NOTE_ID],
      activeTabId: NOTE_ID,
    });

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-note"]').click();
    });

    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "dirty draft",
      isDirty: true,
    });

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="switch-language"]').click();
    });
    await flushReactWork();

    const stateAfterLanguageChange = useNoteStore.getState();
    expect(requiredElement<HTMLButtonElement>(container, '[data-testid="switch-language"]').dataset.language).toBe("en");
    expect(mocks.loadAll).toHaveBeenCalledTimes(1);
    expect(stateAfterLanguageChange.openTabIds).toEqual([NOTE_ID]);
    expect(stateAfterLanguageChange.activeTabId).toBe(NOTE_ID);
    expect(stateAfterLanguageChange.notesById[NOTE_ID]).toMatchObject({
      plainText: "dirty draft",
      isDirty: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    });
    await flushReactWork();

    expect(mocks.autoSave).toHaveBeenCalledTimes(1);
    expect(mocks.autoSave).toHaveBeenCalledWith(
      NOTE_ID,
      "Disk title",
      expect.stringContaining("dirty draft"),
      "",
      true,
      false,
      "local",
    );
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "dirty draft",
      isDirty: false,
    });
  });

  it("recovers an edit made while a source-transition reload is in flight", async () => {
    const cloudReload = createDeferred<ReturnType<typeof createLoadResult>>();
    await renderApp(root);
    mocks.loadAll.mockReturnValueOnce(cloudReload.promise);

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-note"]').click();
      requiredElement<HTMLButtonElement>(container, '[data-testid="switch-cloud-source"]').click();
    });
    await flushUntil(() => mocks.loadAll.mock.calls.length === 2, "the cloud library reload to start");

    expect(mocks.autoSave).toHaveBeenCalledTimes(1);
    expect(mocks.autoSave).toHaveBeenNthCalledWith(
      1,
      NOTE_ID,
      "Disk title",
      expect.stringContaining("dirty draft"),
      "",
      true,
      false,
      "local",
    );
    expect(mocks.setActiveSource).toHaveBeenCalledWith("cloud");

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-concurrently"]').click();
    });
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "concurrent edit",
      isDirty: true,
      persistence: "library",
    });

    await act(async () => {
      cloudReload.resolve(createLoadResult("cloud", "cloud copy"));
      await cloudReload.promise;
    });
    await flushReactWork();

    const reloadedState = useNoteStore.getState();
    const recoveredTab = Object.values(reloadedState.notesById).find(
      (tab) => tab.persistence === "transient" && tab.plainText === "concurrent edit",
    );
    expect(mocks.loadAll).toHaveBeenCalledTimes(2);
    expect(mocks.autoSave).toHaveBeenCalledTimes(1);
    expect(reloadedState.notesById[NOTE_ID]).toMatchObject({
      plainText: "cloud copy",
      isDirty: false,
      persistence: "library",
    });
    expect(recoveredTab).toBeDefined();
    if (!recoveredTab) {
      throw new Error("Expected the concurrent edit to become a recovery tab");
    }
    expect(recoveredTab).toMatchObject({
      plainText: "concurrent edit",
      isDirty: true,
      persistence: "transient",
      savedSnapshot: null,
    });
    expect(reloadedState.openTabIds).toEqual(expect.arrayContaining([NOTE_ID, recoveredTab.id]));
  });

  it("fails closed when a new edit cannot be saved after the source switch starts", async () => {
    const sourceSwitch = createDeferred<void>();
    const saveFailure = new Error("second save failed");
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.setActiveSource.mockReturnValueOnce(sourceSwitch.promise);
    mocks.autoSave
      .mockResolvedValueOnce({
        filePath: "C:/notes/library-note.md",
        noteId: NOTE_ID,
        createdAt: 1_000,
        updatedAt: 2_000,
      })
      .mockRejectedValueOnce(saveFailure);

    await renderApp(root);
    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-note"]').click();
      requiredElement<HTMLButtonElement>(container, '[data-testid="switch-cloud-source"]').click();
    });
    await flushUntil(
      () => mocks.autoSave.mock.calls.length === 1 && mocks.setActiveSource.mock.calls.length === 1,
      "the initial dirty save and source switch",
    );

    expect(mocks.loadAll).toHaveBeenCalledTimes(1);
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "dirty draft",
      isDirty: false,
    });
    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-concurrently"]').click();
    });
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "concurrent edit",
      isDirty: true,
    });

    await act(async () => {
      sourceSwitch.resolve(undefined);
      await sourceSwitch.promise;
    });
    await flushUntil(() => mocks.autoSave.mock.calls.length === 2, "the follow-up dirty save to fail");
    await flushReactWork();

    const stateAfterFailedReload = useNoteStore.getState();
    expect(mocks.loadAll).toHaveBeenCalledTimes(1);
    expect(mocks.autoSave).toHaveBeenNthCalledWith(
      2,
      NOTE_ID,
      "Disk title",
      expect.stringContaining("concurrent edit"),
      "",
      true,
      false,
      "local",
    );
    expect(stateAfterFailedReload.openTabIds).toEqual([NOTE_ID]);
    expect(stateAfterFailedReload.activeTabId).toBe(NOTE_ID);
    expect(stateAfterFailedReload.notesById[NOTE_ID]).toMatchObject({
      plainText: "concurrent edit",
      isDirty: true,
      persistence: "library",
    });
  });

  it("waits for calendar preservation before applying an automatic cloud recovery", async () => {
    const calendarRecovery = createDeferred<{
      status: "recovered";
      loadedFrom: "cloud";
      recoveryCopyPath: string;
    }>();
    mocks.loadAll.mockReset().mockResolvedValueOnce(createLoadResult("local_fallback", "local fallback"));
    mocks.cloudStatus.mockReset().mockResolvedValue({
      enabled: true,
      provider: "google-drive",
      syncFolder: "C:/cloud",
      activeSource: "cloud",
      resolvedSource: "local_fallback",
      cloudUnavailable: true,
    });

    await renderApp(root);
    mocks.loadAll.mockResolvedValueOnce(createLoadResult("cloud", "cloud copy"));
    mocks.cloudStatus.mockResolvedValue({
      enabled: true,
      provider: "google-drive",
      syncFolder: "C:/cloud",
      activeSource: "cloud",
      resolvedSource: "cloud",
      cloudUnavailable: false,
    });
    mocks.recoverCalendarDataFromCloud.mockReturnValueOnce(calendarRecovery.promise);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flushUntil(
      () => mocks.recoverCalendarDataFromCloud.mock.calls.length === 1,
      "calendar preservation to start",
    );

    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "local fallback",
    });
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      window.dispatchEvent(new Event("focus"));
    });
    await flushReactWork();
    expect(mocks.recoverCalendarDataFromCloud).toHaveBeenCalledTimes(1);
    expect(mocks.loadAll).toHaveBeenCalledTimes(2);

    await act(async () => {
      calendarRecovery.resolve({
        status: "recovered",
        loadedFrom: "cloud",
        recoveryCopyPath: "C:/notes/calendar.json.local-recovery.bak",
      });
      await calendarRecovery.promise;
    });
    await flushReactWork();

    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "cloud copy",
    });
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(2);
    expect(mocks.recoverCalendarDataFromCloud.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cleanOrphanNoteLinks.mock.invocationCallOrder[1],
    );
    expect(mocks.dialogMessage).toHaveBeenCalledWith(
      expect.stringContaining("C:/notes/calendar.json.local-recovery.bak"),
      expect.objectContaining({ kind: "info" }),
    );
  });

  it("does not apply cloud notes when calendar preservation blocks recovery", async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.loadAll.mockReset().mockResolvedValueOnce(createLoadResult("local_fallback", "local fallback"));
    mocks.cloudStatus.mockReset().mockResolvedValue({
      enabled: true,
      provider: "google-drive",
      syncFolder: "C:/cloud",
      activeSource: "cloud",
      resolvedSource: "local_fallback",
      cloudUnavailable: true,
    });

    await renderApp(root);
    mocks.loadAll.mockResolvedValueOnce(createLoadResult("cloud", "cloud copy"));
    mocks.cloudStatus.mockResolvedValue({
      enabled: true,
      provider: "google-drive",
      syncFolder: "C:/cloud",
      activeSource: "cloud",
      resolvedSource: "cloud",
      cloudUnavailable: false,
    });
    mocks.recoverCalendarDataFromCloud.mockResolvedValueOnce({
      status: "blocked",
      loadedFrom: "local_fallback",
      recoveryCopyPath: "C:/notes/calendar.json.local-recovery.bak",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flushUntil(
      () => mocks.recoverCalendarDataFromCloud.mock.calls.length === 1,
      "calendar recovery to block",
    );
    await flushReactWork();

    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "local fallback",
    });
    expect(mocks.cleanOrphanNoteLinks).toHaveBeenCalledTimes(1);
    expect(mocks.dialogMessage).toHaveBeenCalledWith(
      expect.stringContaining("C:/notes/calendar.json.local-recovery.bak"),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("waits for calendar and pending note saves before installing an update", async () => {
    const calendarSave = createDeferred<"saved" | "blocked">();
    const firstNoteSave = createDeferred<{
      filePath: string;
      noteId: string;
      createdAt: number;
      updatedAt: number;
    }>();
    const followUpNoteSave = createDeferred<{
      filePath: string;
      noteId: string;
      createdAt: number;
      updatedAt: number;
    }>();
    mocks.saveCalendarData.mockReturnValueOnce(calendarSave.promise);
    mocks.autoSave
      .mockReturnValueOnce(firstNoteSave.promise)
      .mockReturnValueOnce(followUpNoteSave.promise);

    await renderApp(root);
    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="install-update"]').click();
    });
    await flushUntil(() => mocks.saveCalendarData.mock.calls.length === 1, "the pre-update calendar save");

    expect(mocks.updaterInstall).not.toHaveBeenCalled();

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-note"]').click();
    });
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "dirty draft",
      isDirty: true,
    });

    await act(async () => {
      calendarSave.resolve("saved");
      await calendarSave.promise;
    });
    await flushUntil(() => mocks.autoSave.mock.calls.length === 1, "the pending note save to start");

    expect(mocks.updaterInstall).not.toHaveBeenCalled();
    expect(mocks.autoSave).toHaveBeenCalledWith(
      NOTE_ID,
      "Disk title",
      expect.stringContaining("dirty draft"),
      "",
      true,
      false,
      "local",
    );

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-concurrently"]').click();
    });
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "concurrent edit",
      isDirty: true,
    });

    await act(async () => {
      firstNoteSave.resolve({
        filePath: "C:/notes/library-note.md",
        noteId: NOTE_ID,
        createdAt: 1_000,
        updatedAt: 2_000,
      });
      await firstNoteSave.promise;
    });
    await flushUntil(() => mocks.autoSave.mock.calls.length === 2, "the follow-up note save to start");

    expect(mocks.updaterInstall).not.toHaveBeenCalled();
    expect(mocks.autoSave).toHaveBeenNthCalledWith(
      2,
      NOTE_ID,
      "Disk title",
      expect.stringContaining("concurrent edit"),
      "",
      true,
      false,
      "local",
    );

    await act(async () => {
      followUpNoteSave.resolve({
        filePath: "C:/notes/library-note.md",
        noteId: NOTE_ID,
        createdAt: 1_000,
        updatedAt: 3_000,
      });
      await followUpNoteSave.promise;
    });
    await flushUntil(() => mocks.updaterInstall.mock.calls.length === 1, "the update installation");

    expect(mocks.saveCalendarData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.autoSave.mock.invocationCallOrder[0],
    );
    expect(mocks.autoSave.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.autoSave.mock.invocationCallOrder[1],
    );
    expect(mocks.autoSave.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.updaterInstall.mock.invocationCallOrder[0],
    );
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "concurrent edit",
      isDirty: false,
    });
  });

  it("waits for an already-running note save before installing an update", async () => {
    const inFlightNoteSave = createDeferred<{
      filePath: string;
      noteId: string;
      createdAt: number;
      updatedAt: number;
    }>();
    mocks.autoSave.mockReturnValueOnce(inFlightNoteSave.promise);
    mocks.dialogMessage.mockResolvedValueOnce("No");

    await renderApp(root);
    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-note"]').click();
      await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    });
    await flushUntil(() => mocks.autoSave.mock.calls.length === 1, "the note save to start");

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="install-update"]').click();
    });
    await flushUntil(() => mocks.saveCalendarData.mock.calls.length === 1, "the pre-update calendar save");

    expect(mocks.updaterInstall).not.toHaveBeenCalled();

    await act(async () => {
      inFlightNoteSave.resolve({
        filePath: "C:/notes/library-note.md",
        noteId: NOTE_ID,
        createdAt: 1_000,
        updatedAt: 2_000,
      });
      await inFlightNoteSave.promise;
    });
    await flushUntil(() => mocks.updaterInstall.mock.calls.length === 1, "the update installation");

    expect(mocks.autoSave.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveCalendarData.mock.invocationCallOrder[0],
    );
    expect(mocks.saveCalendarData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updaterInstall.mock.invocationCallOrder[0],
    );
  });

  it("does not install an update when the calendar save is blocked", async () => {
    mocks.saveCalendarData.mockResolvedValueOnce("blocked");

    await renderApp(root);
    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="install-update"]').click();
    });
    await flushUntil(() => mocks.saveCalendarData.mock.calls.length === 1, "the blocked calendar save");
    await flushReactWork();

    expect(mocks.updaterInstall).not.toHaveBeenCalled();
    expect(mocks.dialogMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("does not install an update when the calendar save fails", async () => {
    const failure = new Error("calendar save failed");
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.saveCalendarData.mockRejectedValueOnce(failure);

    await renderApp(root);
    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="install-update"]').click();
    });
    await flushUntil(() => mocks.saveCalendarData.mock.calls.length === 1, "the failed calendar save");
    await flushReactWork();

    expect(mocks.updaterInstall).not.toHaveBeenCalled();
    expect(mocks.dialogMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("does not install an update when a pending note save fails", async () => {
    const calendarSave = createDeferred<"saved" | "blocked">();
    const failure = new Error("note save failed");
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.saveCalendarData.mockReturnValueOnce(calendarSave.promise);
    mocks.autoSave.mockRejectedValueOnce(failure);

    await renderApp(root);
    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="install-update"]').click();
    });
    await flushUntil(() => mocks.saveCalendarData.mock.calls.length === 1, "the pre-update calendar save");

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="edit-note"]').click();
      calendarSave.resolve("saved");
      await calendarSave.promise;
    });
    await flushUntil(() => mocks.autoSave.mock.calls.length === 1, "the failed note save");
    await flushReactWork();

    expect(mocks.updaterInstall).not.toHaveBeenCalled();
    expect(useNoteStore.getState().notesById[NOTE_ID]).toMatchObject({
      plainText: "dirty draft",
      isDirty: true,
    });
    expect(mocks.dialogMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("releases the close guard only after saves finish and restores it when installation fails", async () => {
    const calendarSave = createDeferred<"saved" | "blocked">();
    const installation = createDeferred<void>();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.saveCalendarData.mockReturnValueOnce(calendarSave.promise);
    mocks.updaterInstall.mockReturnValueOnce(installation.promise);

    await renderApp(root);
    const closeRequest = mocks.closeRequestHandlers[mocks.closeRequestHandlers.length - 1];
    if (!closeRequest) {
      throw new Error("Expected a close-request handler");
    }

    await act(async () => {
      requiredElement<HTMLButtonElement>(container, '[data-testid="install-update"]').click();
    });
    await flushUntil(() => mocks.saveCalendarData.mock.calls.length === 1, "the pre-update calendar save");

    const preventBeforeSave = vi.fn();
    await act(async () => {
      await closeRequest({ preventDefault: preventBeforeSave });
    });
    expect(preventBeforeSave).toHaveBeenCalledOnce();
    expect(mocks.updaterInstall).not.toHaveBeenCalled();

    await act(async () => {
      calendarSave.resolve("saved");
      await calendarSave.promise;
    });
    await flushUntil(() => mocks.updaterInstall.mock.calls.length === 1, "the update installation");

    const preventDuringInstall = vi.fn();
    await act(async () => {
      await closeRequest({ preventDefault: preventDuringInstall });
    });
    expect(preventDuringInstall).not.toHaveBeenCalled();

    mocks.saveCalendarData.mockResolvedValueOnce("blocked");
    await act(async () => {
      installation.reject(new Error("install failed"));
      await installation.promise.catch(() => undefined);
    });
    await flushReactWork();

    const preventAfterFailure = vi.fn();
    await act(async () => {
      await closeRequest({ preventDefault: preventAfterFailure });
    });
    expect(preventAfterFailure).toHaveBeenCalledOnce();
  });
});
