// @vitest-environment jsdom

import type { Editor } from "@tiptap/react";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  autoSave: vi.fn(),
  loadAll: vi.fn(),
  dialogMessage: vi.fn(),
  cloudStatus: vi.fn(),
  recoverCalendarDataFromCloud: vi.fn(),
  editor: null as Editor | null,
}));

vi.mock("./lib/tauriApi", () => ({
  hwanNote: {
    window: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), exit: vi.fn() },
    note: {
      autoSave: mocks.autoSave,
      loadAll: mocks.loadAll,
      drainOpenIntents: vi.fn().mockResolvedValue([]),
      onOpenIntent: vi.fn(() => () => undefined),
    },
    settings: {
      getAutoSaveDir: vi.fn().mockResolvedValue({
        customDir: null, effectiveDir: "C:/notes", isDefault: true,
        status: "unset", expectedDir: "C:/notes", error: null,
      }),
    },
    session: {
      load: vi.fn().mockResolvedValue({ openTabIds: ["note-a", "note-b"], activeTabId: "note-a" }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    cloud: {
      status: mocks.cloudStatus,
      detectProviders: vi.fn().mockResolvedValue([]),
      onFolderMissing: vi.fn(() => () => undefined),
    },
  },
  hwanShell: { openExternal: vi.fn() },
}));

vi.mock("./stores/calendarStore", () => ({
  useCalendarStore: {
    getState: () => ({
      loadCalendarData: vi.fn().mockResolvedValue(undefined),
      cleanOrphanNoteLinks: vi.fn(),
      recoverCalendarDataFromCloud: mocks.recoverCalendarDataFromCloud,
    }),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: vi.fn().mockResolvedValue(() => undefined) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  message: mocks.dialogMessage,
}));
vi.mock("./components/SettingsPanel", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ open }: { open: boolean }) => open
      ? createElement("div", { "data-testid": "ime-settings" }, createElement("input"))
      : null,
  };
});
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/UpdateToast", () => ({ default: () => null }));
vi.mock("./components/calendar/CalendarPage", () => ({ default: () => null }));
vi.mock("./components/TitleBar", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ tabs, onSelectTab, onDropTabOutside }: {
      tabs: Array<{ id: string }>;
      onSelectTab: (id: string) => void;
      onDropTabOutside: (id: string, clientX: number, clientY: number) => void;
    }) => createElement("nav", null, ...tabs.flatMap(({ id }) => [
      createElement("button", {
        key: id, "data-select-tab": id, onClick: () => onSelectTab(id),
      }, id),
      createElement("button", {
        key: `split-${id}`, "data-split-tab": id, onClick: () => onDropTabOutside(id, 750, 200),
      }, `split ${id}`),
    ])),
  };
});
// Keep the real toolbar effects and rendering; only observe its public editor prop.
vi.mock("./components/Toolbar", async (importOriginal) => {
  const { createElement } = await import("react");
  const original = await importOriginal<typeof import("./components/Toolbar")>();
  return {
    ...original,
    default: (props: Parameters<typeof original.default>[0]) => {
      mocks.editor = props.editor;
      return createElement(original.default, props);
    },
  };
});

import App from "./App";
import { I18nProvider } from "./i18n/context";
import { useNoteStore } from "./stores/noteStore";

const AUTO_SAVE_DELAY_MS = 1_750;

function savedResult(noteId: string) {
  return { filePath: `C:/notes/${noteId}.md`, noteId, createdAt: 1_000, updatedAt: 2_000, contentDigest: `saved-${noteId}` };
}

