// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hwanNote } from "../lib/tauriApi";
import { initialUpdateState, useUpdateStore } from "../stores/updateStore";
import UpdateToast from "./UpdateToast";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../lib/tauriApi", () => ({ hwanNote: { updater: {
  onStatus: vi.fn(), check: vi.fn(), download: vi.fn(),
} } }));

describe("update recovery controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let emit: Parameters<typeof hwanNote.updater.onStatus>[0];
  const onInstall = vi.fn();
  const unsubscribe = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    useUpdateStore.setState(initialUpdateState);
    vi.mocked(hwanNote.updater.onStatus).mockImplementation((callback) => {
      emit = callback;
      return unsubscribe;
    });
    onInstall.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<UpdateToast language="en" onInstall={onInstall} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
    container.remove();
    vi.useRealTimers();
  });

  async function status(value: Parameters<typeof emit>[0]) {
    await act(async () => emit(value));
  }

  async function click(text: string) {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.textContent === text);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  it("keeps a startup check failure visible and retries without restarting", async () => {
    await status({ status: "checking" });
    await status({ status: "error" });
    await act(async () => vi.advanceTimersByTime(6000));
    expect(container.textContent).toContain("Update check failed");
    vi.mocked(hwanNote.updater.check).mockImplementation(async () => emit({ status: "available", version: "9.0.0" }));
    await click("Try again");
    expect(hwanNote.updater.check).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("9.0.0");
  });

  it("retries the failed download and does not start a second pending request", async () => {
    await status({ status: "available", version: "9.0.0" });
    vi.mocked(hwanNote.updater.download).mockImplementationOnce(async () => emit({ status: "error" }));
    await click("Download");
    expect(container.textContent).toContain("Update download failed");
    let complete!: () => void;
    vi.mocked(hwanNote.updater.download).mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await click("Try again");
    // A terminal event may arrive before the IPC promise settles.
    await status({ status: "downloaded" });
    await act(async () => { await useUpdateStore.getState().download(); await useUpdateStore.getState().check(); });
    expect(hwanNote.updater.download).toHaveBeenCalledTimes(2);
    expect(hwanNote.updater.check).not.toHaveBeenCalled();
    await act(async () => { emit({ status: "downloaded" }); complete(); });
    expect(container.textContent).toContain("Update ready to install");
  });

  it("retries installation through the application's save guard", async () => {
    await status({ status: "downloaded" });
    onInstall.mockImplementationOnce(async () => emit({ status: "error" }));
    await click("Install & Restart");
    expect(container.textContent).toContain("Update installation failed");
    await click("Try again");
    expect(onInstall).toHaveBeenCalledTimes(2);
    // Returning from a cancelled save dialog keeps the downloaded update ready.
    expect(container.textContent).toContain("Update ready to install");
  });

  it("handles IPC rejection and a manual no-update result after dismissal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(hwanNote.updater.check).mockRejectedValueOnce(new Error("offline"));
    await act(async () => useUpdateStore.getState().check());
    expect(container.textContent).toContain("Update check failed");
    await click("Later");
    expect(container.textContent).toBe("");
    vi.mocked(hwanNote.updater.check).mockImplementationOnce(async () => emit({ status: "not-available" }));
    await act(async () => useUpdateStore.getState().check());
    expect(container.textContent).toContain("You are using the latest version");
    vi.restoreAllMocks();
  });

  it("shows installation IPC failures even without a backend status event", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await status({ status: "downloaded" });
    onInstall.mockRejectedValueOnce(new Error("IPC disconnected"));
    await click("Install & Restart");
    expect(container.textContent).toContain("Update installation failed");
    await click("Try again");
    expect(onInstall).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
