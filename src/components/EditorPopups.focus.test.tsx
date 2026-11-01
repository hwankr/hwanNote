// @vitest-environment jsdom

import type { Editor as TiptapEditor, JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/context";
import { translate } from "../i18n/messages";
import { isEditorFocusPending } from "../lib/editorFocusRestore";
import Editor, { restoreEditorFocus } from "./Editor";
import Toolbar from "./Toolbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/tauriApi", () => ({ hwanShell: { openExternal: vi.fn() } }));

const linkDocument: JSONContent = {
  type: "doc",
  content: [{
    type: "paragraph",
    content: [
      { type: "text", text: "before " },
      { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
      { type: "text", text: " after" }
    ]
  }]
};

const noop = () => {};

describe("editor popups and focus restoration", () => {
  let container: HTMLDivElement;
  let root: Root;
  const editors: TiptapEditor[] = [];
  // Focus restoration needs an active window. Model one explicitly: jsdom's
  // document.hasFocus() is false whenever no element has focus.
  const windowState = { focused: true, visibility: "visible" as DocumentVisibilityState };

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    editors.length = 0;
    windowState.focused = true;
    windowState.visibility = "visible";
    vi.spyOn(document, "hasFocus").mockImplementation(() => windowState.focused);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => windowState.visibility);
    // jsdom has no layout. ProseMirror reads these when it focuses and scrolls.
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
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

  async function mount({ editorCount = 1 }: { editorCount?: number } = {}) {
    function Harness() {
      return (
        <I18nProvider>
          <Toolbar
            editor={editors[0] ?? null}
            activeTitle="Note"
            activeTabId="note-a"
            isTitleManual
            onTitleDraftChange={noop}
            onChangeTitle={noop}
            lastSavedAt={0}
            onOpenSettings={noop}
            onImportTxt={noop}
          />
          {Array.from({ length: editorCount }, (_, index) => (
            <Editor
              key={index}
              content={linkDocument}
              tabSize={4}
              spellcheck={false}
              autofocus={false}
              onChange={noop}
              onCursorChange={noop}
              onEditorReady={(nextEditor) => {
                if (nextEditor) editors[index] = nextEditor;
              }}
            />
          ))}
        </I18nProvider>
      );
    }

    await act(async () => { root.render(<Harness />); });
    // Render again so the toolbar receives the editor reported after mount.
    await act(async () => { root.render(<Harness />); });
    expect(editors).toHaveLength(editorCount);
    return editors.slice();
  }

  async function advanceFrames() {
    // Flush the restore frame and any extra frame a TipTap command schedules
    // (editor.commands.focus() focuses one frame later).
    await act(async () => { await vi.advanceTimersByTimeAsync(64); });
  }

  function titleInput() {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Note title"]');
    if (!input) throw new Error("Expected the title input");
    return input;
  }

  function required<T extends Element>(selector: string) {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Expected ${selector}`);
    return element;
  }

  async function focusEditor(editor: TiptapEditor) {
    await act(async () => { editor.view.focus(); });
    expect(document.activeElement).toBe(editor.view.dom);
  }

  async function openLinkBubble(editor: TiptapEditor) {
    await focusEditor(editor);
    const link = editor.view.dom.querySelector("a");
    if (!link) throw new Error("Expected a link in the editor");
    await act(async () => { link.click(); });
    expect(document.querySelector(".link-bubble")).not.toBeNull();
  }

  async function startLinkBubbleEdit(editor: TiptapEditor) {
    await openLinkBubble(editor);
    const editButton = required<HTMLButtonElement>(`.link-bubble button[title="${translate("ko", "linkBubble.edit")}"]`);
    await act(async () => {
      editButton.focus();
      editButton.click();
    });
    const urlInput = required<HTMLInputElement>('.link-bubble-edit input[type="url"]');
    expect(document.activeElement).toBe(urlInput);
    return urlInput;
  }

  async function openToolbarPopup(editor: TiptapEditor, label: "toolbar.link" | "toolbar.table") {
    await focusEditor(editor);
    const button = container.querySelector<HTMLButtonElement>(`.toolbar button[aria-label="${translate("ko", label)}"]`);
    if (!button) throw new Error(`Expected the ${label} button`);
    await act(async () => { button.click(); });
  }

  // The browser focuses a clicked control after its mousedown listeners run.
  async function pressOn(target: HTMLElement, focus: () => void) {
    await act(async () => {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      focus();
    });
  }

  async function pressEscape(target: Element) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
    });
  }

  async function scroll(target: EventTarget) {
    await act(async () => { target.dispatchEvent(new Event("scroll")); });
  }

  it("leaves focus in another input clicked while the link bubble closes", async () => {
    const [editor] = await mount();
    await openLinkBubble(editor);
    const input = titleInput();

    await pressOn(input, () => input.focus());
    await advanceFrames();

    expect(document.querySelector(".link-bubble")).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("returns focus to the editor when Escape closes the link bubble", async () => {
    const [editor] = await mount();
    await openLinkBubble(editor);
    const openButton = required<HTMLButtonElement>(`.link-bubble button[title="${translate("ko", "linkBubble.open")}"]`);
    await act(async () => { openButton.focus(); });

    await pressEscape(openButton);
    await advanceFrames();

    expect(document.querySelector(".link-bubble")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("returns focus to the editor when Escape closes link editing", async () => {
    const [editor] = await mount();
    const urlInput = await startLinkBubbleEdit(editor);

    await pressEscape(urlInput);
    await advanceFrames();

    expect(document.querySelector(".link-bubble")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("returns focus to the editor when link editing is cancelled", async () => {
    const [editor] = await mount();
    await startLinkBubbleEdit(editor);
    const cancelButton = required<HTMLButtonElement>(".link-bubble-edit .link-popup-cancel");

    await act(async () => {
      cancelButton.focus();
      cancelButton.click();
    });
    await advanceFrames();

    expect(document.querySelector(".link-bubble-edit")).toBeNull();
    expect(document.querySelector(".link-bubble")).not.toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.getText()).toBe("before link after");
  });

  it.each([
    { name: "link popup", label: "toolbar.link" as const, selector: ".link-popup" },
    { name: "table size popup", label: "toolbar.table" as const, selector: ".table-size-popup" },
  ])("leaves focus in another input clicked while the toolbar $name closes", async ({ label, selector }) => {
    const [editor] = await mount();
    await openToolbarPopup(editor, label);
    expect(document.querySelector(selector)).not.toBeNull();
    const input = titleInput();

    await pressOn(input, () => input.focus());
    await advanceFrames();

    expect(document.querySelector(selector)).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("returns focus to the editor when Escape closes the toolbar link popup", async () => {
    const [editor] = await mount();
    await openToolbarPopup(editor, "toolbar.link");
    const urlInput = required<HTMLInputElement>('.link-popup input[type="url"]');
    expect(document.activeElement).toBe(urlInput);

    await pressEscape(urlInput);
    await advanceFrames();

    expect(document.querySelector(".link-popup")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("restores focus that fell to the page, as after closing settings", async () => {
    const [editor] = await mount();
    await focusEditor(editor);
    await act(async () => { editor.view.dom.blur(); });
    expect(document.activeElement).toBe(document.body);

    act(() => restoreEditorFocus(editor));
    await advanceFrames();

    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("does not take focus from another control", async () => {
    const [editor] = await mount();
    const input = titleInput();
    await act(async () => { input.focus(); });
    const viewFocus = vi.spyOn(editor.view, "focus");

    act(() => restoreEditorFocus(editor));
    await advanceFrames();

    expect(document.activeElement).toBe(input);
    expect(viewFocus).not.toHaveBeenCalled();
  });

  it("does not try to focus an editor whose DOM left the page", async () => {
    const [editor] = await mount();
    const editorDOM = editor.view.dom;
    const parent = editorDOM.parentElement;
    if (!parent) throw new Error("Expected the editor to be mounted");
    expect(document.activeElement).toBe(document.body);
    // Focusing a detached element leaves activeElement on the body in jsdom,
    // so only the focus calls show whether the editor tried.
    const viewFocus = vi.spyOn(editor.view, "focus");
    const domFocus = vi.spyOn(editorDOM, "focus");

    try {
      act(() => {
        restoreEditorFocus(editor);
        editorDOM.remove();
      });
      await advanceFrames();

      expect(viewFocus).not.toHaveBeenCalled();
      expect(domFocus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.body);
    } finally {
      parent.appendChild(editorDOM);
    }
  });

  async function blurEditorAt(editor: TiptapEditor, position: number) {
    await focusEditor(editor);
    await act(async () => { editor.commands.setTextSelection(position); });
    await act(async () => { editor.view.dom.blur(); });
    expect(document.activeElement).toBe(document.body);
  }

  async function advanceOneFrame() {
    // Fake animation frames run on a 16ms grid, so 16ms always covers one.
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
  }

  it("restores lost focus in the same frame that checks it", async () => {
    const [editor] = await mount();
    await blurEditorAt(editor, 3);

    act(() => restoreEditorFocus(editor));
    await advanceOneFrame();

    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("leaves focus in a field focused right after the restore frame", async () => {
    const [editor] = await mount();
    await blurEditorAt(editor, 3);
    const input = titleInput();

    act(() => restoreEditorFocus(editor));
    await advanceOneFrame();
    await act(async () => { input.focus(); });
    await advanceFrames();

    expect(document.activeElement).toBe(input);
    expect(editor.isFocused).toBe(false);
  });

  it("keeps the selection and stored marks and scrolls the cursor into view when it restores focus", async () => {
    const [editor] = await mount();
    await blurEditorAt(editor, 3);
    const bold = editor.schema.marks.bold.create();
    await act(async () => { editor.view.dispatch(editor.state.tr.addStoredMark(bold)); });
    const transactions: { scrolledIntoView: boolean }[] = [];
    editor.on("transaction", ({ transaction }) => { transactions.push(transaction); });

    act(() => restoreEditorFocus(editor));
    await advanceFrames();

    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(3);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.storedMarks).toEqual([bold]);
    expect(transactions.some((transaction) => transaction.scrolledIntoView)).toBe(true);
  });

  it("leaves an editor that already has focus untouched", async () => {
    const [editor] = await mount();
    await focusEditor(editor);
    await act(async () => { editor.commands.setTextSelection(3); });
    const selection = editor.state.selection;
    const transactions = vi.fn();
    editor.on("transaction", transactions);
    const viewFocus = vi.spyOn(editor.view, "focus");

    act(() => restoreEditorFocus(editor));
    await advanceFrames();

    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection).toBe(selection);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(transactions).not.toHaveBeenCalled();
  });

  // A toolbar button keeps focus where it was on mousedown and stops the
  // event, so the popup's own outside-press handling does not run.
  async function pressToolbarButton(label: "toolbar.link" | "toolbar.table") {
    const button = container.querySelector<HTMLButtonElement>(`.toolbar button[aria-label="${translate("ko", label)}"]`);
    if (!button) throw new Error(`Expected the ${label} button`);
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      button.dispatchEvent(mousedown);
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(mousedown.defaultPrevented).toBe(true);
  }

  it("returns focus to the editor when the link button closes its popup", async () => {
    const [editor] = await mount();
    await openToolbarPopup(editor, "toolbar.link");
    expect(document.activeElement).toBe(required<HTMLInputElement>('.link-popup input[type="url"]'));

    await pressToolbarButton("toolbar.link");
    await advanceFrames();

    expect(document.querySelector(".link-popup")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("keeps focus in the editor when the table button closes its popup", async () => {
    const [editor] = await mount();
    await openToolbarPopup(editor, "toolbar.table");
    expect(document.querySelector(".table-size-popup")).not.toBeNull();

    await pressToolbarButton("toolbar.table");
    await advanceFrames();

    expect(document.querySelector(".table-size-popup")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it.each([
    { name: "URL", selector: 'input[type="url"]' },
    { name: "display name", selector: 'input[type="text"]' },
  ])("keeps focus in the link edit $name field when it is clicked", async ({ selector }) => {
    const [editor] = await mount();
    await startLinkBubbleEdit(editor);
    const field = required<HTMLInputElement>(`.link-bubble-edit ${selector}`);

    await pressOn(field, () => field.focus());
    await advanceFrames();

    expect(document.querySelector(".link-bubble-edit")).not.toBeNull();
    expect(document.activeElement).toBe(field);
    expect(editor.isFocused).toBe(false);
  });

  it("still focuses the editor when the empty area of its shell is pressed", async () => {
    const [editor] = await mount();
    const input = titleInput();
    await act(async () => { input.focus(); });
    const shell = editor.view.dom.closest<HTMLElement>(".editor-shell");
    if (!shell) throw new Error("Expected the editor shell");

    // Pressing a non-focusable area moves focus off the field.
    await pressOn(shell, () => input.blur());
    await advanceFrames();

    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("keeps focus in a second editor whose text is clicked while the first editor's link bubble closes", async () => {
    const [first, second] = await mount({ editorCount: 2 });
    await openLinkBubble(first);
    const paragraph = second.view.dom.querySelector("p");
    if (!paragraph) throw new Error("Expected a paragraph in the second editor");
    // ProseMirror maps the click to a document position. jsdom has no hit testing.
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => paragraph });

    try {
      await pressOn(paragraph, () => second.view.focus());
      await act(async () => { paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 })); });
      await advanceFrames();
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }

    expect(document.querySelector(".link-bubble")).toBeNull();
    expect(document.activeElement).toBe(second.view.dom);
    expect(second.isFocused).toBe(true);
    expect(first.isFocused).toBe(false);
  });

  it("keeps focus in a second editor whose empty area is clicked while the first editor's link bubble closes", async () => {
    const [first, second] = await mount({ editorCount: 2 });
    await openLinkBubble(first);
    const shell = second.view.dom.closest<HTMLElement>(".editor-shell");
    if (!shell) throw new Error("Expected the second editor shell");

    // The shell focuses its editor itself; the page keeps no focused control.
    await pressOn(shell, () => (document.activeElement as HTMLElement | null)?.blur());
    await advanceFrames();

    expect(document.querySelector(".link-bubble")).toBeNull();
    expect(document.activeElement).toBe(second.view.dom);
    expect(first.isFocused).toBe(false);
  });

  it("keeps link editing open when its URL field scrolls, and closes on an outside scroll", async () => {
    const [editor] = await mount();
    const urlInput = await startLinkBubbleEdit(editor);

    await scroll(urlInput);
    expect(document.querySelector(".link-bubble-edit")).not.toBeNull();
    expect(document.activeElement).toBe(urlInput);

    await scroll(document);
    await advanceFrames();
    expect(document.querySelector(".link-bubble")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("keeps the toolbar link popup open when its URL field scrolls, and closes on an outside scroll", async () => {
    const [editor] = await mount();
    await openToolbarPopup(editor, "toolbar.link");
    const urlInput = required<HTMLInputElement>('.link-popup input[type="url"]');

    await scroll(urlInput);
    expect(document.querySelector(".link-popup")).not.toBeNull();
    expect(document.activeElement).toBe(urlInput);

    await scroll(editor.view.dom);
    await advanceFrames();
    expect(document.querySelector(".link-popup")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("keeps the table size popup open for a scroll inside it, and closes on an outside scroll", async () => {
    const [editor] = await mount();
    await openToolbarPopup(editor, "toolbar.table");

    await scroll(required(".table-size-grid"));
    expect(document.querySelector(".table-size-popup")).not.toBeNull();

    await scroll(document);
    await advanceFrames();
    expect(document.querySelector(".table-size-popup")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("returns focus to the editor when an outside scroll closes a popup that renders after the next frame", async () => {
    const [editor] = await mount();
    await openToolbarPopup(editor, "toolbar.link");
    const urlInput = required<HTMLInputElement>('.link-popup input[type="url"]');
    expect(document.activeElement).toBe(urlInput);

    // React renders a scroll-triggered close in a later task, so the browser
    // can run the restore frame while the popup and its focused field remain.
    await act(async () => {
      document.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(20);
      expect(document.querySelector(".link-popup")).not.toBeNull();
    });
    await advanceFrames();

    expect(document.querySelector(".link-popup")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
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

  function recordScrolls(editor: TiptapEditor) {
    const scrolls: unknown[] = [];
    editor.on("transaction", ({ transaction }) => {
      if (transaction.scrolledIntoView) scrolls.push(transaction);
    });
    return scrolls;
  }

  it("waits while the window is inactive, then restores once with the selection and marks when it returns (W1, W2)", async () => {
    const [editor] = await mount();
    await blurEditorAt(editor, 3);
    const bold = editor.schema.marks.bold.create();
    await act(async () => { editor.view.dispatch(editor.state.tr.addStoredMark(bold)); });
    const scrolls = recordScrolls(editor);
    const viewFocus = vi.spyOn(editor.view, "focus");
    await deactivateWindow();

    act(() => restoreEditorFocus(editor));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(document.activeElement).toBe(document.body);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(scrolls).toHaveLength(0);

    await activateWindow();
    expect(viewFocus).not.toHaveBeenCalled();
    await advanceOneFrame();

    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(3);
    expect(editor.state.storedMarks).toEqual([bold]);
    expect(scrolls).toHaveLength(1);
  });

  it("does not restore in a hidden window even when the document reports focus (W3)", async () => {
    const [editor] = await mount();
    await blurEditorAt(editor, 3);
    const scrolls = recordScrolls(editor);
    const viewFocus = vi.spyOn(editor.view, "focus");
    windowState.visibility = "hidden";

    act(() => restoreEditorFocus(editor));
    await advanceFrames();
    await act(async () => { window.dispatchEvent(new FocusEvent("focus")); });
    await advanceFrames();

    expect(document.activeElement).toBe(document.body);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(scrolls).toHaveLength(0);

    windowState.visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advanceOneFrame();
    expect(document.activeElement).toBe(editor.view.dom);
    expect(scrolls).toHaveLength(1);
  });

  it.each([
    { name: "an input", target: (_editors: TiptapEditor[]) => titleInput() },
    {
      name: "a button",
      target: (_editors: TiptapEditor[]) => {
        const button = document.createElement("button");
        container.appendChild(button);
        return button;
      },
    },
    { name: "the other editor", target: (editors: TiptapEditor[]) => editors[1].view.dom },
  ])("leaves focus in $name chosen while the window comes back, and does not restore later (W4)", async ({ target }) => {
    const editors = await mount({ editorCount: 2 });
    const [editor] = editors;
    await blurEditorAt(editor, 3);
    const viewFocus = vi.spyOn(editor.view, "focus");
    await deactivateWindow();
    act(() => restoreEditorFocus(editor));
    await advanceFrames();
    const control = target(editors);

    await activateWindow();
    if (control === editors[1].view.dom) {
      // ProseMirror maps the press to a document position. jsdom has no hit testing.
      const paragraph = control.querySelector("p")!;
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => paragraph });
      try {
        await pressOn(paragraph, () => editors[1].view.focus());
      } finally {
        Reflect.deleteProperty(document, "elementFromPoint");
      }
    } else {
      await pressOn(control, () => control.focus());
    }
    await advanceFrames();

    expect(document.activeElement).toBe(control);
    expect(viewFocus).not.toHaveBeenCalled();

    await act(async () => { control.blur(); });
    await deactivateWindow();
    await activateWindow();
    await advanceFrames();
    expect(document.activeElement).toBe(document.body);
    expect(viewFocus).not.toHaveBeenCalled();
  });

  it("does not focus an editor whose DOM left the page while the window was inactive (W5)", async () => {
    const [editor] = await mount();
    await blurEditorAt(editor, 3);
    const editorDOM = editor.view.dom;
    const parent = editorDOM.parentElement!;
    const viewFocus = vi.spyOn(editor.view, "focus");
    await deactivateWindow();
    act(() => restoreEditorFocus(editor));
    await advanceFrames();

    try {
      editorDOM.remove();
      await activateWindow();
      await advanceFrames();

      expect(viewFocus).not.toHaveBeenCalled();
    } finally {
      parent.appendChild(editorDOM);
    }
  });

  /** The focus, press and visibilitychange listeners added to the window and document from now on, not yet removed. */
  function trackListeners() {
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

  it("drops a waiting restore, its listeners and its frame as soon as its editor unmounts (W5)", async () => {
    const [editor] = await mount();
    await blurEditorAt(editor, 3);
    const viewFocus = vi.spyOn(editor.view, "focus");
    await deactivateWindow();
    const listeners = trackListeners();
    act(() => restoreEditorFocus(editor));
    await advanceFrames();
    expect(isEditorFocusPending()).toBe(true);
    expect(listeners()).toEqual(expect.arrayContaining(["document:focusin", "document:visibilitychange", "window:focus"]));

    await act(async () => { root.render(<I18nProvider>{null}</I18nProvider>); });

    // Before any timer runs, so before @tiptap/react destroys the editor.
    expect(editor.isDestroyed).toBe(false);
    expect(isEditorFocusPending()).toBe(false);
    expect(listeners()).toEqual([]);
    const frames = vi.spyOn(window, "requestAnimationFrame");
    await activateWindow();
    expect(frames).not.toHaveBeenCalled();

    await advanceFrames();
    expect(editor.isDestroyed).toBe(true);
    expect(viewFocus).not.toHaveBeenCalled();
  });

  async function mountKeyed(keys: string[]) {
    const byKey: Record<string, TiptapEditor> = {};
    await act(async () => {
      root.render(
        <I18nProvider>
          {keys.map((key) => (
            <Editor
              key={key}
              content={linkDocument}
              tabSize={4}
              spellcheck={false}
              autofocus={false}
              onChange={noop}
              onCursorChange={noop}
              onEditorReady={(nextEditor) => {
                if (nextEditor) byKey[key] = nextEditor;
              }}
            />
          ))}
        </I18nProvider>
      );
    });
    return byKey;
  }

  it("keeps the newer restore of another editor when an older editor unmounts (R3)", async () => {
    const { a, b } = await mountKeyed(["a", "b"]);
    await blurEditorAt(a, 3);
    const aFocus = vi.spyOn(a.view, "focus");
    const bFocus = vi.spyOn(b.view, "focus");
    await deactivateWindow();
    act(() => {
      restoreEditorFocus(a);
      restoreEditorFocus(b);
    });
    await advanceFrames();

    await mountKeyed(["b"]);

    expect(a.isDestroyed).toBe(false);
    expect(isEditorFocusPending()).toBe(true);
    await activateWindow();
    await advanceOneFrame();
    expect(aFocus).not.toHaveBeenCalled();
    expect(bFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(b.view.dom);
  });

  it("keeps the restore of a link bubble that closes while the window is inactive, though the bubble unmounts (R3)", async () => {
    const [editor] = await mount();
    await openLinkBubble(editor);
    await act(async () => { editor.commands.setTextSelection(3); });
    await act(async () => { editor.view.dom.blur(); });
    await deactivateWindow();
    const viewFocus = vi.spyOn(editor.view, "focus");

    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await advanceFrames();

    expect(document.querySelector(".link-bubble")).toBeNull();
    expect(isEditorFocusPending()).toBe(true);
    expect(viewFocus).not.toHaveBeenCalled();
    await activateWindow();
    await advanceOneFrame();
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(3);
  });

  /** A pointer press that focuses nothing by itself; the pressed element's own handlers decide. */
  async function pointerPress(target: HTMLElement) {
    await act(async () => {
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    });
  }

  it("gives way to the other editor whose empty area is pressed while the window comes back, though it takes focus a frame later (R1)", async () => {
    const [editor, other] = await mount({ editorCount: 2 });
    await blurEditorAt(editor, 3);
    await deactivateWindow();
    act(() => restoreEditorFocus(editor));
    await advanceOneFrame();
    const viewFocus = vi.spyOn(editor.view, "focus");
    const scrolls = recordScrolls(editor);
    const focusOrder: string[] = [];
    editor.view.dom.addEventListener("focus", () => focusOrder.push("requested"));
    other.view.dom.addEventListener("focus", () => focusOrder.push("chosen"));

    await activateWindow();
    // The real shell handler focuses the other editor through editor.commands.focus(), a frame later.
    await pointerPress(other.view.dom.closest<HTMLElement>(".editor-shell")!);
    expect(document.activeElement).toBe(document.body);
    await advanceFrames();

    expect(focusOrder).toEqual(["chosen"]);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(scrolls).toHaveLength(0);
    expect(document.activeElement).toBe(other.view.dom);

    // Focus falling back to the page later does not bring the restore back.
    await act(async () => { other.view.dom.blur(); });
    await deactivateWindow();
    await activateWindow();
    await advanceFrames();
    expect(document.activeElement).toBe(document.body);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(scrolls).toHaveLength(0);
  });

  it("still restores when a press on the title bar brings the window back (R1)", async () => {
    const [editor] = await mount({ editorCount: 2 });
    const titleBar = document.createElement("header");
    titleBar.className = "titlebar";
    const dragArea = document.createElement("div");
    dragArea.className = "titlebar-drag-handle";
    titleBar.appendChild(dragArea);
    container.prepend(titleBar);
    await blurEditorAt(editor, 3);
    await deactivateWindow();
    act(() => restoreEditorFocus(editor));
    await advanceOneFrame();
    const viewFocus = vi.spyOn(editor.view, "focus");
    const scrolls = recordScrolls(editor);

    await activateWindow();
    await pointerPress(dragArea);
    expect(isEditorFocusPending()).toBe(true);
    await advanceOneFrame();

    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(3);
    expect(scrolls).toHaveLength(1);
  });

  it("still restores when the window comes back through a press on the requested editor's own empty area (R1)", async () => {
    const [editor] = await mount({ editorCount: 2 });
    await blurEditorAt(editor, 3);
    await deactivateWindow();
    act(() => restoreEditorFocus(editor));
    await advanceOneFrame();

    await activateWindow();
    await pointerPress(editor.view.dom.closest<HTMLElement>(".editor-shell")!);
    expect(isEditorFocusPending()).toBe(true);
    await advanceFrames();

    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(3);
  });

  it("keeps only the newer of two waiting restores (W6)", async () => {
    const [first, second] = await mount({ editorCount: 2 });
    await blurEditorAt(first, 3);
    const firstFocus = vi.spyOn(first.view, "focus");
    await deactivateWindow();

    act(() => {
      restoreEditorFocus(first);
      restoreEditorFocus(second);
    });
    await advanceFrames();
    await activateWindow();
    await advanceFrames();

    expect(firstFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(second.view.dom);
  });

  it("leaves a focused editor in composition untouched when a popup closes (I2)", async () => {
    const [editor] = await mount();
    await focusEditor(editor);
    await act(async () => { editor.commands.setTextSelection(3); });
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    expect(editor.view.composing).toBe(true);
    const transactions = vi.fn();
    editor.on("transaction", transactions);
    const viewFocus = vi.spyOn(editor.view, "focus");
    const blur = vi.spyOn(editor.view.dom, "blur");

    act(() => restoreEditorFocus(editor));
    await advanceFrames();

    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.view.composing).toBe(true);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
    expect(transactions).not.toHaveBeenCalled();
  });
});
