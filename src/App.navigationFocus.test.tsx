// @vitest-environment jsdom

// Policy §1 (focus after a split-layout change, one-shot navigation intent)
// with the real title bar, sidebar and toolbar, so focus starts on the real
// controls a user presses. A press is modelled as pointerdown, mousedown, the
// focus a browser gives the nearest focusable element, pointerup and click;
// element.click() alone never moves focus.

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
  getAutoSaveDir: vi.fn(),
  sessionLoad: vi.fn(),
  recoverCalendarDataFromCloud: vi.fn(),
}));

vi.mock("./lib/tauriApi", () => ({
  hwanNote: {
    window: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), exit: vi.fn(), startDragging: vi.fn() },
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
// Settings stand in as a modal dialog with a field and a close button.
vi.mock("./components/SettingsPanel", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ open, onClose }: { open: boolean; onClose: () => void }) => open
      ? createElement("div", { role: "dialog", "aria-modal": "true", "data-settings": "" },
        createElement("input", { "data-settings-field": "" }),
        createElement("button", { type: "button", "data-settings-close": "", onClick: onClose }, "close"))
      : null,
  };
});
vi.mock("./components/UpdateToast", () => ({ default: () => null }));
vi.mock("./components/StatusBar", () => ({ default: () => null }));
// The calendar only offers a link back to note-b.
vi.mock("./components/calendar/CalendarPage", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ onNavigateToNote }: { onNavigateToNote: (id: string) => void }) =>
      createElement("button", { type: "button", "data-calendar-note": "note-b", onClick: () => onNavigateToNote("note-b") }, "note-b"),
  };
});

import App from "./App";
import { restoreEditorFocus } from "./components/Editor";
import { I18nProvider } from "./i18n/context";
import { isEditorFocusPending } from "./lib/editorFocusRestore";
import { useNoteStore } from "./stores/noteStore";

const windowState = { focused: true, visibility: "visible" as DocumentVisibilityState };

const AUTO_SAVE_DELAY_MS = 1_750;

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
  return { editor, dom: editor.view.dom, from: editor.state.selection.from, to: editor.state.selection.to, text: editor.getText() };
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

function expectFocusedAtSelection(snapshot: EditorSnapshot) {
  expect(document.activeElement).toBe(snapshot.dom);
  const selection = window.getSelection();
  expect(selection?.anchorNode && snapshot.dom.contains(selection.anchorNode)).toBe(true);
  expect(snapshot.editor.state.selection.from).toBe(snapshot.from);
  expect(snapshot.editor.state.selection.to).toBe(snapshot.to);
}

function describeFocus() {
  const active = document.activeElement;
  if (!active || active === document.body) return "page";
  const tab = active.closest("[data-tab-id]")?.getAttribute("data-tab-id");
  if (active.matches(".note-editor")) return `editor in ${active.closest("[data-pane]")?.getAttribute("data-pane")}`;
  return tab ? `tab ${tab}` : active.outerHTML.slice(0, 60);
}