function loadedResult() {
  return {
    notes: ["note-a", "note-b"].map((noteId) => ({
      noteId, title: noteId, isTitleManual: true, markdown: `body of ${noteId}`,
      folderPath: "", createdAt: 1_000, updatedAt: 1_000,
      filePath: `C:/notes/${noteId}.md`, isPinned: false, contentDigest: `loaded-${noteId}`,
    })),
    folders: [], loadedFrom: "local", cloudUnavailable: false, loadState: "ready",
    issues: [], indexSourcePath: "C:/notes/.hwan-note-index.json", indexBackupPath: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushReactWork() {
  for (let round = 0; round < 8; round += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function advanceTime(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  await flushReactWork();
}

function currentEditor() {
  const editor = mocks.editor;
  if (!editor || editor.isDestroyed) throw new Error("Expected a mounted real Tiptap editor");
  return editor;
}

async function insertText(editor: Editor, text: string) {
  await act(async () => { editor.view.dispatch(editor.state.tr.insertText(text)); });
  await flushReactWork();
}

async function selectText(editor: Editor, from: number, to = from) {
  await act(async () => {
    editor.commands.setTextSelection({ from, to });
    editor.view.focus();
  });
  await flushReactWork();
}

function selectionSnapshot(editor: Editor) {
  const selection = window.getSelection();
  if (!selection?.anchorNode) throw new Error("Expected a DOM selection inside the editor");
  expect(editor.view.dom.contains(selection.anchorNode)).toBe(true);
  expect(document.activeElement).toBe(editor.view.dom);
  return {
    editor,
    dom: editor.view.dom,
    from: editor.state.selection.from,
    to: editor.state.selection.to,
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };
}

function expectSelectionUnchanged(
  snapshot: ReturnType<typeof selectionSnapshot>, container: HTMLElement, pane: "primary" | "secondary" = "primary",
) {
  expect(currentEditor()).toBe(snapshot.editor);
  expect(container.querySelector(`[data-pane="${pane}"] .note-editor[contenteditable="true"]`)).toBe(snapshot.dom);
  expect(document.activeElement).toBe(snapshot.dom);
  expect(snapshot.editor.state.selection.from).toBe(snapshot.from);
  expect(snapshot.editor.state.selection.to).toBe(snapshot.to);
  const selection = window.getSelection();
  expect(selection?.anchorNode).toBe(snapshot.anchorNode);
  expect(selection?.anchorOffset).toBe(snapshot.anchorOffset);
  expect(selection?.focusNode).toBe(snapshot.focusNode);
  expect(selection?.focusOffset).toBe(snapshot.focusOffset);
}

describe("App focus with the real editor during autosave", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    document.body.inert = false;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    // jsdom does not implement layout; ProseMirror reads these when focusing.
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    useNoteStore.setState({
      notesById: {}, noteIds: [], openTabIds: [], activeTabId: null,
      allNotes: [], openTabs: [], activeOpenTab: null, sidebarVisible: false,
    });
    mocks.editor = null;
    const library = loadedResult();
    mocks.autoSave.mockReset().mockImplementation(async (
      noteId: string, title: string, markdown: string, folderPath: string, isTitleManual: boolean, isPinned: boolean,
    ) => {
      const saved = {
        ...savedResult(noteId), title, markdown, folderPath, isTitleManual, isPinned,
      };
      library.notes = [...library.notes.filter((note) => note.noteId !== noteId), saved];
      return savedResult(noteId);
    });
    mocks.loadAll.mockReset().mockImplementation(async () => ({ ...library, notes: [...library.notes] }));
    mocks.dialogMessage.mockReset().mockResolvedValue(undefined);
    mocks.cloudStatus.mockReset().mockResolvedValue({
      enabled: false, provider: null, syncFolder: null, activeSource: "local",
      resolvedSource: "local", cloudUnavailable: false,
    });
    mocks.recoverCalendarDataFromCloud.mockReset().mockResolvedValue({
      status: "recovered", loadedFrom: "cloud", recoveryCopyPath: null,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function renderApp() {
    await act(async () => {
      root.render(<StrictMode><I18nProvider><App /></I18nProvider></StrictMode>);
    });
    await flushReactWork();
    await advanceTime(32);
    const editor = currentEditor();
    await selectText(editor, 5);
    return editor;
  }

  async function switchToNoteB() {
    const button = container.querySelector<HTMLButtonElement>('[data-select-tab="note-b"]');
    if (!button) throw new Error("Expected a second note tab");
    await act(async () => { button.click(); });
    await flushReactWork();
    await advanceTime(32);
    const editor = currentEditor();
    await selectText(editor, 4, 7);
    expect(useNoteStore.getState().activeTabId).toBe("note-b");
    return editor;
  }

  it("keeps focus and selection when autosave starts and finishes after further typing", async () => {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    const editor = await renderApp();
    await insertText(editor, " first edit ");
    const beforeSave = selectionSnapshot(editor);

    await advanceTime(AUTO_SAVE_DELAY_MS);
    expect(mocks.autoSave).toHaveBeenCalledTimes(1);
    expect(mocks.autoSave.mock.calls[0][0]).toBe("note-a");
    expectSelectionUnchanged(beforeSave, container);

    await insertText(editor, " second edit ");
    await selectText(editor, 3, 8);
    const duringSave = selectionSnapshot(editor);
    await act(async () => { pendingSave.resolve(savedResult("note-a")); });
    await flushReactWork();

    expect(useNoteStore.getState().notesById["note-a"].plainText).toContain("second edit");
    expect(useNoteStore.getState().notesById["note-a"].isDirty).toBe(true);
    expectSelectionUnchanged(duringSave, container);

    await advanceTime(AUTO_SAVE_DELAY_MS);
    expect(mocks.autoSave).toHaveBeenCalledTimes(2);
    expect(useNoteStore.getState().notesById["note-a"].isDirty).toBe(false);
    expectSelectionUnchanged(duringSave, container);
  });

  it("keeps the current editor focused and dirty after an ordinary autosave error", async () => {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const editor = await renderApp();
    await insertText(editor, " unsaved ");
    await advanceTime(AUTO_SAVE_DELAY_MS);
    await selectText(editor, 2, 6);
    const snapshot = selectionSnapshot(editor);
    const failure = new Error("disk write failed");

    await act(async () => { pendingSave.reject(failure); });
    await flushReactWork();

    expect(log).toHaveBeenCalledWith("Save failed:", failure);
    expect(mocks.dialogMessage).not.toHaveBeenCalled();
    expect(useNoteStore.getState().notesById["note-a"].isDirty).toBe(true);
    expectSelectionUnchanged(snapshot, container);
  });

  it("keeps the second note editor unchanged when a previous tab's save completes", async () => {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    const firstEditor = await renderApp();
    await insertText(firstEditor, " save A ");
    await advanceTime(AUTO_SAVE_DELAY_MS);
    const secondEditor = await switchToNoteB();
    await insertText(secondEditor, " typing B ");
    await selectText(secondEditor, 2, 5);
    const snapshot = selectionSnapshot(secondEditor);

    await act(async () => { pendingSave.resolve(savedResult("note-a")); });
    await flushReactWork();

    expect(useNoteStore.getState().notesById["note-a"].isDirty).toBe(false);
    expect(useNoteStore.getState().notesById["note-b"].plainText).toContain("typing B");
    expect(useNoteStore.getState().activeTabId).toBe("note-b");
    expectSelectionUnchanged(snapshot, container);
  });

  it("preserves the current tab and focus when an earlier tab's save reports a conflict", async () => {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firstEditor = await renderApp();
    await insertText(firstEditor, " conflicted A ");
    await advanceTime(AUTO_SAVE_DELAY_MS);
    const secondEditor = await switchToNoteB();
    await insertText(secondEditor, " typing B ");
    await selectText(secondEditor, 2, 5);
    const snapshot = selectionSnapshot(secondEditor);

    await act(async () => { pendingSave.reject(new Error("note_conflict: original changed on disk")); });
    await flushReactWork();

    const state = useNoteStore.getState();
    expect(Object.values(state.notesById).some((tab) =>
      tab.id !== "note-a" && tab.plainText.includes("conflicted A")
    )).toBe(true);
    expect(state.activeTabId).toBe("note-b");
    expectSelectionUnchanged(snapshot, container);
    expect(mocks.dialogMessage).not.toHaveBeenCalled();
  });

  it("keeps the active editor DOM and selection when its draft becomes a conflict copy", async () => {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const editor = await renderApp();
    await insertText(editor, " conflicted active draft ");
    await advanceTime(AUTO_SAVE_DELAY_MS);
    await insertText(editor, " newer typing ");
    await selectText(editor, 3, 9);
    const snapshot = selectionSnapshot(editor);

    await act(async () => { pendingSave.reject(new Error("note_conflict: original changed on disk")); });
    await flushReactWork();

    const state = useNoteStore.getState();
    const recovered = Object.values(state.notesById).find((tab) =>
      tab.id !== "note-a" && tab.plainText.includes("conflicted active draft")
    );
    expect(recovered?.plainText).toContain("newer typing");
    expect(state.activeTabId).toBe(recovered?.id);
    expectSelectionUnchanged(snapshot, container);
    expect(mocks.dialogMessage).not.toHaveBeenCalled();

    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    await flushReactWork();
    const undoneDraft = useNoteStore.getState().notesById[recovered!.id].plainText;
    expect(undoneDraft).toContain("conflicted active draft");
    expect(undoneDraft).not.toContain("newer typing");
    expect(currentEditor()).toBe(editor);
    expect(document.activeElement).toBe(snapshot.dom);

    const originalTabButton = container.querySelector<HTMLButtonElement>('[data-select-tab="note-a"]');
    if (!originalTabButton) throw new Error("Expected the preserved original note tab");
    await act(async () => { originalTabButton.click(); });
    await flushReactWork();
    await advanceTime(32);

    expect(useNoteStore.getState().activeTabId).toBe("note-a");
    expect(currentEditor()).not.toBe(editor);
    expect(currentEditor().view.dom).not.toBe(snapshot.dom);
    expect(currentEditor().getText()).toBe("body of note-a");
    expect(container.querySelector('[data-pane="primary"] .note-editor')?.textContent).toBe("body of note-a");
  });

  it("continues editing the same DOM and selection in a recovery copy after cloud reconnects", async () => {
    mocks.loadAll.mockResolvedValueOnce({ ...loadedResult(), loadedFrom: "local_fallback" });
    mocks.cloudStatus.mockResolvedValue({
      enabled: true, provider: "google-drive", syncFolder: "C:/cloud", activeSource: "cloud",
      resolvedSource: "local_fallback", cloudUnavailable: true,
    });
    const editor = await renderApp();
    await insertText(editor, " local draft ");
    await selectText(editor, 3, 8);
    const snapshot = selectionSnapshot(editor);
    const cloudLibrary = loadedResult();
    cloudLibrary.notes[0].markdown = "different cloud contents";
    mocks.loadAll.mockResolvedValueOnce({ ...cloudLibrary, loadedFrom: "cloud" });
    mocks.cloudStatus.mockResolvedValue({
      enabled: true, provider: "google-drive", syncFolder: "C:/cloud", activeSource: "cloud",
      resolvedSource: "cloud", cloudUnavailable: false,
    });

    await advanceTime(1_500);

    expect(mocks.recoverCalendarDataFromCloud).toHaveBeenCalledTimes(1);
    const state = useNoteStore.getState();
    const recoveryId = state.activeTabId!;
    expect(recoveryId).not.toBe("note-a");
    expect(state.notesById[recoveryId].plainText).toContain("local draft");
    expect(state.notesById["note-a"].plainText).toBe("different cloud contents");
    expectSelectionUnchanged(snapshot, container);
    expect(mocks.dialogMessage).not.toHaveBeenCalled();

    await insertText(editor, " continued after cloud ");
    expect(useNoteStore.getState().notesById[recoveryId].plainText).toContain("continued after cloud");
    expect(useNoteStore.getState().notesById["note-a"].plainText).toBe("different cloud contents");
    expect(document.activeElement).toBe(snapshot.dom);
  });

  it("keeps a conflicted secondary editor focused in its existing split pane", async () => {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await renderApp();
    const workspace = container.querySelector<HTMLElement>(".editor-workspace");
    const splitButton = container.querySelector<HTMLButtonElement>('[data-split-tab="note-b"]');
    if (!workspace || !splitButton) throw new Error("Expected workspace and split action");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1_000, 600));
    await act(async () => { splitButton.click(); });
    await flushReactWork();
    await advanceTime(32);
    const editor = currentEditor();
    expect(editor.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe("secondary");
    await selectText(editor, 4);
    await insertText(editor, " secondary draft ");
    await advanceTime(AUTO_SAVE_DELAY_MS);
    expect(mocks.autoSave.mock.calls[0][0]).toBe("note-b");
    await selectText(editor, 2, 6);
    const snapshot = selectionSnapshot(editor);
    const primaryDom = container.querySelector('[data-pane="primary"] .note-editor');

    await act(async () => { pendingSave.reject(new Error("note_conflict: original changed on disk")); });
    await flushReactWork();

    const state = useNoteStore.getState();
    expect(state.activeTabId).not.toBe("note-b");
    expect(state.notesById[state.activeTabId!].plainText).toContain("secondary draft");
    expect(container.querySelector('[data-pane="primary"] .note-editor')).toBe(primaryDom);
    expect(primaryDom?.textContent).toBe("body of note-a");
    expectSelectionUnchanged(snapshot, container, "secondary");
    expect(mocks.dialogMessage).not.toHaveBeenCalled();
  });

  it.each([
    { name: "active composition", isComposing: true },
    { name: "composition-confirmation keyCode 229", isComposing: false, keyCode: 229 },
  ])("ignores global editor and zoom commands during $name", async (composition) => {
    const editor = await renderApp();
    await act(async () => {
      for (let step = 0; step < 6; step += 1) {
        window.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -1, cancelable: true }));
      }
    });
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("20px");
    await selectText(editor, 2, 6);
    if (composition.isComposing) {
      await act(async () => { editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    }
    const snapshot = selectionSnapshot(editor);
    const beforeDocument = editor.getJSON();
    for (const shortcut of [
      { key: "F5", keyCode: 116 },
      { key: "b", keyCode: 66, ctrlKey: true },
      { key: "n", keyCode: 78, ctrlKey: true },
      { key: "Tab", keyCode: 9, ctrlKey: true },
      { key: "c", keyCode: 67, ctrlKey: true, shiftKey: true },
      { key: "0", keyCode: 48, ctrlKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, ...shortcut, ...composition,
      });
      await act(async () => { editor.view.dom.dispatchEvent(event); });
      await flushReactWork();
      expect(event.defaultPrevented, `IME shortcut ${shortcut.key}`).toBe(false);
      expect(editor.getJSON()).toEqual(beforeDocument);
      expect(useNoteStore.getState().openTabIds).toEqual(["note-a", "note-b"]);
      expect(useNoteStore.getState().activeTabId).toBe("note-a");
      expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("20px");
      expectSelectionUnchanged(snapshot, container);
    }

    if (composition.isComposing) {
      await act(async () => { editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
      await advanceTime(32);
    }

    const normalDateKey = new KeyboardEvent("keydown", { key: "F5", keyCode: 116, bubbles: true, cancelable: true });
    await act(async () => { editor.view.dom.dispatchEvent(normalDateKey); });
    await advanceTime(32);
    expect(normalDateKey.defaultPrevented).toBe(true);
    expect(editor.getJSON()).not.toEqual(beforeDocument);
    const normalZoomKey = new KeyboardEvent("keydown", { key: "0", keyCode: 48, ctrlKey: true, bubbles: true });
    await act(async () => { editor.view.dom.dispatchEvent(normalZoomKey); });
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("14px");
  });

  it.each([
    { name: "active composition", isComposing: true },
    { name: "composition-confirmation keyCode 229", isComposing: false, keyCode: 229 },
  ])("keeps settings open and focused for Escape during $name", async (composition) => {
    const editor = await renderApp();
    const settingsButton = container.querySelector<HTMLButtonElement>(".toolbar-right button:last-child");
    if (!settingsButton) throw new Error("Expected settings button");
    await act(async () => { settingsButton.click(); });
    const input = container.querySelector<HTMLInputElement>('[data-testid="ime-settings"] input');
    if (!input) throw new Error("Expected settings input");
    await act(async () => { input.focus(); });
    const escape = new KeyboardEvent("keydown", {
      key: "Escape", keyCode: 27, bubbles: true, cancelable: true, ...composition,
    });
    await act(async () => { input.dispatchEvent(escape); });
    await advanceTime(32);
    expect(container.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(escape.defaultPrevented).toBe(false);

    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })); });
    await advanceTime(32);
    expect(container.querySelector('[data-testid="ime-settings"]')).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });
});
