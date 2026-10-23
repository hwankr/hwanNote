// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/context";
import FolderTree from "./FolderTree";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("folder name IME confirmation", () => {
  let root: Root;
  let container: HTMLDivElement;
  const actions = {
    onSelectFolder: vi.fn(), onCreateNote: vi.fn(), onCreateFolder: vi.fn(),
    onRenameFolder: vi.fn(), onDeleteFolder: vi.fn(), onMoveNoteToFolder: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<I18nProvider><FolderTree
      folders={["기존"]} selectedFolder={null} searchQuery="" actions={actions}
    /></I18nProvider>));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function start(mode: "create" | "rename") {
    if (mode === "create") {
      await act(async () => container.querySelector<HTMLButtonElement>(".sidebar-mini-btn")!.click());
    } else {
      await act(async () => container.querySelector(".folder-label")!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })));
      const rename = Array.from(document.querySelectorAll<HTMLButtonElement>(".context-menu button"))
        .find((button) => button.textContent?.includes("이름"))!;
      await act(async () => rename.click());
    }
    const input = container.querySelector<HTMLInputElement>(".folder-inline-input")!;
    input.value = "새 폴더";
    return input;
  }

  async function key(input: HTMLInputElement, key: string, extra: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
    await act(async () => input.dispatchEvent(event));
    return event;
  }

  describe.each(["create", "rename"] as const)("%s", (mode) => {
    it.each([
      { isComposing: true, keyCode: 13 },
      { isComposing: false, keyCode: 229 },
    ])("keeps the draft during composing Enter/Escape: %j", async (composition) => {
      const input = await start(mode);
      for (const pressed of ["Enter", "Escape"]) {
        expect((await key(input, pressed, composition)).defaultPrevented).toBe(false);
        expect(input.isConnected).toBe(true);
        expect(document.activeElement).toBe(input);
        expect(actions.onCreateFolder).not.toHaveBeenCalled();
        expect(actions.onRenameFolder).not.toHaveBeenCalled();
      }
      await key(input, "Enter");
      expect(input.isConnected).toBe(false);
      if (mode === "create") expect(actions.onCreateFolder).toHaveBeenCalledExactlyOnceWith("새 폴더");
      else expect(actions.onRenameFolder).toHaveBeenCalledExactlyOnceWith("기존", "새 폴더");
    });

    it("cancels a draft with ordinary Escape", async () => {
      const input = await start(mode);
      await key(input, "Escape");
      expect(input.isConnected).toBe(false);
      expect(actions.onCreateFolder).not.toHaveBeenCalled();
      expect(actions.onRenameFolder).not.toHaveBeenCalled();
    });
  });
});
