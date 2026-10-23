// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/context";
import { createEmptyCalendarData, serializeCalendarData } from "../../lib/calendarData";
import { useCalendarStore } from "../../stores/calendarStore";
import CalendarPage from "./CalendarPage";

const api = vi.hoisted(() => ({
  load: vi.fn(), confirmLoaded: vi.fn(), save: vi.fn(), preserveRecoveryCopy: vi.fn(),
  message: vi.fn(), reset: vi.fn(),
}));
vi.mock("../../lib/tauriApi", () => ({ hwanNote: { calendar: api } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: api.message, confirm: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("calendar conflict recovery UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    window.localStorage.setItem("hwan-note:language", "en");
    api.load.mockResolvedValue({
      status: "ok", data: serializeCalendarData(createEmptyCalendarData()),
      loadedFrom: "cloud", cloudUnavailable: false, sourcePath: "C:\\cloud\\calendar.json",
    });
    api.confirmLoaded.mockResolvedValue(undefined);
    api.preserveRecoveryCopy.mockResolvedValue("C:\\local\\calendar.local-recovery.bak");
    useCalendarStore.setState({ loadState: "idle", storageTransitionInProgress: false, recoveryCopyPath: null });
    await useCalendarStore.getState().loadCalendarData();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(
      <I18nProvider><CalendarPage onNavigateToNote={vi.fn()} weekStartsOn={1} /></I18nProvider>
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function triggerConflict() {
    api.save.mockRejectedValueOnce("CALENDAR_CONFLICT: another device changed the file");
    await act(async () => {
      useCalendarStore.getState().createInboxTodo("my unsaved edit");
      await useCalendarStore.getState().saveCalendarData();
    });
  }

  it("shows the preserved draft and reloads the remote version through the safe recovery action", async () => {
    await triggerConflict();
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.textContent).toContain("C:\\local\\calendar.local-recovery.bak");
    expect(container.querySelector(".calendar-recovery-reset")).toBeNull();
    const reload = container.querySelector<HTMLButtonElement>(".calendar-recovery-actions button")!;
    expect(reload.textContent).toBe("Keep a copy and reload");
    await act(async () => reload.click());
    expect(useCalendarStore.getState().loadState).toBe("ready");
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(api.preserveRecoveryCopy).toHaveBeenLastCalledWith(expect.stringContaining("my unsaved edit"));
    expect(api.message).toHaveBeenCalledWith(expect.stringContaining("C:\\local\\calendar.local-recovery.bak"), expect.objectContaining({ kind: "info" }));
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it("keeps the recovery screen and local edits when a recovery copy cannot be written", async () => {
    api.preserveRecoveryCopy.mockRejectedValue(new Error("local disk full"));
    await triggerConflict();
    const draft = useCalendarStore.getState().data;
    await act(async () => container.querySelector<HTMLButtonElement>(".calendar-recovery-actions button")!.click());
    expect(useCalendarStore.getState().loadState).toBe("conflict");
    expect(useCalendarStore.getState().data).toBe(draft);
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(api.message).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: "error" }));
    expect(container.querySelector("[role=alert]")).not.toBeNull();
  });
});