describe("App focus after split-layout changes follows only navigation the user asked for (policy §1)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let library: { notes: LibraryNote[] };

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.localStorage.setItem("hwan-note:language", "en");
    document.body.inert = false;
    windowState.focused = true;
    windowState.visibility = "visible";
    vi.spyOn(document, "hasFocus").mockImplementation(() => windowState.focused);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => windowState.visibility);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    useNoteStore.setState({
      notesById: {}, noteIds: [], openTabIds: [], activeTabId: null,
      allNotes: [], openTabs: [], activeOpenTab: null, sidebarVisible: true,
    });
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
    mocks.getAutoSaveDir.mockReset().mockResolvedValue({
      customDir: null, effectiveDir: "C:/notes", isDefault: true, status: "unset", expectedDir: "C:/notes", error: null,
    });
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
    Reflect.deleteProperty(document, "elementFromPoint");
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function openNotes(ids: string[], activeTabId = ids[0]) {
    library.notes = ids.map(libraryNote);
    mocks.sessionLoad.mockResolvedValue({ openTabIds: ids, activeTabId });
  }

  async function renderApp() {
    await act(async () => {
      root.render(<StrictMode><I18nProvider><App /></I18nProvider></StrictMode>);
    });
    await flushReactWork();
    await advanceTime(32);
    const workspace = container.querySelector<HTMLElement>(".editor-workspace");
    if (!workspace) throw new Error("Expected the editor workspace");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1_000, 600));
  }

  function paneEditor(pane: "primary" | "secondary") {
    const dom = container.querySelector<HTMLElement & { editor?: Editor }>(`[data-pane="${pane}"] .note-editor`);
    const editor = dom?.editor;
    if (!editor || editor.isDestroyed) throw new Error(`Expected a mounted editor in the ${pane} pane`);
    return editor;
  }

  function tabButton(tabId: string) {
    const button = container.querySelector<HTMLButtonElement>(`.titlebar .tabs button.tab[data-tab-id="${tabId}"]`);
    if (!button) throw new Error(`Expected the tab button of ${tabId}`);
    return button;
  }

  function sidebarNote(tabId: string) {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".note-list-item"))
      .find((item) => item.querySelector(".note-item-title")?.textContent === tabId);
    if (!button) throw new Error(`Expected the sidebar item of ${tabId}`);
    return button;
  }

  const FOCUSABLE = "button:not(:disabled), [tabindex], a[href], input, select, textarea";

  /** A left-button press and click; the browser focuses the nearest focusable element on mousedown. */
  async function press(element: Element, { button = 0 }: { button?: number } = {}) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button, clientX: 20, clientY: 10 }));
      const proceed = element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button }));
      if (proceed) element.closest<HTMLElement>(FOCUSABLE)?.focus();
      element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button, clientX: 20, clientY: 10 }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button }));
      if (button === 0) element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button }));
    });
    await flushReactWork();
    await advanceTime(32);
  }

  /** Right-clicks a tab and presses the context menu item `label`. */
  async function pressTabMenuItem(tabId: string, label: "Close" | "Close others" | "Unsplit") {
    const tab = tabButton(tabId);
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }));
      tab.focus();
      tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 20 }));
    });
    await flushReactWork();
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>(".context-menu button"))
      .find((button) => button.textContent === label);
    if (!item) throw new Error(`Expected the "${label}" menu item`);
    await press(item);
  }

  /** Drags a tab by pointer and drops it at (clientX, clientY). */
  async function dragTab(tabId: string, clientX: number, clientY = 200) {
    const tab = tabButton(tabId);
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 10 }));
      if (tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))) tab.focus();
    });
    await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 60, clientY: 40 })); });
    await act(async () => { window.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY })); });
    await act(async () => { window.dispatchEvent(new MouseEvent("pointerup", { button: 0, clientX, clientY })); });
    // The click after a drag is swallowed by the title bar.
    await act(async () => { tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    await flushReactWork();
    await advanceTime(32);
  }

  async function pressKey(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ctrlKey: true, ...init }));
    });
    await flushReactWork();
    await advanceTime(32);
  }

  async function focusOn(element: HTMLElement) {
    await act(async () => { element.focus(); });
    expect(document.activeElement).toBe(element);
  }

  function append<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, parent: Element = container) {
    const element = document.createElement(tag);
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    parent.appendChild(element);
    return element;
  }

  /** Opens the second tab beside the first by dragging it onto the right half (A | B). */
  async function splitAB() {
    await renderApp();
    await dragTab("note-b", 750);
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

  /**
   * A | B with typing in A, whose autosave is still in flight. Returns
   * `collapse`: the save fails as a conflict and the authoritative reload
   * finds note-b deleted on disk. A's draft stays in the same editor in the
   * primary pane, the focused one. By default note-a is gone from disk too and
   * the split ends (focus was in B meanwhile); with `diskKeepsNoteA` the disk
   * version of note-a (and its tab) fills the freed pane. No user navigation.
   */
  async function prepareBackgroundCollapse({ diskKeepsNoteA = false } = {}) {
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { a, b } = await splitAB();
    const kept = await typeIn(a, " typing A ", 3, 7);
    if (diskKeepsNoteA) {
      await advanceTime(AUTO_SAVE_DELAY_MS);
    } else {
      // Focusing the other pane flushes A's autosave.
      await selectText(b, 5, 8);
    }
    expect(mocks.autoSave.mock.calls[0][0]).toBe("note-a");
    const keptFocus = vi.spyOn(a.view, "focus");
    const collapse = async () => {
      mocks.loadAll.mockImplementation(async () => loadResult(library.notes.filter((note) =>
        note.noteId !== "note-b" && (diskKeepsNoteA || note.noteId !== "note-a"))));
      await act(async () => { pendingSave.reject(new Error("note_conflict: original changed on disk")); });
      await flushReactWork();
      await advanceTime(32);
      expect(mocks.loadAll).toHaveBeenCalledTimes(2);
      expect(b.isDestroyed).toBe(true);
      expect(a.isDestroyed).toBe(false);
      expect(a.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe("primary");
      if (diskKeepsNoteA) {
        expect(paneEditor("secondary").getText()).toBe("body of note-a");
      } else {
        expect(container.querySelector(".editor-workspace.split")).toBeNull();
      }
    };
    return { a, b, kept, keptFocus, collapse };
  }

  /** Stands in for a background reload that drops `tabId` (deleted on disk): the store closes it, no navigation. */
  async function removeInBackground(tabId: string) {
    await act(async () => { useNoteStore.getState().closeTab(tabId); });
    await flushReactWork();
    await advanceTime(32);
  }

  /** The document capture listeners for focusin, pointerdown and mousedown registered and not yet removed. */
  function trackDocumentWatchers() {
    const watched = new Set(["focusin", "pointerdown", "mousedown"]);
    const entries: Array<{ type: string; listener: unknown }> = [];
    const isCapture = (options?: boolean | EventListenerOptions) =>
      typeof options === "boolean" ? options : Boolean(options?.capture);
    const add = document.addEventListener;
    const remove = document.removeEventListener;
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      if (watched.has(type) && isCapture(options)) entries.push({ type, listener });
      add.call(document, type, listener, options);
    });
    vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
      const index = entries.findIndex((entry) => entry.type === type && entry.listener === listener);
      if (index >= 0 && isCapture(options)) entries.splice(index, 1);
      remove.call(document, type, listener, options);
    });
    return () => entries.map(({ type }) => type).sort();
  }

  const INTENT_WATCHERS = ["focusin", "mousedown", "pointerdown"];

  // ---- L1, L2, L4, L9: a background layout change takes focus from no control ----

  it.each([
    { name: "a tree item", control: () => append("div", { role: "treeitem", tabindex: "0" }, append("div", { role: "tree" })) },
    { name: "a toolbar button", control: () => container.querySelector<HTMLElement>('button[aria-label="Bold"]')! },
    { name: "a menu item", control: () => append("div", { role: "menuitem", tabindex: "-1" }, append("div", { role: "menu" })) },
    { name: "a title bar button", control: () => container.querySelector<HTMLElement>(".titlebar-menu-btn")! },
    { name: "a tab that only has focus (L4)", control: () => tabButton("note-a"), diskKeepsNoteA: true },
  ])("leaves focus on $name when a background reload changes the split (L1, L4)", async ({ control, diskKeepsNoteA }) => {
    const { a, keptFocus, collapse } = await prepareBackgroundCollapse({ diskKeepsNoteA });
    const target = control();
    // A stored mark the next typing in A would use.
    await act(async () => { a.commands.setTextSelection(5); a.commands.setMark("bold"); });
    expect(a.state.storedMarks?.map((mark) => mark.type.name)).toEqual(["bold"]);
    const before = snapshotEditor(a);
    await focusOn(target);

    await collapse();

    expect(document.activeElement, describeFocus()).toBe(target);
    expect(keptFocus).not.toHaveBeenCalled();
    expectEditorKept(before, "primary");
    expect(a.state.storedMarks?.map((mark) => mark.type.name)).toEqual(["bold"]);
  });

  it.each([
    { name: "role=dialog", dialog: () => append("div", { role: "dialog" }) },
    { name: "role=alertdialog", dialog: () => append("div", { role: "alertdialog" }) },
    { name: "aria-modal=true", dialog: () => append("div", { "aria-modal": "true" }) },
    { name: "an open dialog element", dialog: () => append("dialog", { open: "" }) },
  ])("leaves focus on a button in $name when a background reload collapses the split (L2)", async ({ dialog }) => {
    const { kept, keptFocus, collapse } = await prepareBackgroundCollapse();
    const button = append("button", { type: "button" }, dialog());
    await focusOn(button);

    await collapse();

    expect(document.activeElement).toBe(button);
    expect(keptFocus).not.toHaveBeenCalled();
    expectEditorKept(kept, "primary");
  });

  it("switches the tab for Ctrl+Tab pressed in a dialog but leaves focus in the dialog, though the navigation started there (L2)", async () => {
    const { a, b } = await splitAB();
    const moved = await typeIn(b, " typing B ", 2, 5);
    await typeIn(a, " typing A ", 3, 7);
    const button = append("button", { type: "button" }, append("div", { role: "dialog" }));
    await focusOn(button);
    const bFocus = vi.spyOn(b.view, "focus");

    await pressKey(button, "Tab");

    // Ctrl+Tab still ran: note-b swapped into the focused primary pane.
    expect(paneEditor("primary")).toBe(b);
    expect(useNoteStore.getState().activeTabId).toBe("note-b");
    expect(document.activeElement).toBe(button);
    expect(bFocus).not.toHaveBeenCalled();
    expectEditorKept(moved, "primary");
  });

  it.each([
    { name: "the sidebar search field", control: () => container.querySelector<HTMLElement>('.sidebar input[type="text"]')! },
    { name: "a textarea", control: () => append("textarea") },
    { name: "the toolbar list select", control: () => container.querySelector<HTMLElement>(".toolbar select")! },
    { name: "a contenteditable outside the editors", control: () => append("div", { contenteditable: "true", tabindex: "0" }) },
  ])("leaves focus in $name when a background reload collapses the split (L9)", async ({ control }) => {
    const { kept, keptFocus, collapse } = await prepareBackgroundCollapse();
    const field = control();
    await focusOn(field);

    await collapse();

    expect(document.activeElement).toBe(field);
    expect(keptFocus).not.toHaveBeenCalled();
    expectEditorKept(kept, "primary");
  });

  it("runs Ctrl+Tab from the sidebar search field and leaves focus in the field (L9)", async () => {
    const { a, b } = await splitAB();
    const moved = await typeIn(b, " typing B ", 2, 5);
    await typeIn(a, " typing A ", 3, 7);
    const field = container.querySelector<HTMLInputElement>('.sidebar input[type="text"]')!;
    await focusOn(field);
    const bFocus = vi.spyOn(b.view, "focus");

    await pressKey(field, "Tab");

    expect(paneEditor("primary")).toBe(b);
    expect(document.activeElement).toBe(field);
    expect(bFocus).not.toHaveBeenCalled();
    expectEditorKept(moved, "primary");
  });

  // ---- L5, L6: the user's own navigation still continues into the editor ----

  it.each([
    { from: "primary", choose: "note-b" },
    { from: "secondary", choose: "note-a" },
  ] as const)("focuses the kept editor at its selection when its tab is pressed from the $from pane (L5)", async ({ from, choose }) => {
    const { a, b } = await splitAB();
    const [focusedEditor, chosenEditor] = from === "primary" ? [a, b] : [b, a];
    const chosen = await typeIn(chosenEditor, " chosen ", 2, 5);
    const other = await typeIn(focusedEditor, " typing ", 3, 7);

    await press(tabButton(choose));

    expect(useNoteStore.getState().activeTabId).toBe(choose);
    expectEditorKept(chosen, from);
    expectEditorKept(other, from === "primary" ? "secondary" : "primary");
    expectFocusedAtSelection(chosen);
  });

  it.each([
    { drag: "note-a", x: 750, typed: "primary", lands: "secondary" },
    { drag: "note-b", x: 250, typed: "secondary", lands: "primary" },
  ] as const)("focuses the kept editor at its selection when $drag is dragged to the other side (L5)", async ({ drag, x, typed, lands }) => {
    const { a, b } = await splitAB();
    const [typedEditor, otherEditor] = typed === "primary" ? [a, b] : [b, a];
    const other = await typeIn(otherEditor, " other ", 2, 4);
    const moved = await typeIn(typedEditor, " dragged ", 3, 7);

    await dragTab(drag, x);

    expectEditorKept(moved, lands);
    expectEditorKept(other, lands === "primary" ? "secondary" : "primary");
    expectFocusedAtSelection(moved);
  });

  it.each([
    { target: "note-a", focusIn: "secondary" },
    { target: "note-b", focusIn: "primary" },
  ] as const)("focuses the kept editor at its selection when the split ends from the tab menu, to $target (L5)", async ({ target, focusIn }) => {
    const { a, b } = await splitAB();
    const [keptEditor, goneEditor] = target === "note-a" ? [a, b] : [b, a];
    const kept = await typeIn(keptEditor, " kept ", 3, 6);
    await selectText(goneEditor, 4);
    expect(goneEditor.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe(focusIn);

    await pressTabMenuItem(target, "Unsplit");

    expect(goneEditor.isDestroyed).toBe(true);
    expectEditorKept(kept, "primary");
    expectFocusedAtSelection(kept);
  });

  it.each([
    { close: "note-b", keep: "note-a" },
    { close: "note-a", keep: "note-b" },
  ] as const)("focuses the kept editor at its selection when $close is closed from its tab (L5)", async ({ close, keep }) => {
    const { a, b } = await splitAB();
    const [keptEditor, goneEditor] = keep === "note-a" ? [a, b] : [b, a];
    await typeIn(goneEditor, " gone ", 2, 2);
    const kept = await typeIn(keptEditor, " kept ", 3, 6);

    await press(tabButton(close).querySelector(".tab-close")!);

    expect(useNoteStore.getState().openTabIds).toEqual([keep]);
    expect(goneEditor.isDestroyed).toBe(true);
    expectEditorKept(kept, "primary");
    expectFocusedAtSelection(kept);
  });

  it("moves the note chosen in the sidebar into the focused pane with its own editor and selection, and focuses it (L6)", async () => {
    const { a, b } = await splitAB();
    const chosen = await typeIn(b, " typing B ", 2, 6);
    const other = await typeIn(a, " typing A ", 3, 7);

    await press(sidebarNote("note-b"));

    expect(useNoteStore.getState().activeTabId).toBe("note-b");
    expectEditorKept(chosen, "primary");
    expectEditorKept(other, "secondary");
    expectFocusedAtSelection(chosen);
  });

  // ---- L7, L8, L13: tab shortcuts ----

  it.each([
    { name: "Ctrl+Tab", shiftKey: false },
    { name: "Shift+Ctrl+Tab", shiftKey: true },
  ])("focuses the kept editor at its selection for $name pressed on a toolbar button (L7)", async ({ shiftKey }) => {
    const { a, b } = await splitAB();
    const chosen = await typeIn(b, " typing B ", 2, 6);
    await typeIn(a, " typing A ", 3, 7);
    const button = container.querySelector<HTMLElement>('button[aria-label="Bold"]')!;
    await focusOn(button);

    await pressKey(button, "Tab", { shiftKey });

    expectEditorKept(chosen, "primary");
    expectFocusedAtSelection(chosen);
  });

  it("focuses the editor that stays for Ctrl+W on a toolbar button only after the panes settle (L7, L13)", async () => {
    const { a, b } = await splitAB();
    const kept = await typeIn(b, " typing B ", 2, 6);
    // Focusing A saves B; A has no changes, so Ctrl+W closes it without asking.
    await selectText(a, 3, 7);
    const button = container.querySelector<HTMLElement>('button[aria-label="Bold"]')!;
    await focusOn(button);
    const layoutsAtFocus: string[] = [];
    vi.spyOn(b.view, "focus").mockImplementation(function (this: Editor["view"]) {
      layoutsAtFocus.push(`${container.querySelectorAll(".editor-pane").length} pane(s), b in ${b.view.dom.closest("[data-pane]")?.getAttribute("data-pane")}`);
      return Object.getPrototypeOf(this).focus.call(this);
    });

    await pressKey(button, "w");

    expect(a.isDestroyed).toBe(true);
    expect(useNoteStore.getState().openTabIds).toEqual(["note-b"]);
    // The commit without a focused editor did nothing; the normalized one focused B once.
    expect(layoutsAtFocus).toEqual(["1 pane(s), b in primary"]);
    expectEditorKept(kept, "primary");
    expectFocusedAtSelection(kept);
  });

  it("switches with Ctrl+Tab in an editor without needing the navigation (L8)", async () => {
    const { a, b } = await splitAB();
    const chosen = await typeIn(b, " typing B ", 2, 6);
    await typeIn(a, " typing A ", 3, 7);

    await pressKey(a.view.dom, "Tab");

    expectEditorKept(chosen, "primary");
    expectFocusedAtSelection(chosen);
  });

  it("does not move focus out of another editor's composition when the focused pane changes (L8, I2)", async () => {
    const { a, b } = await splitAB();
    await typeIn(a, " typing A ", 3, 7);
    await typeIn(b, " typing B ", 2, 6);
    await act(async () => { b.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    expect(b.view.composing).toBe(true);
    const aFocus = vi.spyOn(a.view, "focus");
    const bBlur = vi.spyOn(b.view.dom, "blur");

    // A press on A's empty area makes A's pane the focused one in the same
    // event; the shell focuses A itself only in the next frame.
    await act(async () => {
      a.view.dom.closest(".editor-shell")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(container.querySelector('[data-pane="primary"]')?.className).toContain("focused");
    expect(aFocus).not.toHaveBeenCalled();
    expect(bBlur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(b.view.dom);
    expect(b.view.composing).toBe(true);
  });

  it("keeps focus on the moved note and shows the note that fills the freed pane without focus, with three tabs (L13)", async () => {
    openNotes(["note-a", "note-b", "note-c"]);
    const { a, b } = await splitAB();
    await typeIn(a, " typing A ", 2, 2);
    const kept = await typeIn(b, " typing B ", 3, 7);

    await pressTabMenuItem("note-a", "Close");

    expect(useNoteStore.getState().openTabIds).toEqual(["note-b", "note-c"]);
    expectEditorKept(kept, "primary");
    expectFocusedAtSelection(kept);
    const c = paneEditor("secondary");
    expect(c.getText()).toBe("body of note-c");
    expect(c.view.hasFocus()).toBe(false);
  });

  // ---- L10, L11: a close that waits ----

  /**
   * A | B with B focused and its autosave in flight, focus on note-a's tab
   * (reached by keyboard), and Ctrl+W pressed there: closing note-b waits for
   * the save.
   */
  async function closeWaitingForSave(notes = ["note-a", "note-b"]) {
    openNotes(notes);
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    const watchers = trackDocumentWatchers();
    const { a, b } = await splitAB();
    const kept = await typeIn(a, " typing A ", 3, 7);
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    await typeIn(b, " typing B ", 2, 6);
    await advanceTime(AUTO_SAVE_DELAY_MS);
    expect(mocks.autoSave).toHaveBeenLastCalledWith("note-b", expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
    const source = tabButton("note-a");
    await focusOn(source);
    const baseline = watchers();
    const aFocus = vi.spyOn(a.view, "focus");

    await pressKey(source, "w");

    expect(useNoteStore.getState().openTabIds).toContain("note-b");
    expect(watchers()).toEqual([...baseline, ...INTENT_WATCHERS].sort());
    const finishSave = async () => {
      await act(async () => { pendingSave.resolve(savedResult("note-b")); });
      await flushReactWork();
      await advanceTime(32);
      expect(useNoteStore.getState().openTabIds).not.toContain("note-b");
      expect(b.isDestroyed).toBe(true);
    };
    return { a, b, kept, source, aFocus, watchers, baseline, finishSave };
  }

  it("focuses the editor that stays when the close from a tab finishes after its save (L7, L11)", async () => {
    const { kept, aFocus, watchers, baseline, finishSave } = await closeWaitingForSave();

    await finishSave();

    expect(aFocus).toHaveBeenCalledTimes(1);
    expectEditorKept(kept, "primary");
    expectFocusedAtSelection(kept);
    expect(watchers()).toEqual(baseline);
  });

  it("does not let a background layout change use a close that still waits for its save prompt (L10)", async () => {
    openNotes(["note-a", "note-b", "note-c"]);
    const { a, b } = await splitAB();
    await typeIn(a, " typing A ", 3, 7);
    const kept = await typeIn(b, " typing B ", 2, 6);
    const prompt = deferred<string>();
    mocks.dialogMessage.mockReturnValueOnce(prompt.promise);
    const source = tabButton("note-c");
    await focusOn(source);
    const bFocus = vi.spyOn(b.view, "focus");

    await pressKey(source, "w");
    expect(mocks.dialogMessage).toHaveBeenCalledTimes(1);
    // note-a goes away in the background: note-b moves to the primary pane
    // and stays the focused note, note-c fills the other pane.
    await removeInBackground("note-a");

    expectEditorKept(kept, "primary");
    expect(document.activeElement).toBe(source);
    expect(bFocus).not.toHaveBeenCalled();

    // Don't save: the close goes on, and the note that stays takes focus now.
    await act(async () => { prompt.resolve("No"); });
    await flushReactWork();
    await advanceTime(32);
    expect(useNoteStore.getState().openTabIds).toEqual(["note-c"]);
    expect(document.activeElement).toBe(paneEditor("primary").view.dom);
    expect(paneEditor("primary").getText()).toBe("body of note-c");
  });

  it("does not count the closing tab vanishing in the background as the close, while its save prompt waits (L10)", async () => {
    const { a, b } = await splitAB();
    await typeIn(a, " typing A ", 3, 7);
    await typeIn(b, " typing B ", 2, 6);
    const prompt = deferred<string>();
    mocks.dialogMessage.mockReturnValueOnce(prompt.promise);
    const source = tabButton("note-a");
    await focusOn(source);
    const aFocus = vi.spyOn(a.view, "focus");

    await pressKey(source, "w");
    await removeInBackground("note-b");

    expect(b.isDestroyed).toBe(true);
    expect(document.activeElement).toBe(source);
    expect(aFocus).not.toHaveBeenCalled();

    await act(async () => { prompt.resolve("No"); });
    await flushReactWork();
    await advanceTime(32);
    expect(document.activeElement).toBe(source);
    expect(aFocus).not.toHaveBeenCalled();
  });

  it("leaves focus on another control chosen while the close waits, even after focus returns to the tab (L11)", async () => {
    const { source, aFocus, watchers, baseline, finishSave } = await closeWaitingForSave();
    const bold = container.querySelector<HTMLElement>('button[aria-label="Bold"]')!;

    await focusOn(bold);
    expect(watchers()).toEqual(baseline);
    await focusOn(source);
    await finishSave();

    expect(document.activeElement).toBe(source);
    expect(aFocus).not.toHaveBeenCalled();
  });

  it("does not let a close that waited take focus after another tab was chosen meanwhile (L11, L12)", async () => {
    const { a, aFocus, watchers, baseline, finishSave } = await closeWaitingForSave(["note-a", "note-b", "note-c"]);

    // note-c replaces note-b in the focused pane and takes focus as a new editor.
    await press(tabButton("note-c"));
    const c = paneEditor("secondary");
    expect(c.getText()).toBe("body of note-c");
    expect(document.activeElement).toBe(c.view.dom);
    expect(watchers()).toEqual(baseline);
    await finishSave();

    expect(document.activeElement).toBe(c.view.dom);
    expect(aFocus).not.toHaveBeenCalled();
    expect(a.isDestroyed).toBe(false);
  });

  it("lets a tab shortcut pressed on the same tab replace a waiting close, and uses only the newer navigation (L12)", async () => {
    const { a, source, watchers, baseline, finishSave } = await closeWaitingForSave();

    // Focus stays on note-a's tab: Ctrl+Tab brings note-a into the focused pane.
    await pressKey(source, "Tab");

    expect(a.view.dom.closest("[data-pane]")?.getAttribute("data-pane")).toBe("secondary");
    expect(document.activeElement).toBe(a.view.dom);
    expect(watchers()).toEqual(baseline);

    await finishSave();
    expect(document.activeElement).toBe(a.view.dom);
    expect(watchers()).toEqual(baseline);
  });

  it.each([
    { name: "cancelled", answer: "Cancel", saveFails: false },
    { name: "its save fails", answer: "Yes", saveFails: true },
  ])("ends the navigation of a close that is $name, keeps the tab, and leaves the tab's focus to a later reload (L11)", async ({ answer, saveFails }) => {
    const watchers = trackDocumentWatchers();
    const { a, b } = await splitAB();
    const kept = await typeIn(a, " typing A ", 3, 7);
    await typeIn(b, " typing B ", 2, 6);
    const prompt = deferred<string>();
    mocks.dialogMessage.mockReturnValueOnce(prompt.promise);
    if (saveFails) {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks.autoSave.mockRejectedValueOnce(new Error("disk full"));
    }
    const source = tabButton("note-a");
    await focusOn(source);
    const baseline = watchers();
    const aFocus = vi.spyOn(a.view, "focus");

    await pressKey(source, "w");
    expect(watchers()).toEqual([...baseline, ...INTENT_WATCHERS].sort());
    await act(async () => { prompt.resolve(answer); });
    await flushReactWork();
    await advanceTime(32);

    expect(useNoteStore.getState().openTabIds).toEqual(["note-a", "note-b"]);
    expect(useNoteStore.getState().notesById["note-b"].isDirty).toBe(true);
    expect(watchers()).toEqual(baseline);
    await removeInBackground("note-b");
    expect(document.activeElement).toBe(source);
    expect(aFocus).not.toHaveBeenCalled();
    expectEditorKept(kept, "primary");
  });

  it("drops a waiting close when settings open, so the tab keeps focus after the close finishes (L3)", async () => {
    const { source, aFocus, watchers, baseline, finishSave } = await closeWaitingForSave();

    // Opened without moving focus (as a shortcut or menu would), then closed.
    await act(async () => { container.querySelector<HTMLElement>(".toolbar-right button:last-child")!.click(); });
    await flushReactWork();
    expect(container.querySelector("[data-settings]")).not.toBeNull();
    expect(watchers()).toEqual(baseline);
    await act(async () => { container.querySelector<HTMLElement>("[data-settings-close]")!.click(); });
    await advanceTime(64);
    await finishSave();

    expect(document.activeElement).toBe(source);
    expect(aFocus).not.toHaveBeenCalled();
  });

  it("drops a waiting close when the calendar replaces the notes, so the tab keeps focus after the close finishes", async () => {
    const { source, watchers, baseline, finishSave } = await closeWaitingForSave();

    await act(async () => { container.querySelector<HTMLElement>(".titlebar .calendar-tab")!.click(); });
    await flushReactWork();
    expect(watchers()).toEqual(baseline);
    await act(async () => { container.querySelector<HTMLElement>(".sidebar .view-toggle-btn")!.click(); });
    await advanceTime(64);
    const a = paneEditor("primary");
    const aFocus = vi.spyOn(a.view, "focus");
    await focusOn(source);
    await finishSave();

    expect(document.activeElement).toBe(source);
    expect(aFocus).not.toHaveBeenCalled();
  });

  it("drops a waiting close when another editor's area is pressed, before that editor takes focus a frame later", async () => {
    const { a, aFocus, finishSave, watchers, baseline } = await closeWaitingForSave();

    await act(async () => {
      const shell = a.view.dom.closest(".editor-shell")!;
      shell.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      shell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(watchers()).toEqual(baseline);
    // The save finishes before the shell's frame.
    await act(async () => { await Promise.resolve(); });
    await finishSave();

    expect(document.activeElement).toBe(a.view.dom);
    // Only the shell's own focus ran, not one for the close.
    expect(aFocus).toHaveBeenCalledTimes(1);
  });

  it("keeps a waiting close when the app itself focuses an editor for a background layout change", async () => {
    openNotes(["note-a", "note-b", "note-c"]);
    const pendingSave = deferred<ReturnType<typeof savedResult>>();
    const watchers = trackDocumentWatchers();
    const { a, b } = await splitAB();
    await typeIn(a, " typing A ", 3, 7);
    mocks.autoSave.mockReturnValueOnce(pendingSave.promise);
    await typeIn(b, " typing B ", 2, 6);
    await advanceTime(AUTO_SAVE_DELAY_MS);
    await act(async () => { b.view.dom.blur(); });
    const baseline = watchers();

    await pressKey(document.body, "w");
    expect(watchers()).toEqual([...baseline, ...INTENT_WATCHERS].sort());
    // note-a goes away in the background; note-b moves to the primary pane and
    // App focuses it, since focus was on the page.
    await removeInBackground("note-a");

    expect(document.activeElement).toBe(b.view.dom);
    expect(watchers()).toEqual([...baseline, ...INTENT_WATCHERS].sort());

    await act(async () => { pendingSave.resolve(savedResult("note-b")); });
    await flushReactWork();
    await advanceTime(32);
    expect(useNoteStore.getState().openTabIds).toEqual(["note-c"]);
    expect(document.activeElement).toBe(paneEditor("primary").view.dom);
    expect(watchers()).toEqual(baseline);
  });

  it("ends a close navigation whose note the store opens again, as it does for the last library note", async () => {
    openNotes(["note-a"]);
    const watchers = trackDocumentWatchers();
    await renderApp();
    const button = container.querySelector<HTMLElement>('button[aria-label="Bold"]')!;
    await focusOn(button);
    const baseline = watchers();

    await pressKey(button, "w");

    expect(useNoteStore.getState().openTabIds).toEqual(["note-a"]);
    expect(document.activeElement).toBe(button);
    expect(watchers()).toEqual(baseline);
  });

  it("drops a waiting close navigation when the app unmounts", async () => {
    const { watchers } = await closeWaitingForSave();

    await act(async () => { root.render(<div />); });
    await advanceTime(32);

    expect(watchers()).toEqual([]);
  });

  // ---- L12: no-op navigation and one intent per operation ----

  it("leaves focus on a dragged tab dropped outside the editors when the split changes in the background later (L12)", async () => {
    const { a } = await splitAB();
    const kept = await typeIn(a, " typing A ", 3, 7);
    const aFocus = vi.spyOn(a.view, "focus");

    await dragTab("note-a", 500, 900);
    expect(document.activeElement).toBe(tabButton("note-a"));
    await removeInBackground("note-b");

    expect(container.querySelector(".editor-workspace.split")).toBeNull();
    expect(document.activeElement).toBe(tabButton("note-a"));
    expect(aFocus).not.toHaveBeenCalled();
    expectEditorKept(kept, "primary");
  });

  it("leaves focus on the focused pane's own tab, pressed again, when the split changes in the background later (L12)", async () => {
    const { a } = await splitAB();
    const kept = await typeIn(a, " typing A ", 3, 7);
    const aFocus = vi.spyOn(a.view, "focus");

    await press(tabButton("note-a"));
    expect(document.activeElement).toBe(tabButton("note-a"));
    await removeInBackground("note-b");

    expect(container.querySelector(".editor-workspace.split")).toBeNull();
    expect(document.activeElement).toBe(tabButton("note-a"));
    expect(aFocus).not.toHaveBeenCalled();
    expectEditorKept(kept, "primary");
  });

  it("uses a navigation once: its tab focused again later does not let a background change take focus (L12)", async () => {
    const watchers = trackDocumentWatchers();
    const { a, b } = await splitAB();
    const chosen = await typeIn(b, " typing B ", 2, 6);
    await typeIn(a, " typing A ", 3, 7);
    const baseline = watchers();
    await press(tabButton("note-b"));
    expectFocusedAtSelection(chosen);
    expect(watchers()).toEqual(baseline);
    const bFocus = vi.spyOn(b.view, "focus");

    // Back to the tab by keyboard, then note-a goes away in the background.
    await focusOn(tabButton("note-b"));
    await removeInBackground("note-a");

    expect(container.querySelector(".editor-workspace.split")).toBeNull();
    expect(document.activeElement).toBe(tabButton("note-b"));
    expect(bFocus).not.toHaveBeenCalled();
    expectEditorKept(chosen, "primary");
  });

  it("uses one navigation for closing other tabs, once, though later tabs still wait for their prompt (L12)", async () => {
    openNotes(["note-a", "note-b", "note-c", "note-d"]);
    const watchers = trackDocumentWatchers();
    const { a } = await splitAB();
    const kept = await typeIn(a, " typing A ", 3, 7);
    // note-c has unsaved changes; closing it asks first.
    await act(async () => {
      useNoteStore.getState().updateTabContent("note-c", { type: "doc", content: [{ type: "paragraph" }] }, "");
    });
    const prompt = deferred<string>();
    mocks.dialogMessage.mockReturnValueOnce(prompt.promise);
    const baseline = watchers();
    const aFocus = vi.spyOn(a.view, "focus");

    await pressTabMenuItem("note-a", "Close others");

    // note-b closed first: the split ended and A took focus once.
    expect(useNoteStore.getState().openTabIds).toEqual(["note-a", "note-c", "note-d"]);
    expect(mocks.dialogMessage).toHaveBeenCalledTimes(1);
    expect(aFocus).toHaveBeenCalledTimes(1);
    expectFocusedAtSelection(kept);
    expect(watchers()).toEqual(baseline);

    await act(async () => { prompt.resolve("No"); });
    await flushReactWork();
    await advanceTime(32);

    expect(useNoteStore.getState().openTabIds).toEqual(["note-a"]);
    expect(aFocus).toHaveBeenCalledTimes(1);
    expect(watchers()).toEqual(baseline);
    expectFocusedAtSelection(kept);
  });

  // ---- L14: new editors keep their autofocus ----

  function expectFocusedAtEnd(editor: Editor) {
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
  }

  it("focuses a new split editor at its end as before, and leaves no navigation behind (L14)", async () => {
    const watchers = trackDocumentWatchers();
    await renderApp();
    const baseline = watchers();

    await dragTab("note-b", 750);

    const b = paneEditor("secondary");
    expect(b.getText()).toBe("body of note-b");
    expectFocusedAtEnd(b);
    expect(watchers()).toEqual(baseline);
  });

  it("focuses a new note's editor as before, and leaves no navigation behind (L14)", async () => {
    const watchers = trackDocumentWatchers();
    const { a } = await splitAB();
    await typeIn(a, " typing A ", 3, 7);
    const baseline = watchers();

    await pressKey(a.view.dom, "n");

    const created = paneEditor("primary");
    expect(created).not.toBe(a);
    expect(document.activeElement).toBe(created.view.dom);
    expect(watchers()).toEqual(baseline);
  });

  it("focuses the note opened from the calendar at its end as before, and leaves no navigation behind (L14)", async () => {
    const watchers = trackDocumentWatchers();
    await renderApp();
    await act(async () => { container.querySelector<HTMLElement>(".titlebar .calendar-tab")!.click(); });
    await advanceTime(32);
    const baseline = watchers();

    await press(container.querySelector("[data-calendar-note]")!);

    const b = paneEditor("primary");
    expect(b.getText()).toBe("body of note-b");
    expectFocusedAtEnd(b);
    expect(watchers()).toEqual(baseline);
  });

  // ---- A new navigation ends an older focus restore (L90) ----

  it.each([
    { name: "Ctrl+Tab", shiftKey: false },
    { name: "Shift+Ctrl+Tab", shiftKey: true },
  ])("drops a waiting focus restore for $name with a single tab, though the key changes nothing", async ({ shiftKey }) => {
    openNotes(["note-a"]);
    await renderApp();
    const a = paneEditor("primary");
    await selectText(a, 3);
    await act(async () => { a.view.dom.blur(); });
    windowState.focused = false;
    act(() => restoreEditorFocus(a));
    await advanceTime(64);
    expect(isEditorFocusPending()).toBe(true);
    const aFocus = vi.spyOn(a.view, "focus");

    await pressKey(document.body, "Tab", { shiftKey });

    expect(isEditorFocusPending()).toBe(false);
    windowState.focused = true;
    await act(async () => { window.dispatchEvent(new FocusEvent("focus")); });
    await advanceTime(64);
    expect(aFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });
});
