// @vitest-environment jsdom

import type { Editor } from "@tiptap/react";
import { Profiler, StrictMode, act, type ProfilerOnRenderCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CellSelection } from "@tiptap/pm/tables";
import { NodeSelection, TextSelection, type EditorState, type Selection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type StatusCursor = { line: number; column: number; chars: number };

const mocks = vi.hoisted(() => ({
  autoSave: vi.fn(),
  loadAll: vi.fn(),
  dialogMessage: vi.fn(),
  cloudStatus: vi.fn(),
  getAutoSaveDir: vi.fn(),
  sessionLoad: vi.fn(),
  recoverCalendarDataFromCloud: vi.fn(),
  editor: null as Editor | null,
  status: null as StatusCursor | null,
  // Every toolbar editor and status cursor rendered, in order.
  editorHistory: [] as Array<Editor | null>,
  statusHistory: [] as StatusCursor[],
  // The focused tab ID the toolbar got last, and each render's toolbar editor,
  // toolbar tab ID and status cursor together.
  toolbarTabId: "",
  renders: [] as Array<{ toolbarEditor: Editor | null; toolbarTabId: string; status: StatusCursor }>,
  // Presses the real Bold button once in a commit without a focused tab.
  pressBoldWithoutFocusedTab: false,
  boldPressesWithoutFocusedTab: 0,
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
    settings: { getAutoSaveDir: mocks.getAutoSaveDir },
    session: { load: mocks.sessionLoad, save: vi.fn().mockResolvedValue(undefined) },
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
vi.mock("./components/SettingsPanel", () => ({ default: () => null }));
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/UpdateToast", () => ({ default: () => null }));
vi.mock("./components/calendar/CalendarPage", () => ({ default: () => null }));
vi.mock("./components/StatusBar", () => ({
  default: ({ line, column, chars }: StatusCursor) => {
    mocks.status = { line, column, chars };
    mocks.statusHistory.push(mocks.status);
    // The toolbar renders before the status bar in each App render.
    mocks.renders.push({ toolbarEditor: mocks.editor, toolbarTabId: mocks.toolbarTabId, status: mocks.status });
    return null;
  },
}));
vi.mock("./components/TitleBar", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ tabs, onSelectTab, onDropTabOutside, onCloseTab, onUnsplit, onViewChange }: {
      tabs: Array<{ id: string }>;
      onSelectTab: (id: string) => void;
      onDropTabOutside: (id: string, clientX: number, clientY: number) => void;
      onCloseTab: (id: string) => void;
      onUnsplit: (id: string) => void;
      onViewChange: (view: "notes" | "calendar") => void;
    }) => createElement("nav", null,
      createElement("button", { key: "view-calendar", "data-view": "calendar", onClick: () => onViewChange("calendar") }, "calendar"),
      ...tabs.flatMap(({ id }) => [
      createElement("button", { key: id, "data-select-tab": id, onClick: () => onSelectTab(id) }, id),
      createElement("button", {
        key: `right-${id}`, "data-split-right": id, onClick: () => onDropTabOutside(id, 750, 200),
      }, `split right ${id}`),
      createElement("button", {
        key: `left-${id}`, "data-split-left": id, onClick: () => onDropTabOutside(id, 250, 200),
      }, `split left ${id}`),
      createElement("button", { key: `close-${id}`, "data-close-tab": id, onClick: () => onCloseTab(id) }, `close ${id}`),
      createElement("button", { key: `unsplit-${id}`, "data-unsplit-tab": id, onClick: () => onUnsplit(id) }, `unsplit ${id}`),
    ])),
  };
});
// Keep the real toolbar; only observe the editor App treats as focused.
vi.mock("./components/Toolbar", async (importOriginal) => {
  const { createElement, useLayoutEffect } = await import("react");
  const original = await importOriginal<typeof import("./components/Toolbar")>();
  return {
    ...original,
    default: (props: Parameters<typeof original.default>[0]) => {
      mocks.editor = props.editor;
      mocks.toolbarTabId = props.activeTabId;
      mocks.editorHistory.push(props.editor);
      useLayoutEffect(() => {
        if (mocks.pressBoldWithoutFocusedTab && !props.activeTabId) {
          mocks.pressBoldWithoutFocusedTab = false;
          mocks.boldPressesWithoutFocusedTab += 1;
          document.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')?.click();
        }
      });
      return createElement(original.default, props);
    },
  };
});

import App from "./App";
import { restoreEditorFocus } from "./components/Editor";
import { I18nProvider } from "./i18n/context";
import { useNoteStore } from "./stores/noteStore";

const windowState = { focused: true, visibility: "visible" as DocumentVisibilityState };

const AUTO_SAVE_DELAY_MS = 1_750;
const AUTO_SAVE_DIR_POLL_INTERVAL_MS = 5_000;

type LibraryNote = {
  noteId: string; title: string; isTitleManual: boolean; markdown: string; folderPath: string;
  createdAt: number; updatedAt: number; filePath: string; isPinned: boolean; contentDigest: string;
};

function savedResult(noteId: string) {
  return { filePath: `C:/notes/${noteId}.md`, noteId, createdAt: 1_000, updatedAt: 2_000, contentDigest: `saved-${noteId}` };
}

function libraryNote(noteId: string): LibraryNote {
  return {
    noteId, title: noteId, isTitleManual: true, markdown: `body of ${noteId}`,
    folderPath: "", createdAt: 1_000, updatedAt: 1_000,
    filePath: `C:/notes/${noteId}.md`, isPinned: false, contentDigest: `loaded-${noteId}`,
  };
}

function loadResult(notes: LibraryNote[]) {
  return {
    notes, folders: [], loadedFrom: "local", cloudUnavailable: false, loadState: "ready",
    issues: [], indexSourcePath: "C:/notes/.hwan-note-index.json", indexBackupPath: null,
  };
}

