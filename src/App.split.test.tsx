// @vitest-environment jsdom

import type { Editor } from "@tiptap/react";
import { Profiler, StrictMode, act, type ProfilerOnRenderCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
    return null;
  },
}));
vi.mock("./components/TitleBar", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ tabs, onSelectTab, onDropTabOutside, onCloseTab, onUnsplit }: {
      tabs: Array<{ id: string }>;
      onSelectTab: (id: string) => void;
      onDropTabOutside: (id: string, clientX: number, clientY: number) => void;
      onCloseTab: (id: string) => void;
      onUnsplit: (id: string) => void;
    }) => createElement("nav", null, ...tabs.flatMap(({ id }) => [
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
});
