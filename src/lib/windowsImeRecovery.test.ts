// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isTauri: vi.fn(),
  getCurrentWindow: vi.fn(),
  onMoved: vi.fn(),
  onScaleChanged: vi.fn(),
  unlistenMoved: vi.fn(),
  unlistenScaleChanged: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: native.isTauri }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: native.getCurrentWindow }));

import { installWindowsImeRecovery } from "./windowsImeRecovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Windows WebView IME geometry recovery", () => {
  let editor: HTMLDivElement;
  let scrollParent: HTMLDivElement;
  let text: Text;
  let cleanup: (() => void) | undefined;
  let moved: () => void;
  let scaleChanged: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    native.isTauri.mockReset().mockReturnValue(true);
    native.getCurrentWindow.mockReset().mockReturnValue({
      onMoved: native.onMoved,
      onScaleChanged: native.onScaleChanged,
    });
    native.unlistenMoved.mockReset();
    native.unlistenScaleChanged.mockReset();
    native.onMoved.mockReset().mockImplementation((callback: () => void) => {
      moved = callback;
      return Promise.resolve(native.unlistenMoved);
    });
    native.onScaleChanged.mockReset().mockImplementation((callback: () => void) => {
      scaleChanged = callback;
      return Promise.resolve(native.unlistenScaleChanged);
    });
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    scrollParent = document.createElement("div");
    editor = document.createElement("div");
    editor.className = "note-editor";
    editor.setAttribute("contenteditable", "true");
    editor.tabIndex = 0;
    text = document.createTextNode("메모 입력 테스트");
    editor.appendChild(text);
    scrollParent.appendChild(editor);
    document.body.appendChild(scrollParent);
    editor.focus();
    window.getSelection()!.setBaseAndExtent(text, 6, text, 2);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function install() {
    cleanup = installWindowsImeRecovery();
    await Promise.resolve();
  }

  function resize() {
    window.dispatchEvent(new Event("resize"));
  }

  function windowBlur() {
    window.dispatchEvent(new FocusEvent("blur"));
  }

  function compose(type: "compositionstart" | "compositionend") {
    editor.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: "한" }));
  }

  function startBlurGap() {
    resize();
    vi.advanceTimersByTime(150);
    expect(document.activeElement).toBe(document.body);
  }

  function anotherControl() {
    const input = document.createElement("input");
    document.body.appendChild(input);
    return input;
  }

  it.each([
    { tauri: false, agent: "Windows NT 10.0" },
    { tauri: true, agent: "Macintosh" },
    { tauri: true, agent: "X11; Linux x86_64" },
  ])("does not install on tauri=$tauri and agent=$agent", async ({ tauri, agent }) => {
    native.isTauri.mockReturnValue(tauri);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    const blur = vi.spyOn(editor, "blur");
    await install();
    resize();
    vi.runAllTimers();
    expect(native.getCurrentWindow).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it("debounces DOM resize, native movement and DPI changes into one separate-task refocus", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    const focus = vi.spyOn(editor, "focus");
    resize();
    vi.advanceTimersByTime(100);
    moved();
    vi.advanceTimersByTime(100);
    scaleChanged();
    vi.advanceTimersByTime(149);
    expect(blur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    vi.runOnlyPendingTimers();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(document.activeElement).toBe(editor);
  });

  it("preserves reverse selection and ancestor scroll positions", async () => {
    await install();
    editor.scrollTop = 35;
    editor.scrollLeft = 7;
    scrollParent.scrollTop = 240;
    scrollParent.scrollLeft = 11;
    startBlurGap();
    window.getSelection()!.removeAllRanges();
    editor.scrollTop = 0;
    editor.scrollLeft = 0;
    scrollParent.scrollTop = 0;
    scrollParent.scrollLeft = 0;
    vi.runOnlyPendingTimers();
    const selection = window.getSelection()!;
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(6);
    expect(selection.focusNode).toBe(text);
    expect(selection.focusOffset).toBe(2);
    expect(editor.scrollTop).toBe(35);
    expect(editor.scrollLeft).toBe(7);
    expect(scrollParent.scrollTop).toBe(240);
    expect(scrollParent.scrollLeft).toBe(11);
  });

  it("never blurs during composition and waits for the final character flush after compositionend", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    compose("compositionstart");
    resize();
    moved();
    scaleChanged();
    vi.advanceTimersByTime(2_000);
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
    compose("compositionend");
    vi.advanceTimersByTime(149);
    expect(blur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(blur).toHaveBeenCalledTimes(1);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(editor);
  });

  it("postpones recovery while typing resumes after resizing", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    resize();
    vi.advanceTimersByTime(100);
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    vi.advanceTimersByTime(149);
    expect(blur).not.toHaveBeenCalled();
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    vi.advanceTimersByTime(149);
    expect(blur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(blur).toHaveBeenCalledTimes(1);
    vi.runOnlyPendingTimers();
  });

  it("cancels a scheduled blur when composition starts after resizing", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    resize();
    vi.advanceTimersByTime(149);
    compose("compositionstart");
    vi.advanceTimersByTime(2_000);
    expect(blur).not.toHaveBeenCalled();
  });

  it.each(["focus", "pointer", "window blur", "hidden", "disconnected", "document unfocused"])(
    "does not steal focus when %s occurs before the scheduled blur", async (reason) => {
      await install();
      const blur = vi.spyOn(editor, "blur");
      resize();
      if (reason === "focus") anotherControl().focus();
      if (reason === "pointer") document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      if (reason === "window blur") windowBlur();
      if (reason === "hidden") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }
      if (reason === "disconnected") editor.remove();
      if (reason === "document unfocused") vi.spyOn(document, "hasFocus").mockReturnValue(false);
      const activeElement = document.activeElement;
      vi.runAllTimers();
      expect(blur).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(activeElement);
    }
  );

  it.each(["focus", "pointer", "window blur", "hidden", "remounted", "document unfocused"])(
    "does not restore the old editor when %s occurs during the blur gap", async (reason) => {
      await install();
      startBlurGap();
      const focus = vi.spyOn(editor, "focus");
      if (reason === "focus") anotherControl().focus();
      if (reason === "pointer") document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      if (reason === "window blur") windowBlur();
      if (reason === "hidden") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }
      if (reason === "remounted") {
        const replacement = editor.cloneNode(true) as HTMLElement;
        editor.replaceWith(replacement);
        replacement.focus();
      }
      if (reason === "document unfocused") vi.spyOn(document, "hasFocus").mockReturnValue(false);
      const activeElement = document.activeElement;
      vi.runAllTimers();
      expect(focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(activeElement);
    }
  );

  it("finishes a pending refocus before handling typing in the blur gap", async () => {
    await install();
    startBlurGap();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(document.activeElement).toBe(editor);
    const blur = vi.spyOn(editor, "blur");
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
  });

  it("does not reclaim focus after another control was focused and then blurred in the gap", async () => {
    await install();
    startBlurGap();
    const focus = vi.spyOn(editor, "focus");
    const input = anotherControl();
    input.focus();
    input.blur();
    vi.runOnlyPendingTimers();
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not throw when a pending selection's text node changes before restoration", async () => {
    await install();
    startBlurGap();
    text.data = "짧음";
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(document.activeElement).toBe(editor);
  });

  it("restores pending focus when StrictMode disposes the effect and removes all listeners", async () => {
    await install();
    startBlurGap();
    cleanup!();
    cleanup = undefined;
    expect(document.activeElement).toBe(editor);
    expect(native.unlistenMoved).toHaveBeenCalledOnce();
    expect(native.unlistenScaleChanged).toHaveBeenCalledOnce();
    const blur = vi.spyOn(editor, "blur");
    resize();
    moved();
    scaleChanged();
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
  });

  it("disposes native subscriptions that resolve after cleanup", async () => {
    const lateMoved = deferred<() => void>();
    const lateScale = deferred<() => void>();
    native.onMoved.mockReturnValueOnce(lateMoved.promise);
    native.onScaleChanged.mockReturnValueOnce(lateScale.promise);
    await install();
    cleanup!();
    cleanup = undefined;
    lateMoved.resolve(native.unlistenMoved);
    lateScale.resolve(native.unlistenScaleChanged);
    await Promise.resolve();
    expect(native.unlistenMoved).toHaveBeenCalledOnce();
    expect(native.unlistenScaleChanged).toHaveBeenCalledOnce();
  });

  it("keeps DOM resize recovery available when native subscription fails", async () => {
    const failure = new Error("native event unavailable");
    native.onMoved.mockRejectedValueOnce(failure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await install();
    await Promise.resolve();
    expect(warning).toHaveBeenCalledWith("IME window event subscription failed", failure);
    startBlurGap();
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(editor);
  });
});
