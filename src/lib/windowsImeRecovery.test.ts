// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isTauri: vi.fn(),
  getCurrentWindow: vi.fn(),
  onMoved: vi.fn(),
  onScaleChanged: vi.fn(),
  outerPosition: vi.fn(),
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
  let movedListener: (event: { payload: { x: number; y: number } }) => void;
  let nextWindowX: number;
  let scaleChanged: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    native.isTauri.mockReset().mockReturnValue(true);
    native.getCurrentWindow.mockReset().mockReturnValue({
      onMoved: native.onMoved,
      onScaleChanged: native.onScaleChanged,
      outerPosition: native.outerPosition,
    });
    native.outerPosition.mockReset().mockResolvedValue({ x: 100, y: 100 });
    nextWindowX = 100;
    native.unlistenMoved.mockReset();
    native.unlistenScaleChanged.mockReset();
    native.onMoved.mockReset().mockImplementation((callback: typeof movedListener) => {
      movedListener = callback;
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
    // Let the initial window position and native subscriptions settle.
    for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
  }

  // By default every notification reports a new position, i.e. a real move.
  function moved(position = { x: (nextWindowX += 40), y: 100 }) {
    movedListener({ payload: position });
  }

  function keyDown(key: string) {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  function expectSelectionRestored() {
    const selection = window.getSelection()!;
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(6);
    expect(selection.focusNode).toBe(text);
    expect(selection.focusOffset).toBe(2);
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

  it("ignores geometry changes during composition and never blurs after compositionend", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    compose("compositionstart");
    resize();
    moved();
    scaleChanged();
    vi.advanceTimersByTime(2_000);
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
    // The next syllable usually follows after a short pause; that pause is still typing.
    compose("compositionend");
    vi.advanceTimersByTime(5_000);
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it("cancels the refresh instead of postponing it when typing resumes after a geometry change", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    resize();
    vi.advanceTimersByTime(100);
    keyDown("a");
    vi.advanceTimersByTime(149);
    keyDown("b");
    // A pause between words must never become the moment the editor is blurred.
    vi.advanceTimersByTime(5_000);
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it("treats text inserted without a key press as typing", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    moved();
    editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "가" }));
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it("does not refresh when the geometry changes shortly after typing", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    keyDown("a");
    vi.advanceTimersByTime(500);
    moved();
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);

    // After a quiet period the same kind of change refreshes the anchor again.
    vi.advanceTimersByTime(1_000);
    moved();
    vi.advanceTimersByTime(150);
    expect(blur).toHaveBeenCalledTimes(1);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(editor);
  });

  it("still refreshes after modifier-only keys such as a keyboard window snap", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    keyDown("Meta");
    keyDown("Shift");
    moved();
    vi.advanceTimersByTime(150);
    expect(blur).toHaveBeenCalledTimes(1);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(editor);
    expectSelectionRestored();
  });

  it("ignores native move notifications that do not change the window position", async () => {
    await install();
    const blur = vi.spyOn(editor, "blur");
    moved({ x: 100, y: 100 });
    vi.runAllTimers();
    moved({ x: 100, y: 100 });
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);

    moved({ x: 1_920, y: 100 });
    vi.advanceTimersByTime(150);
    expect(blur).toHaveBeenCalledTimes(1);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(editor);
  });

  it("does not treat the first move notification as movement when the start position is unknown", async () => {
    const failure = new Error("position unavailable");
    native.outerPosition.mockRejectedValueOnce(failure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await install();
    expect(warning).toHaveBeenCalledWith("IME window position unavailable", failure);
    const blur = vi.spyOn(editor, "blur");
    moved({ x: 100, y: 100 });
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
    moved({ x: 140, y: 100 });
    vi.advanceTimersByTime(150);
    expect(blur).toHaveBeenCalledTimes(1);
    vi.runOnlyPendingTimers();
    expect(document.activeElement).toBe(editor);
  });

  it("keeps the newer position when a move notification arrives before the start position", async () => {
    const start = deferred<{ x: number; y: number }>();
    native.outerPosition.mockReturnValueOnce(start.promise);
    await install();
    const blur = vi.spyOn(editor, "blur");
    moved({ x: 1_920, y: 100 });
    start.resolve({ x: 100, y: 100 });
    await Promise.resolve();
    await Promise.resolve();
    moved({ x: 1_920, y: 100 });
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
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

  it.each(["focus", "window blur", "hidden", "remounted", "document unfocused"])(
    "does not restore the old editor when %s occurs during the blur gap", async (reason) => {
      await install();
      startBlurGap();
      const focus = vi.spyOn(editor, "focus");
      if (reason === "focus") anotherControl().focus();
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

  it.each(["window blur", "hidden", "document unfocused"])(
    "refocuses the editor when the window becomes active again after %s in the blur gap", async (reason) => {
      await install();
      startBlurGap();
      window.getSelection()!.removeAllRanges();
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
      const visibility = vi.spyOn(document, "visibilityState", "get");
      if (reason === "window blur") windowBlur();
      if (reason === "hidden") {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }
      vi.runAllTimers();
      expect(document.activeElement).toBe(document.body);

      if (reason === "hidden") {
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
        expect(document.activeElement).toBe(document.body);
      }
      hasFocus.mockReturnValue(true);
      window.dispatchEvent(new FocusEvent("focus"));
      expect(document.activeElement).toBe(editor);
      expectSelectionRestored();
      const blur = vi.spyOn(editor, "blur");
      vi.runAllTimers();
      expect(blur).not.toHaveBeenCalled();
    }
  );

  it("does not refocus on the window's return after another control took focus", async () => {
    await install();
    startBlurGap();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    windowBlur();
    const input = anotherControl();
    input.focus();
    window.dispatchEvent(new FocusEvent("focus"));
    expect(document.activeElement).toBe(input);
  });

  it("puts focus back before handling a pointer press in the blur gap", async () => {
    await install();
    startBlurGap();
    window.getSelection()!.removeAllRanges();
    // The browser's own pointer handling runs afterwards and moves focus to the
    // pressed control, exactly as if the editor had never been blurred.
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.activeElement).toBe(editor);
    expectSelectionRestored();
    const blur = vi.spyOn(editor, "blur");
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

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