function autoSaveDirInfo(status: "unset" | "unavailable" = "unset") {
  return status === "unset"
    ? { customDir: null, effectiveDir: "C:/notes", isDefault: true, status, expectedDir: "C:/notes", error: null }
    : {
      customDir: "D:/missing", effectiveDir: null, isDefault: false, status,
      expectedDir: "D:/missing", error: "custom_auto_save_dir_unavailable",
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

type EditorSnapshot = { editor: Editor; dom: HTMLElement; from: number; to: number; text: string };

function snapshotEditor(editor: Editor): EditorSnapshot {
  return {
    editor,
    dom: editor.view.dom,
    from: editor.state.selection.from,
    to: editor.state.selection.to,
    text: editor.getText(),
  };
}

/** The same Tiptap instance and DOM are still mounted in `pane`, with selection and undo history intact. */
function expectEditorKept(snapshot: EditorSnapshot, pane: "primary" | "secondary") {
  const { editor, dom } = snapshot;
  expect(editor.isDestroyed, "editor instance destroyed").toBe(false);
  expect(dom.isConnected, "editor DOM disconnected").toBe(true);
  expect(editor.view.dom).toBe(dom);
  expect(dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe(pane);
  expect(editor.state.selection.from).toBe(snapshot.from);
  expect(editor.state.selection.to).toBe(snapshot.to);
  expect(editor.getText()).toBe(snapshot.text);
  expect(editor.can().undo(), "undo history lost").toBe(true);
}

function expectFocused(snapshot: EditorSnapshot) {
  expect(document.activeElement).toBe(snapshot.dom);
  expect(mocks.editor).toBe(snapshot.editor);
  const selection = window.getSelection();
  expect(selection?.anchorNode && snapshot.dom.contains(selection.anchorNode)).toBe(true);
}

function expectStatusCursorAt(snapshot: EditorSnapshot) {
  // Single-paragraph documents: position p is column p on line 1.
  expect(mocks.status).toEqual({ line: 1, column: snapshot.from, chars: snapshot.text.length });
}

describe("App split view keeps the editors that stay visible", () => {
  let container: HTMLDivElement;
  let root: Root;
  let library: { notes: LibraryNote[] };
  let appCommits: Mock<ProfilerOnRenderCallback>;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    document.body.inert = false;
    // Focus restoration needs an active window. Model one explicitly: jsdom's
    // document.hasFocus() is false whenever no element has focus.
    windowState.focused = true;
    windowState.visibility = "visible";
    vi.spyOn(document, "hasFocus").mockImplementation(() => windowState.focused);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => windowState.visibility);
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
    mocks.status = null;
    mocks.editorHistory.length = 0;
    mocks.statusHistory.length = 0;
    mocks.toolbarTabId = "";
    mocks.renders.length = 0;
    mocks.pressBoldWithoutFocusedTab = false;
    mocks.boldPressesWithoutFocusedTab = 0;
    library = { notes: ["note-a", "note-b"].map(libraryNote) };
    mocks.autoSave.mockReset().mockImplementation(async (
      noteId: string, title: string, markdown: string, folderPath: string, isTitleManual: boolean, isPinned: boolean,
    ) => {
      const saved = { ...savedResult(noteId), title, markdown, folderPath, isTitleManual, isPinned };
      library.notes = [...library.notes.filter((note) => note.noteId !== noteId), saved];
      return savedResult(noteId);
    });
    mocks.loadAll.mockReset().mockImplementation(async () => loadResult([...library.notes]));
    mocks.sessionLoad.mockReset().mockResolvedValue({ openTabIds: ["note-a", "note-b"], activeTabId: "note-a" });
    mocks.getAutoSaveDir.mockReset().mockImplementation(async () => autoSaveDirInfo());
    mocks.dialogMessage.mockReset().mockResolvedValue(undefined);
    mocks.cloudStatus.mockReset().mockResolvedValue({
      enabled: false, provider: null, syncFolder: null, activeSource: "local",
      resolvedSource: "local", cloudUnavailable: false,
    });
    mocks.recoverCalendarDataFromCloud.mockReset().mockResolvedValue({
      status: "recovered", loadedFrom: "cloud", recoveryCopyPath: null,
    });
    appCommits = vi.fn<ProfilerOnRenderCallback>();
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
      root.render(
        <StrictMode>
          <Profiler id="app" onRender={appCommits}>
            <I18nProvider><App /></I18nProvider>
          </Profiler>
        </StrictMode>
      );
    });
    await flushReactWork();
    await advanceTime(32);
  }

  async function click(selector: string) {
    const element = container.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Expected ${selector}`);
    await act(async () => { element.click(); });
    await flushReactWork();
    await advanceTime(32);
  }

  function paneEditor(pane: "primary" | "secondary") {
    const dom = container.querySelector<HTMLElement & { editor?: Editor }>(`[data-pane="${pane}"] .note-editor`);
    const editor = dom?.editor;
    if (!editor || editor.isDestroyed) throw new Error(`Expected a mounted editor in the ${pane} pane`);
    return editor;
  }

  /** Opens note-b beside note-a (A | B) and returns both editors. */
  async function splitAB() {
    await renderApp();
    const workspace = container.querySelector<HTMLElement>(".editor-workspace");
    if (!workspace) throw new Error("Expected the editor workspace");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1_000, 600));
    await click('[data-split-right="note-b"]');
    expect(container.querySelector(".editor-workspace.split")).not.toBeNull();
    return { a: paneEditor("primary"), b: paneEditor("secondary") };
  }

  /** Focuses `editor`, types, and leaves a non-collapsed selection. */
  async function typeIn(editor: Editor, text: string, from: number, to: number) {
    await selectText(editor, 4);
    await insertText(editor, text);
    await selectText(editor, from, to);
    expect(document.activeElement).toBe(editor.view.dom);
    return snapshotEditor(editor);
  }

  function expectSinglePane() {
    expect(container.querySelector(".editor-workspace.split")).toBeNull();
    expect(container.querySelector(".split-divider")).toBeNull();
    expect(container.querySelectorAll(".editor-pane")).toHaveLength(1);
    const pane = container.querySelector<HTMLElement>(".editor-pane");
    expect(pane?.getAttribute("data-pane")).toBe("primary");
    expect(pane?.className).toBe("editor-pane focused");
    expect(pane?.style.flexBasis).toBe("");
  }

  it("keeps the focused primary editor when an authoritative reload removes the other split note", async () => {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { a } = await splitAB();
    await selectText(a, 4);
    await insertText(a, " active draft ");
    await advanceTime(AUTO_SAVE_DELAY_MS);
    expect(mocks.autoSave.mock.calls[0][0]).toBe("note-a");
    await selectText(a, 3, 7);
    const snapshot = snapshotEditor(a);

    // Same-source authoritative snapshot: note-b was deleted on disk, note-a
    // changed, and the saved conflict copy of the draft exists.
    mocks.loadAll.mockImplementation(async () => loadResult([
      libraryNote("note-a"),
      ...library.notes.filter((note) => note.noteId !== "note-a" && note.noteId !== "note-b"),
    ]));
    await act(async () => { pendingSave.reject(new Error("note_conflict: original changed on disk")); });
    await flushReactWork();
    await advanceTime(32);

    expect(useNoteStore.getState().openTabIds).not.toContain("note-b");
    expect(mocks.loadAll).toHaveBeenCalledTimes(2);
    // The split stays open; the disk version of note-a takes the freed pane.
    expect(container.querySelector('[data-pane="secondary"] .note-editor')?.textContent).toBe("body of note-a");
    expectEditorKept(snapshot, "primary");
    expectFocused(snapshot);
    expectStatusCursorAt(snapshot);
    const recoveryId = useNoteStore.getState().activeTabId!;
    expect(useNoteStore.getState().notesById[recoveryId].plainText).toContain("active draft");

    await insertText(a, "!");
    expect(useNoteStore.getState().notesById[recoveryId].plainText).toBe(a.getText());
    expect(document.activeElement).toBe(snapshot.dom);
  });

  it("keeps the focused secondary editor when an authoritative reload leaves only its note", async () => {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { a, b } = await splitAB();
    await typeIn(a, " conflicted A ", 2, 6);
    // Focusing the other pane flushes note-a's pending save.
    const snapshot = await typeIn(b, " typing B ", 3, 9);
    expect(mocks.autoSave.mock.calls[0][0]).toBe("note-a");
    expect(mocks.status).toEqual({ line: 1, column: 3, chars: snapshot.text.length });

    // The disk snapshot only has note-b: note-a and its conflict copy were deleted.
    mocks.loadAll.mockImplementation(async () => loadResult(
      library.notes.filter((note) => note.noteId === "note-b")
    ));
    await act(async () => { pendingSave.reject(new Error("note_conflict: original changed on disk")); });
    await flushReactWork();
    await advanceTime(32);

    expect(useNoteStore.getState().openTabIds).toEqual(["note-b"]);
    expectSinglePane();
    expectEditorKept(snapshot, "primary");
    expectFocused(snapshot);
    expectStatusCursorAt(snapshot);

    await insertText(b, "!");
    expect(b.getText()).toContain("!");
    expect(useNoteStore.getState().notesById["note-b"].plainText).toBe(b.getText());
  });

  it("keeps the remaining primary editor when the user closes the other split tab", async () => {
    const { a } = await splitAB();
    const snapshot = await typeIn(a, " typing A ", 3, 8);

    await click('[data-close-tab="note-b"]');

    expect(useNoteStore.getState().openTabIds).toEqual(["note-a"]);
    expectSinglePane();
    expectEditorKept(snapshot, "primary");
    expectFocused(snapshot);
    expectStatusCursorAt(snapshot);
  });

  it("keeps the remaining secondary editor when the user closes the primary split tab", async () => {
    const { a, b } = await splitAB();
    await typeIn(a, " typing A ", 2, 2);
    const snapshot = await typeIn(b, " typing B ", 5, 9);

    await click('[data-close-tab="note-a"]');

    expect(useNoteStore.getState().openTabIds).toEqual(["note-b"]);
    expectSinglePane();
    expectEditorKept(snapshot, "primary");
    expectFocused(snapshot);
    expectStatusCursorAt(snapshot);
  });

  it("moves focus to the remaining editor's own selection when the focused split tab closes", async () => {
    const { a, b } = await splitAB();
    const kept = await typeIn(b, " typing B ", 2, 5);
    await selectText(a, 3);
    expect(document.activeElement).toBe(a.view.dom);

    // Like Ctrl+W in the focused pane: focus is in the editor that goes away.
    await click('[data-close-tab="note-a"]');

    expect(useNoteStore.getState().openTabIds).toEqual(["note-b"]);
    expectSinglePane();
    expect(a.isDestroyed).toBe(true);
    expectEditorKept(kept, "primary");
    expectFocused(kept);
    expectStatusCursorAt(kept);
  });

  it.each([
    { target: "note-a", typed: "primary" },
    { target: "note-b", typed: "secondary" },
  ] as const)("keeps the $typed editor when unsplitting to $target", async ({ target, typed }) => {
    const { a, b } = await splitAB();
    const snapshot = await typeIn(typed === "primary" ? a : b, ` typing ${typed} `, 3, 7);

    await click(`[data-unsplit-tab="${target}"]`);

    expect(useNoteStore.getState().openTabIds).toEqual(["note-a", "note-b"]);
    expect(useNoteStore.getState().activeTabId).toBe(target);
    expectSinglePane();
    expectEditorKept(snapshot, "primary");
    expectFocused(snapshot);
    expectStatusCursorAt(snapshot);
  });

  it("keeps the unsplit target's editor and selection when focus was in the other pane", async () => {
    const { a, b } = await splitAB();
    const kept = await typeIn(b, " typing B ", 2, 5);
    await typeIn(a, " typing A ", 3, 3);

    await click('[data-unsplit-tab="note-b"]');

    expectSinglePane();
    expect(a.isDestroyed).toBe(true);
    expectEditorKept(kept, "primary");
    // The closed pane had focus; the kept editor takes it back with its own selection.
    expectFocused(kept);
    expectStatusCursorAt(kept);
  });

  it.each([
    { side: "right", keptPane: "primary" },
    { side: "left", keptPane: "secondary" },
  ] as const)("keeps the existing editor when a tab is dropped on the $side to split", async ({ side, keptPane }) => {
    await renderApp();
    const a = paneEditor("primary");
    const snapshot = await typeIn(a, " typing A ", 3, 8);
    const workspace = container.querySelector<HTMLElement>(".editor-workspace")!;
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1_000, 600));

    await click(`[data-split-${side}="note-b"]`);

    expect(container.querySelector(".editor-workspace.split")).not.toBeNull();
    expect(container.querySelector(".split-divider")).not.toBeNull();
    expectEditorKept(snapshot, keptPane);
    const keptSection = snapshot.dom.closest<HTMLElement>(".editor-pane")!;
    expect(keptSection.className).toBe("editor-pane ");
    expect(keptSection.style.flexBasis).toBe("50%");
    // The new note's editor is created in the drop pane and focused, as before.
    const dropped = paneEditor(keptPane === "primary" ? "secondary" : "primary");
    expect(dropped.getText()).toBe("body of note-b");
    expect(mocks.editor).toBe(dropped);
    expect(useNoteStore.getState().activeTabId).toBe("note-b");
  });

  it("keeps an editor that moves to the primary pane when the primary tab closes with three tabs open", async () => {
    library.notes = ["note-a", "note-b", "note-c"].map(libraryNote);
    mocks.sessionLoad.mockResolvedValue({ openTabIds: ["note-a", "note-b", "note-c"], activeTabId: "note-a" });
    const { b } = await splitAB();
    const snapshot = await typeIn(b, " typing B ", 3, 6);

    await click('[data-close-tab="note-a"]');

    expect(useNoteStore.getState().openTabIds).toEqual(["note-b", "note-c"]);
    expect(container.querySelector(".editor-workspace.split")).not.toBeNull();
    expectEditorKept(snapshot, "primary");
    expect(paneEditor("secondary").getText()).toBe("body of note-c");
  });

  it("keeps both editors and the moved editor's focus when split tabs swap panes", async () => {
    const { a, b } = await splitAB();
    const otherSnapshot = await typeIn(b, " typing B ", 2, 4);
    const snapshot = await typeIn(a, " typing A ", 3, 8);

    // Dropping the primary tab on the right swaps the two notes.
    await click('[data-split-right="note-a"]');

    expectEditorKept(snapshot, "secondary");
    expectEditorKept(otherSnapshot, "primary");
    expectFocused(snapshot);
    expectStatusCursorAt(snapshot);
    const panes = Array.from(container.querySelectorAll(".editor-workspace > *"), (element) =>
      element.getAttribute("data-pane") ?? element.className
    );
    expect(panes).toEqual(["primary", "split-divider", "secondary"]);
  });

  it("keeps both editors and focuses the focused pane's new note when its tab is chosen from the other pane", async () => {
    const { a, b } = await splitAB();
    const shown = await typeIn(b, " typing B ", 2, 6);
    const moved = await typeIn(a, " typing A ", 3, 8);

    // Choosing the other pane's tab in the focused primary pane swaps the notes.
    await click('[data-select-tab="note-b"]');

    expect(useNoteStore.getState().activeTabId).toBe("note-b");
    expectEditorKept(shown, "primary");
    expectEditorKept(moved, "secondary");
    expectFocused(shown);
    expectStatusCursorAt(shown);
  });

  it("leaves focus in a text field when the split ends", async () => {
    const { a } = await splitAB();
    const snapshot = await typeIn(a, " typing A ", 3, 8);
    const field = document.createElement("input");
    container.appendChild(field);
    await act(async () => { field.focus(); });

    await click('[data-close-tab="note-b"]');

    expectSinglePane();
    expectEditorKept(snapshot, "primary");
    expect(document.activeElement).toBe(field);
    expect(mocks.editor).toBe(a);
  });

  async function pressCloseTabShortcut(target: HTMLElement) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "w", code: "KeyW", ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
    await flushReactWork();
    await advanceTime(32);
  }

  async function clickFocusedCloseButton(tabId: string) {
    // A real click focuses the tab's close button before the tab goes away.
    const button = container.querySelector<HTMLElement>(`[data-close-tab="${tabId}"]`);
    if (!button) throw new Error(`Expected a close button for ${tabId}`);
    await act(async () => { button.focus(); });
    expect(document.activeElement).toBe(button);
    await click(`[data-close-tab="${tabId}"]`);
  }

  /** Rejects the pending save as a conflict; the authoritative reload returns the library notes `keepNote` accepts. */
  async function reloadAfterConflict(pendingSave: { reject: (reason: Error) => void }, keepNote: (noteId: string) => boolean) {
    mocks.loadAll.mockImplementation(async () => loadResult(library.notes.filter((note) => keepNote(note.noteId))));
    await act(async () => { pendingSave.reject(new Error("note_conflict: original changed on disk")); });
    await flushReactWork();
    await advanceTime(32);
    expect(mocks.loadAll).toHaveBeenCalledTimes(2);
  }

  it.each(
    (["secondary", "primary"] as const).flatMap((gonePane) =>
      (["Ctrl+W", "focused close button", "authoritative reload"] as const).map((path) => ({ gonePane, path }))
    )
  )("focuses the kept editor at its selection when the focused $gonePane note is removed by $path", async ({ gonePane, path }) => {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    if (path === "authoritative reload") {
      mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    }
    const { a, b } = await splitAB();
    const [keptEditor, goneEditor] = gonePane === "secondary" ? [a, b] : [b, a];
    const [keptId, goneId] = gonePane === "secondary" ? ["note-a", "note-b"] : ["note-b", "note-a"];
    const kept = await typeIn(keptEditor, " typing kept ", 3, 7);
    // Focusing the other pane flushes the kept note's pending save.
    await selectText(goneEditor, 5, 8);
    expect(document.activeElement).toBe(goneEditor.view.dom);
    expect(mocks.autoSave.mock.calls[0][0]).toBe(keptId);

    if (path === "Ctrl+W") {
      await pressCloseTabShortcut(goneEditor.view.dom);
    } else if (path === "focused close button") {
      await clickFocusedCloseButton(goneId);
    } else {
      // Both notes were deleted on disk; only the kept note's conflict copy exists.
      await reloadAfterConflict(pendingSave, (noteId) => noteId !== "note-a" && noteId !== "note-b");
    }

    const { openTabIds, activeTabId, notesById } = useNoteStore.getState();
    expect(openTabIds).toHaveLength(1);
    const keptTabId = openTabIds[0];
    if (path === "authoritative reload") {
      expect(keptTabId).not.toBe(keptId);
      expect(notesById[keptTabId].plainText).toContain("typing kept");
    } else {
      expect(keptTabId).toBe(keptId);
    }
    expect(activeTabId).toBe(keptTabId);
    expectSinglePane();
    expect(goneEditor.isDestroyed).toBe(true);
    expectEditorKept(kept, "primary");
    expectFocused(kept);
    expectStatusCursorAt(kept);

    // Typing continues in the kept editor without clicking it first.
    await insertText(keptEditor, "!");
    expect(useNoteStore.getState().notesById[keptTabId].plainText).toBe(keptEditor.getText());
    expect(document.activeElement).toBe(kept.dom);
  });

  it.each(["close button", "focused close button", "authoritative reload"] as const)(
    "keeps focus and the active tab on the secondary note that moves to the primary pane when the primary note is removed by %s with three tabs open",
    async (path) => {
      library.notes = ["note-a", "note-b", "note-c"].map(libraryNote);
      mocks.sessionLoad.mockResolvedValue({ openTabIds: ["note-a", "note-b", "note-c"], activeTabId: "note-a" });
      const pendingSave = deferred<ReturnType<typeof savedResult>>();
      if (path === "authoritative reload") {
        mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
      }
      const { a, b } = await splitAB();
      if (path === "authoritative reload") {
        await typeIn(a, " conflicted A ", 2, 6);
      }
      const kept = await typeIn(b, " typing B ", 3, 7);
      if (path === "authoritative reload") {
        expect(mocks.autoSave.mock.calls[0][0]).toBe("note-a");
      }

      if (path === "close button") {
        await click('[data-close-tab="note-a"]');
      } else if (path === "focused close button") {
        await clickFocusedCloseButton("note-a");
      } else {
        // note-a and its conflict copy were deleted on disk.
        await reloadAfterConflict(pendingSave, (noteId) => noteId === "note-b" || noteId === "note-c");
      }

      expect(useNoteStore.getState().openTabIds).toEqual(["note-b", "note-c"]);
      expect(useNoteStore.getState().activeTabId).toBe("note-b");
      expect(container.querySelector(".editor-workspace.split")).not.toBeNull();
      expectEditorKept(kept, "primary");
      expectFocused(kept);
      expectStatusCursorAt(kept);
      expect(kept.dom.closest<HTMLElement>(".editor-pane")?.className).toBe("editor-pane focused");
      // The note that fills the freed pane is shown without taking focus.
      const c = paneEditor("secondary");
      expect(c.getText()).toBe("body of note-c");
      expect(c.view.dom.closest<HTMLElement>(".editor-pane")?.className).toBe("editor-pane ");
      expect(c.view.hasFocus()).toBe(false);

      await insertText(b, "!");
      expect(useNoteStore.getState().notesById["note-b"].plainText).toBe(b.getText());
      expect(useNoteStore.getState().activeTabId).toBe("note-b");
      expect(document.activeElement).toBe(kept.dom);
    }
  );

  it.each(["Ctrl+W", "focused close button"] as const)(
    "still focuses the note that fills the focused pane when its own note is closed by %s with three tabs open",
    async (path) => {
      library.notes = ["note-a", "note-b", "note-c"].map(libraryNote);
      mocks.sessionLoad.mockResolvedValue({ openTabIds: ["note-a", "note-b", "note-c"], activeTabId: "note-a" });
      const { a, b } = await splitAB();
      const kept = await typeIn(a, " typing A ", 3, 7);
      await selectText(b, 5, 8);

      if (path === "Ctrl+W") {
        await pressCloseTabShortcut(b.view.dom);
      } else {
        await clickFocusedCloseButton("note-b");
      }

      // Pane assignment and focus are unchanged: note-c takes note-b's pane and focus.
      expect(useNoteStore.getState().openTabIds).toEqual(["note-a", "note-c"]);
      expect(b.isDestroyed).toBe(true);
      expectEditorKept(kept, "primary");
      const c = paneEditor("secondary");
      expect(c.getText()).toBe("body of note-c");
      expect(document.activeElement).toBe(c.view.dom);
      expect(mocks.editor).toBe(c);
      expect(useNoteStore.getState().activeTabId).toBe("note-c");
      expect(c.view.dom.closest<HTMLElement>(".editor-pane")?.className).toBe("editor-pane focused");
    }
  );

  it("does not re-render the app when storage-folder polls return the same status", async () => {
    await renderApp();
    await advanceTime(AUTO_SAVE_DIR_POLL_INTERVAL_MS);
    const pollsBefore = mocks.getAutoSaveDir.mock.calls.length;
    appCommits.mockClear();

    await advanceTime(AUTO_SAVE_DIR_POLL_INTERVAL_MS * 3);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await flushReactWork();

    expect(mocks.getAutoSaveDir.mock.calls.length).toBeGreaterThanOrEqual(pollsBefore + 4);
    expect(appCommits).not.toHaveBeenCalled();
    expect(container.querySelector(".storage-unavailable-banner")).toBeNull();

    mocks.getAutoSaveDir.mockImplementation(async () => autoSaveDirInfo("unavailable"));
    await advanceTime(AUTO_SAVE_DIR_POLL_INTERVAL_MS);

    expect(appCommits).toHaveBeenCalled();
    expect(container.querySelector(".storage-unavailable-banner")?.textContent).toContain("D:/missing");

    appCommits.mockClear();
    await advanceTime(AUTO_SAVE_DIR_POLL_INTERVAL_MS * 2);
    expect(appCommits).not.toHaveBeenCalled();
  });

  async function deactivateWindow() {
    windowState.focused = false;
    await act(async () => { window.dispatchEvent(new FocusEvent("blur")); });
  }

  async function activateWindow() {
    windowState.focused = true;
    windowState.visibility = "visible";
    await act(async () => { window.dispatchEvent(new FocusEvent("focus")); });
  }

  async function advanceOneFrame() {
    // Fake animation frames run on a 16ms grid, so 16ms always covers one.
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
  }

  /** The window focus, document focusin, press and visibilitychange listeners registered and not yet removed. */
  function trackFocusListeners() {
    const watched = new Set(["focus", "focusin", "mousedown", "pointerdown", "visibilitychange"]);
    const entries: Array<{ target: EventTarget; type: string; listener: unknown; capture: boolean }> = [];
    const isCapture = (options?: boolean | EventListenerOptions) =>
      typeof options === "boolean" ? options : Boolean(options?.capture);
    for (const target of [window, document] as EventTarget[]) {
      const add = target.addEventListener;
      const remove = target.removeEventListener;
      vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
        if (watched.has(type)) entries.push({ target, type, listener, capture: isCapture(options) });
        add.call(target, type, listener, options);
      });
      vi.spyOn(target, "removeEventListener").mockImplementation((type, listener, options) => {
        const index = entries.findIndex((entry) =>
          entry.target === target && entry.type === type && entry.listener === listener &&
          entry.capture === isCapture(options));
        if (index >= 0) entries.splice(index, 1);
        remove.call(target, type, listener, options);
      });
    }
    return () => entries.map(({ target, type }) => `${target === window ? "window" : "document"}:${type}`).sort();
  }

  const WAITING_LISTENERS = [
    "document:focusin", "document:mousedown", "document:pointerdown", "document:visibilitychange", "window:focus",
  ];

  function withWaitingListeners(listeners: string[]) {
    return [...listeners, ...WAITING_LISTENERS].sort();
  }

  /**
   * A | B with focus in B that then fell to the page (as after a popup or a
   * dialog closed). Closing A while the window is inactive stands in for a
   * background layout change; it keeps B and asks to focus it.
   */
  async function closeOtherNoteWhileInactive() {
    const listeners = trackFocusListeners();
    const { a, b } = await splitAB();
    const kept = await typeIn(b, " typing B ", 3, 6);
    await act(async () => { b.view.dom.blur(); });
    expect(document.activeElement).toBe(document.body);
    await deactivateWindow();
    const baseline = listeners();
    const keptFocus = vi.spyOn(b.view, "focus");

    await click('[data-close-tab="note-a"]');

    expect(a.isDestroyed).toBe(true);
    expectSinglePane();
    expectEditorKept(kept, "primary");
    return { b, kept, keptFocus, listeners, baseline };
  }

  it.each(["authoritative reload", "tab close"] as const)(
    "waits for an inactive window before focusing the kept editor after a %s, then focuses it once at its selection (W1, W2)",
    async (path) => {
      const pendingSave = deferred<ReturnType<typeof savedResult>>();
      if (path === "authoritative reload") {
        mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
      }
      const { a, b } = await splitAB();
      const kept = await typeIn(a, " typing kept ", 3, 7);
      // Focusing the other pane flushes the kept note's pending save.
      await selectText(b, 5, 8);
      const keptFocus = vi.spyOn(a.view, "focus");
      await deactivateWindow();

      if (path === "authoritative reload") {
        // Both notes were deleted on disk; only the kept note's conflict copy exists.
        await reloadAfterConflict(pendingSave, (noteId) => noteId !== "note-a" && noteId !== "note-b");
      } else {
        await click('[data-close-tab="note-b"]');
      }
      await advanceTime(5_000);

      expect(b.isDestroyed).toBe(true);
      expectSinglePane();
      expectEditorKept(kept, "primary");
      expect(document.activeElement).toBe(document.body);
      expect(keptFocus).not.toHaveBeenCalled();

      await activateWindow();
      expect(keptFocus).not.toHaveBeenCalled();
      await advanceOneFrame();

      expect(keptFocus).toHaveBeenCalledTimes(1);
      expectFocused(kept);
      expectEditorKept(kept, "primary");
      expectStatusCursorAt(kept);
    }
  );

  it("keeps listening only while the kept editor's focus waits for the window (W1, W2)", async () => {
    const { kept, keptFocus, listeners, baseline } = await closeOtherNoteWhileInactive();

    expect(keptFocus).not.toHaveBeenCalled();
    expect(listeners()).toEqual(withWaitingListeners(baseline));

    await activateWindow();
    await advanceOneFrame();

    expect(keptFocus).toHaveBeenCalledTimes(1);
    expectFocused(kept);
    expect(listeners()).toEqual(baseline);
  });

  it.each(["input", "button"] as const)(
    "leaves focus in a %s the user chooses while the window comes back, and does not take it later (W4)",
    async (tag) => {
      const { keptFocus } = await closeOtherNoteWhileInactive();
      const control = document.createElement(tag);
      container.appendChild(control);

      await activateWindow();
      await act(async () => {
        control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
        control.focus();
      });
      await advanceTime(64);

      expect(document.activeElement).toBe(control);
      expect(keptFocus).not.toHaveBeenCalled();

      await act(async () => { control.blur(); });
      await deactivateWindow();
      await activateWindow();
      await advanceTime(64);
      expect(document.activeElement).toBe(document.body);
      expect(keptFocus).not.toHaveBeenCalled();
    }
  );

  /** A pointer press that focuses nothing by itself; the pressed element's own handlers decide. */
  async function pointerPress(target: Element) {
    await act(async () => {
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    });
    await flushReactWork();
  }

  it("drops the waiting focus when a toolbar button is pressed while the window comes back, before the button has focus (R1)", async () => {
    const { keptFocus, listeners, baseline } = await closeOtherNoteWhileInactive();

    await activateWindow();
    await pointerPress(container.querySelector('button[aria-label="Bold"]')!);

    expect(listeners()).toEqual(baseline);
    await advanceTime(64);
    expect(keptFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);

    await deactivateWindow();
    await activateWindow();
    await advanceTime(64);
    expect(keptFocus).not.toHaveBeenCalled();
  });

  it("focuses the other pane's editor whose empty area is pressed while the window comes back, never the waiting one (R1)", async () => {
    const { a, b } = await splitAB();
    await typeIn(b, " typing B ", 2, 4);
    const kept = await typeIn(a, " typing A ", 3, 8);
    await act(async () => { a.view.dom.blur(); });
    await deactivateWindow();
    const aFocus = vi.spyOn(a.view, "focus");
    act(() => restoreEditorFocus(a));
    await advanceTime(64);
    expect(aFocus).not.toHaveBeenCalled();

    await activateWindow();
    await pointerPress(b.view.dom.closest(".editor-shell")!);
    await advanceTime(64);

    expect(aFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(b.view.dom);
    expect(mocks.editor).toBe(b);
    expectEditorKept(kept, "primary");
  });

  it.each([
    { name: "settings open", leave: () => click(".toolbar-right button:last-child") },
    { name: "the calendar replaces the notes", leave: () => click('[data-view="calendar"]') },
  ])("drops the waiting focus and its listeners when $name (W5)", async ({ leave }) => {
    const { keptFocus, listeners, baseline } = await closeOtherNoteWhileInactive();
    expect(listeners()).toEqual(withWaitingListeners(baseline));

    await leave();

    expect(listeners()).toEqual(baseline);
    await activateWindow();
    await advanceTime(64);
    expect(keptFocus).not.toHaveBeenCalled();
  });

  it("drops the waiting focus and its listeners when the app unmounts (W5)", async () => {
    const { keptFocus, listeners } = await closeOtherNoteWhileInactive();

    await act(async () => { root.render(<div />); });
    await advanceTime(64);

    expect(listeners()).toEqual([]);
    await activateWindow();
    await advanceTime(64);
    expect(keptFocus).not.toHaveBeenCalled();
  });

  it("focuses only the newest focused editor when the layout changes again while the window is inactive (W5)", async () => {
    library.notes = ["note-a", "note-b", "note-c"].map(libraryNote);
    mocks.sessionLoad.mockResolvedValue({ openTabIds: ["note-a", "note-b", "note-c"], activeTabId: "note-a" });
    const { a, b } = await splitAB();
    await typeIn(b, " typing B ", 3, 6);
    await act(async () => { b.view.dom.blur(); });
    await deactivateWindow();
    // note-b moves to the primary pane and keeps focus; note-c opens beside it.
    await click('[data-close-tab="note-a"]');
    expect(a.isDestroyed).toBe(true);
    const c = paneEditor("secondary");
    const bFocus = vi.spyOn(b.view, "focus");
    const cFocus = vi.spyOn(c.view, "focus");

    // Choosing note-c in the focused pane swaps the two notes.
    await click('[data-select-tab="note-c"]');
    expect(paneEditor("primary") === c, "note-c in the primary pane").toBe(true);
    expect(paneEditor("secondary") === b, "note-b in the secondary pane").toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect(cFocus).not.toHaveBeenCalled();
    await activateWindow();
    await advanceOneFrame();

    expect(bFocus).not.toHaveBeenCalled();
    expect(cFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(c.view.dom);
  });

  it("lets a later layout change replace a waiting popup restore, and the reverse (W6)", async () => {
    const { a, b } = await splitAB();
    await typeIn(b, " typing B ", 2, 4);
    await typeIn(a, " typing A ", 3, 8);
    await act(async () => { a.view.dom.blur(); });
    await deactivateWindow();
    const aFocus = vi.spyOn(a.view, "focus");
    const bFocus = vi.spyOn(b.view, "focus");

    // A popup of note-b closes, then dropping note-a on the right swaps the notes.
    act(() => restoreEditorFocus(b));
    await click('[data-split-right="note-a"]');
    expect(a.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe("secondary");
    expect(aFocus).not.toHaveBeenCalled();
    await activateWindow();
    await advanceOneFrame();

    expect(aFocus).toHaveBeenCalledTimes(1);
    expect(bFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(a.view.dom);

    // Now the layout change comes first and the popup restore after it.
    await act(async () => { a.view.dom.blur(); });
    await deactivateWindow();
    aFocus.mockClear();
    await click('[data-split-left="note-a"]');
    expect(a.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe("primary");
    act(() => restoreEditorFocus(b));
    await advanceTime(64);
    expect(aFocus).not.toHaveBeenCalled();
    expect(bFocus).not.toHaveBeenCalled();
    await activateWindow();
    await advanceOneFrame();

    expect(bFocus).toHaveBeenCalledTimes(1);
    expect(aFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(b.view.dom);
  });

  it("leaves the kept editor alone when it already has focus and is composing as the window returns (W8)", async () => {
    const { b, keptFocus } = await closeOtherNoteWhileInactive();

    await activateWindow();
    // The user clicks back into the editor and starts composing before the next frame.
    await act(async () => { b.view.dom.focus(); });
    await act(async () => { b.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    expect(b.view.composing).toBe(true);
    const transactions = vi.fn();
    b.on("transaction", transactions);
    keptFocus.mockClear();
    await advanceTime(64);

    expect(document.activeElement).toBe(b.view.dom);
    expect(b.view.composing).toBe(true);
    expect(keptFocus).not.toHaveBeenCalled();
    expect(transactions).not.toHaveBeenCalled();
  });

  // ---- Selection after a pane move (policy §5) ----

  const TABLE = "<table><tbody><tr><td><p>alpha</p></td><td><p>beta gamma</p></td></tr></tbody></table>";
  // Positions in TABLE: "alpha" starts at 4, "beta gamma" at 13.

  /** Replaces the document, applies `select`, and focuses the editor root. */
  async function focusWithSelection(editor: Editor, html: string, select: (state: EditorState) => Selection) {
    await act(async () => { editor.commands.setContent(html); });
    // React restores a moved element's selection by character offsets only
    // when its contentEditable property is "true"; jsdom reflects only the
    // attribute. A browser takes this path.
    for (const element of container.querySelectorAll<HTMLElement>('[contenteditable="true"]')) {
      element.contentEditable = "true";
    }
    await act(async () => {
      editor.view.dispatch(editor.state.tr.setSelection(select(editor.state)));
      editor.view.focus();
    });
    await advanceTime(64);
    expect(document.activeElement).toBe(editor.view.dom);
  }

  function domSelection(editor: Editor) {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) throw new Error("Expected a DOM selection");
    return {
      anchor: editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset),
      head: editor.view.posAtDOM(selection.focusNode, selection.focusOffset),
    };
  }

  /** Drops a tab on a pane without the rendering pauses of click(), so the commit can be inspected. */
  async function dropTab(selector: string) {
    const button = container.querySelector<HTMLElement>(selector);
    if (!button) throw new Error(`Expected ${selector}`);
    await act(async () => { button.click(); });
  }

  /** Lets ProseMirror read the DOM selection, as the browser's selectionchange makes it do. */
  async function settleSelection() {
    await act(async () => { document.dispatchEvent(new Event("selectionchange")); });
    await advanceTime(64);
  }

  function textPosition(doc: EditorState["doc"], text: string) {
    let found = -1;
    doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.isText && node.text?.includes(text)) found = pos + node.text.indexOf(text);
      return found < 0;
    });
    if (found < 0) throw new Error(`Expected "${text}" in the document`);
    return found;
  }

  it("keeps the caret in a table cell when the focused editor moves to the other pane (S1)", async () => {
    const { a } = await splitAB();
    await focusWithSelection(a, TABLE, (state) => TextSelection.create(state.doc, 13));

    await dropTab('[data-split-right="note-a"]');

    expect(a.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe("secondary");
    expect(a.state.selection.toJSON()).toEqual({ type: "text", anchor: 13, head: 13 });
    expect(domSelection(a)).toEqual({ anchor: 13, head: 13 });

    await settleSelection();

    expect(document.activeElement).toBe(a.view.dom);
    expect(a.state.selection.toJSON()).toEqual({ type: "text", anchor: 13, head: 13 });
    expect(domSelection(a)).toEqual({ anchor: 13, head: 13 });
  });

  it.each(
    ([{ name: "forward", anchor: 13, head: 17 }, { name: "backward", anchor: 17, head: 13 }] as const).flatMap((range) =>
      (["primary to secondary", "secondary to primary"] as const).map((move) => ({ ...range, move })))
  )("keeps a $name table text selection when the editor moves from $move (S2)", async ({ anchor, head, move }) => {
    const { a, b } = await splitAB();
    const [editor, drop, pane] = move === "primary to secondary"
      ? [a, '[data-split-right="note-a"]', "secondary"]
      : [b, '[data-split-left="note-b"]', "primary"];
    await focusWithSelection(editor, TABLE, (state) => TextSelection.create(state.doc, anchor, head));

    await dropTab(drop);
    await settleSelection();

    expect(editor.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe(pane);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.toJSON()).toEqual({ type: "text", anchor, head });
    expect(domSelection(editor)).toEqual({ anchor, head });
  });

  it.each([
    {
      name: "a cell selection across both cells",
      html: TABLE,
      select: (state: EditorState) => CellSelection.create(state.doc, 2, 11),
      type: CellSelection,
      marked: ".selectedCell",
      count: 2,
    },
    {
      name: "a horizontal rule node selection",
      html: "<hr><p>alpha</p>",
      select: (state: EditorState) => NodeSelection.create(state.doc, 0),
      type: NodeSelection,
      marked: ".ProseMirror-selectednode",
      count: 1,
    },
  ])("keeps $name when the editor moves to the other pane (S3)", async ({ html, select, type, marked, count }) => {
    const { a } = await splitAB();
    await focusWithSelection(a, html, select);
    const before = a.state.selection.toJSON();
    expect(a.state.selection).toBeInstanceOf(type);

    await dropTab('[data-split-right="note-a"]');
    await settleSelection();

    expect(document.activeElement).toBe(a.view.dom);
    expect(a.state.selection).toBeInstanceOf(type);
    expect(a.state.selection.toJSON()).toEqual(before);
    expect(a.view.dom.querySelectorAll(marked)).toHaveLength(count);
  });

  it("types into the table cell it kept after the move, and undo restores it (S4)", async () => {
    const { a } = await splitAB();
    await focusWithSelection(a, TABLE, (state) => TextSelection.create(state.doc, 13));
    const before = a.getJSON();

    await dropTab('[data-split-right="note-a"]');
    await settleSelection();
    // Start a new undo step instead of joining the content set above.
    await advanceTime(1_000);
    await insertText(a, "X");

    expect(a.state.doc.textBetween(0, a.state.doc.content.size, "|")).toBe("alpha|Xbeta gamma");
    await act(async () => { expect(a.commands.undo()).toBe(true); });
    expect(a.getJSON()).toEqual(before);
    expect(a.state.selection.from).toBe(13);
  });

  it.each([
    { name: "the second paragraph", html: "<p>first</p><p>second line</p>", text: "line" },
    {
      name: "a task item",
      html: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>todo item</p></li></ul>',
      text: "item",
    },
    {
      name: "a toggle's content",
      html: '<details data-type="toggleBlock" open><summary>title</summary><div data-type="toggleContent"><p>inside text</p></div></details>',
      text: "text",
    },
  ])("keeps the caret in $name when the editor moves to the other pane (S4)", async ({ html, text }) => {
    const { a } = await splitAB();
    await focusWithSelection(a, html, (state) => TextSelection.create(state.doc, textPosition(state.doc, text)));
    const position = a.state.selection.from;

    await dropTab('[data-split-right="note-a"]');
    await settleSelection();

    expect(document.activeElement).toBe(a.view.dom);
    expect(a.state.selection.toJSON()).toEqual({ type: "text", anchor: position, head: position });
    expect(domSelection(a)).toEqual({ anchor: position, head: position });
  });

  it("does not focus again for a render that keeps the layout (S5)", async () => {
    const { a } = await splitAB();
    await typeIn(a, " typing A ", 3, 6);
    const viewFocus = vi.spyOn(a.view, "focus");

    await insertText(a, "!");
    await advanceTime(AUTO_SAVE_DELAY_MS);

    expect(viewFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(a.view.dom);
  });

  it("does not refocus an editor that takes focus in its own pane (S5)", async () => {
    const { a, b } = await splitAB();
    await typeIn(a, " typing A ", 3, 6);
    await act(async () => { b.commands.setTextSelection(4); });
    const viewFocus = vi.spyOn(b.view, "focus");

    // A click into note-b focuses it natively; App then marks its pane focused.
    await act(async () => { b.view.dom.focus(); });
    await flushReactWork();
    await advanceTime(32);

    expect(b.view.dom.closest<HTMLElement>(".editor-pane")?.className).toBe("editor-pane focused");
    expect(document.activeElement).toBe(b.view.dom);
    expect(viewFocus).not.toHaveBeenCalled();
  });

  it("refocuses a relabelled pane once without native focus, blur or an equal selection write (S5)", async () => {
    const { b } = await splitAB();
    await selectText(b, 3, 7);
    const before = b.state.selection.toJSON();
    const selection = window.getSelection()!;
    const writes = (["collapse", "extend", "addRange", "removeAllRanges", "setBaseAndExtent"] as const)
      .map((method) => vi.spyOn(selection, method));
    const nativeFocus = vi.fn();
    const blur = vi.fn();
    b.view.dom.addEventListener("focus", nativeFocus);
    b.view.dom.addEventListener("blur", blur);
    const viewFocus = vi.spyOn(b.view, "focus");

    // [A, divider, B] becomes [B]: B is relabelled primary without moving.
    await click('[data-close-tab="note-a"]');

    expect(b.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe("primary");
    expect(b.state.selection.toJSON()).toEqual(before);
    expect(document.activeElement).toBe(b.view.dom);
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(nativeFocus).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
    writes.forEach((write) => expect(write).not.toHaveBeenCalled());
  });

  it.each([
    {
      name: "a checkbox inside the editor has focus",
      html: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>todo</p></li></ul>',
      prepare: async (editor: Editor) => {
        const checkbox = editor.view.dom.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (!checkbox) throw new Error("Expected a task checkbox");
        await act(async () => { checkbox.focus(); });
        return checkbox;
      },
    },
    {
      name: "a text field outside the editors has focus",
      html: TABLE,
      prepare: async () => {
        const field = document.createElement("input");
        container.appendChild(field);
        await act(async () => { field.focus(); });
        return field;
      },
    },
    {
      name: "the editor is composing",
      html: TABLE,
      prepare: async (editor: Editor) => {
        await act(async () => {
          editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        });
        expect(editor.view.composing).toBe(true);
        return editor.view.dom;
      },
    },
    {
      name: "the window is inactive",
      html: TABLE,
      prepare: async (editor: Editor) => {
        await deactivateWindow();
        return editor.view.dom;
      },
    },
  ])("does not refocus a moved editor when $name (S6, I2)", async ({ html, prepare }) => {
    const { a } = await splitAB();
    await focusWithSelection(a, html, (state) => TextSelection.create(state.doc, 4));
    const focused = await prepare(a);
    const viewFocus = vi.spyOn(a.view, "focus");
    const blur = vi.spyOn(a.view.dom, "blur");
    const composing = a.view.composing;

    await dropTab('[data-split-right="note-a"]');
    await advanceTime(64);

    expect(a.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe("secondary");
    expect(viewFocus).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focused);
    expect(a.view.composing).toBe(composing);
  });

  // ---- Display while panes normalize ----

  /** Names the toolbar editors rendered so far; failure output stays small. */
  function toolbarHistory(named: Record<string, Editor>) {
    return mocks.editorHistory.map((editor) =>
      editor === null ? "none" : (Object.keys(named).find((name) => named[name] === editor) ?? "other"));
  }

  /** Replaces the store's setActiveTab with a spy for this test. */
  function spyOnSetActiveTab() {
    const original = useNoteStore.getState().setActiveTab;
    const spy = vi.fn(original);
    useNoteStore.setState({ setActiveTab: spy });
    onTestFinished(() => useNoteStore.setState({ setActiveTab: original }));
    return spy;
  }

  /**
   * Records every transaction of `editor` that changes its document, and the
   * renders without a focused tab: the commit before pane normalization.
   */
  function watchCommitWithoutFocusedTab(editor: Editor) {
    const docChanges = vi.fn();
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) docChanges();
    });
    mocks.renders.length = 0;
    mocks.pressBoldWithoutFocusedTab = true;
    return {
      docChanges,
      renders: () => mocks.renders.filter((render) => render.toolbarTabId === ""),
    };
  }

  it("shows the remaining editor's cursor while the focused pane's note closes, gives the toolbar no editor to command, and never activates the closed tab (D1)", async () => {
    const setActiveTab = spyOnSetActiveTab();
    const { a, b } = await splitAB();
    const kept = await typeIn(a, " typing A ", 3, 7);
    const aCursor = mocks.status;
    await selectText(b, 5, 8);
    const keptFocus = vi.spyOn(a.view, "focus");
    const before = a.getJSON();
    mocks.editorHistory.length = 0;
    mocks.statusHistory.length = 0;
    setActiveTab.mockClear();
    const transient = watchCommitWithoutFocusedTab(a);

    await click('[data-close-tab="note-b"]');

    // The commit without a focused editor: the status bar shows the cursor of
    // the editor that stayed, while the toolbar gets no editor at all.
    expect(transient.renders().length).toBeGreaterThan(0);
    for (const render of transient.renders()) {
      expect(render.toolbarEditor).toBeNull();
      expect(render.status).toEqual(aCursor);
    }
    expect(mocks.statusHistory).not.toContainEqual({ line: 1, column: 1, chars: 0 });
    // Bold pressed in that commit commands nothing.
    expect(mocks.boldPressesWithoutFocusedTab).toBe(1);
    expect(transient.docChanges).not.toHaveBeenCalled();
    expect(a.getJSON()).toEqual(before);
    expect(setActiveTab.mock.calls.map(([id]) => id)).not.toContain("note-b");
    // Only the normalized focus, after that commit.
    expect(keptFocus).toHaveBeenCalledTimes(1);
    const history = toolbarHistory({ a, b });
    expect(history[history.length - 1]).toBe("a");
    expectFocused(kept);
    expect(useNoteStore.getState().activeTabId).toBe("note-a");
  });

  it("shows the remaining editor's cursor without focusing or commanding it while the focused pane fills with another note (D1)", async () => {
    library.notes = ["note-a", "note-b", "note-c"].map(libraryNote);
    mocks.sessionLoad.mockResolvedValue({ openTabIds: ["note-a", "note-b", "note-c"], activeTabId: "note-a" });
    const setActiveTab = spyOnSetActiveTab();
    const { a, b } = await splitAB();
    await typeIn(a, " typing A ", 3, 7);
    const aCursor = mocks.status;
    await selectText(b, 5, 8);
    const aFocus = vi.spyOn(a.view, "focus");
    const before = a.getJSON();
    mocks.editorHistory.length = 0;
    setActiveTab.mockClear();
    const transient = watchCommitWithoutFocusedTab(a);

    await click('[data-close-tab="note-b"]');

    const c = paneEditor("secondary");
    // The first commit has no focused editor yet: the status bar shows the
    // cursor of the editor that stayed; the toolbar has no editor until note-c.
    expect(transient.renders().length).toBeGreaterThan(0);
    for (const render of transient.renders()) {
      expect(render.toolbarEditor).toBeNull();
      expect(render.status).toEqual(aCursor);
    }
    const history = toolbarHistory({ a, b, c });
    expect(history).not.toContain("a");
    expect(history[history.length - 1]).toBe("c");
    expect(mocks.boldPressesWithoutFocusedTab).toBe(1);
    expect(transient.docChanges).not.toHaveBeenCalled();
    expect(a.getJSON()).toEqual(before);
    expect(aFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(c.view.dom);
    expect(setActiveTab.mock.calls.map(([id]) => id)).not.toContain("note-b");
    expect(useNoteStore.getState().activeTabId).toBe("note-c");
  });
});
