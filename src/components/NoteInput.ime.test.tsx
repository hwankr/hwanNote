// @vitest-environment jsdom

import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/context";
import LinkBubble from "./LinkBubble";
import LinkPopup from "./LinkPopup";
import Toolbar from "./Toolbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/tauriApi", () => ({ hwanShell: { openExternal: vi.fn() } }));

const compositionModes = [
  { name: "active composition", isComposing: true },
  { name: "keyCode 229 after composition", isComposing: false, keyCode: 229 },
];

async function pressKey(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key, keyCode: key === "Enter" ? 13 : 27, bubbles: true, cancelable: true, ...init,
  });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

async function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function requiredInput(parent: ParentNode, selector: string) {
  const input = parent.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Expected input ${selector}`);
  return input;
}

describe("note input IME confirmation keys", () => {
  let container: HTMLDivElement;
  let editorHost: HTMLDivElement;
  let root: Root;
  let editor: Editor;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    container = document.createElement("div");
    editorHost = document.createElement("div");
    document.body.append(container, editorHost);
    root = createRoot(container);
    editor = new Editor({
      element: editorHost,
      extensions: [StarterKit],
      content: '<p><a href="https://example.com">이름</a></p>',
      autofocus: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    editor.destroy();
    container.remove();
    editorHost.remove();
    vi.useRealTimers();
  });

  async function render(child: ReactNode) {
    await act(async () => { root.render(<I18nProvider>{child}</I18nProvider>); });
  }

  async function renderToolbar() {
    const onChangeTitle = vi.fn();
    const onTitleDraftChange = vi.fn();
    await render(<Toolbar
      editor={editor} activeTitle="Original" activeTabId="note-a" isTitleManual
      onChangeTitle={onChangeTitle} onTitleDraftChange={onTitleDraftChange}
      lastSavedAt={0} onOpenSettings={vi.fn()} onImportTxt={vi.fn()}
    />);
    const input = requiredInput(container, 'input[aria-label="Note title"]');
    await changeInput(input, "한글 제목");
    await act(async () => { input.focus(); });
    onTitleDraftChange.mockClear();
    return { input, onChangeTitle, onTitleDraftChange };
  }

  it.each(compositionModes)("keeps a title draft focused during $name Enter/Escape", async (mode) => {
    const { input, onChangeTitle, onTitleDraftChange } = await renderToolbar();
    for (const key of ["Enter", "Escape"]) {
      const event = await pressKey(input, key, mode);
      expect(event.defaultPrevented).toBe(false);
      expect(onChangeTitle).not.toHaveBeenCalled();
      expect(onTitleDraftChange).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("한글 제목");
    }
  });

  it("commits a title on normal Enter and restores it on normal Escape", async () => {
    const { input, onChangeTitle, onTitleDraftChange } = await renderToolbar();
    expect((await pressKey(input, "Enter")).defaultPrevented).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(onChangeTitle).toHaveBeenCalledWith("note-a", "한글 제목");
    expect(document.activeElement).toBe(editor.view.dom);

    await act(async () => { input.focus(); });
    await changeInput(input, "취소할 제목");
    onChangeTitle.mockClear();
    expect((await pressKey(input, "Escape")).defaultPrevented).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(input.value).toBe("Original");
    expect(onChangeTitle).not.toHaveBeenCalled();
    expect(onTitleDraftChange).toHaveBeenLastCalledWith("note-a", "Original");
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it.each(compositionModes)("does not submit or close link creation during $name", async (mode) => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    await render(<LinkPopup anchor={{ x: 20, y: 20 }} initialUrl="https://example.com"
      initialName="한글 이름" onConfirm={onConfirm} onClose={onClose} />);
    for (const input of document.querySelectorAll<HTMLInputElement>(".link-popup input")) {
      await act(async () => { input.focus(); });
      for (const key of ["Enter", "Escape"]) {
        const event = await pressKey(input, key, mode);
        expect(event.defaultPrevented).toBe(false);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(input);
      }
    }
  });

  it("submits either link-creation field on normal Enter and closes on Escape", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    await render(<LinkPopup anchor={{ x: 20, y: 20 }} initialUrl="https://example.com"
      initialName="한글 이름" onConfirm={onConfirm} onClose={onClose} />);
    for (const input of document.querySelectorAll<HTMLInputElement>(".link-popup input")) {
      await act(async () => { input.focus(); });
      onConfirm.mockClear();
      expect((await pressKey(input, "Enter")).defaultPrevented).toBe(true);
      expect(onConfirm).toHaveBeenCalledWith("https://example.com", "한글 이름");
    }
    await pressKey(requiredInput(document, ".link-popup input"), "Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  async function renderEditableBubble() {
    const onClose = vi.fn();
    await render(<LinkBubble editor={editor} anchor={{ x: 20, y: 20 }}
      href="https://example.com" linkFrom={1} linkTo={3} onClose={onClose} />);
    const editButton = document.querySelectorAll<HTMLButtonElement>(".link-bubble-actions button")[1];
    if (!editButton) throw new Error("Expected the link edit button");
    await act(async () => { editButton.click(); });
    return onClose;
  }

  it.each(compositionModes)("keeps link editing focused and unchanged during $name", async (mode) => {
    const onClose = await renderEditableBubble();
    const beforeDocument = editor.getJSON();
    const beforeSelection = editor.state.selection;
    const name = requiredInput(document, '.link-bubble-edit input[type="text"]');
    await changeInput(name, "새 한글 이름");
    for (const input of document.querySelectorAll<HTMLInputElement>(".link-bubble-edit input")) {
      await act(async () => { input.focus(); });
      for (const key of ["Enter", "Escape"]) {
        const event = await pressKey(input, key, mode);
        expect(event.defaultPrevented).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(editor.getJSON()).toEqual(beforeDocument);
        expect(editor.state.selection.eq(beforeSelection)).toBe(true);
        expect(document.activeElement).toBe(input);
      }
    }
  });

  it.each(['input[type="url"]', 'input[type="text"]'])("applies a link edit on normal Enter in %s", async (selector) => {
    const onClose = await renderEditableBubble();
    await changeInput(requiredInput(document, '.link-bubble-edit input[type="text"]'), "새 한글 이름");
    const input = requiredInput(document, `.link-bubble-edit ${selector}`);
    await act(async () => { input.focus(); });
    expect((await pressKey(input, "Enter")).defaultPrevented).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(editor.getText()).toBe("새 한글 이름");
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("closes link editing on normal Escape without applying the draft", async () => {
    const onClose = await renderEditableBubble();
    const input = requiredInput(document, '.link-bubble-edit input[type="text"]');
    await changeInput(input, "취소할 한글 이름");
    await act(async () => { input.focus(); });
    await pressKey(input, "Escape");
    expect(onClose).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe("이름");
  });
});
