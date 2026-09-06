// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/context";
import { selectTodoRowsByGroup, useCalendarStore } from "../../stores/calendarStore";
import CalendarPage from "./CalendarPage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../lib/tauriApi", () => ({
  hwanNote: {
    calendar: {
      load: vi.fn().mockResolvedValue({
        status: "missing",
        loadedFrom: "local",
        cloudUnavailable: false,
        sourcePath: null,
      }),
      confirmLoaded: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

const TODAY = "2026-09-07";
const dueDateCases = [
  { group: "overdue", dueDate: "2026-09-06", title: "Overdue" },
  { group: "dueSoon", dueDate: "2026-09-07", title: "Due soon" },
  { group: "upcoming", dueDate: "2026-09-21", title: "Upcoming" },
] as const;
const composingCases = [
  { name: "isComposing", isComposing: true, keyCode: 13 },
  { name: "keyCode 229 fallback", isComposing: false, keyCode: 229 },
] as const;

describe("calendar task interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 7, 12));
    window.localStorage.clear();
    window.localStorage.setItem("hwan-note:language", "en");
    await useCalendarStore.getState().loadCalendarData();
    useCalendarStore.setState({
      selectedDate: TODAY,
      currentMonth: new Date(2026, 8, 1),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <CalendarPage onNavigateToNote={vi.fn()} weekStartsOn={1} />
        </I18nProvider>
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function element<T extends Element = HTMLElement>(selector: string, scope: ParentNode = container): T {
    const found = scope.querySelector<T>(selector);
    expect(found, `Expected ${selector} to exist`).not.toBeNull();
    return found!;
  }

  function click(target: HTMLElement) {
    act(() => target.click());
  }

  function setInput(input: HTMLInputElement, value: string) {
    act(() => {
      // Use the native setter so React sees an actual user input change.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function enter(input: HTMLInputElement, options: KeyboardEventInit = {}) {
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        ...options,
      }));
    });
  }

  function openAllTasks() {
    const allTab = Array.from(container.querySelectorAll<HTMLElement>(".calendar-view-switch [role=tab]"))
      .find((tab) => tab.textContent === "All tasks");
    expect(allTab).toBeDefined();
    click(allTab!);
  }

  function row(text: string): HTMLElement {
    const found = Array.from(container.querySelectorAll<HTMLElement>(".todo-item"))
      .find((item) => item.querySelector(".todo-text")?.textContent === text);
    expect(found, `Expected todo ${text} to be visible`).toBeDefined();
    return found!;
  }

  function addTask(text: string) {
    const input = element<HTMLInputElement>(".todo-add-input");
    setInput(input, text);
    enter(input);
  }

  function startEditing(text: string): HTMLInputElement {
    act(() => {
      element(".todo-text-button", row(text)).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    return element<HTMLInputElement>(".todo-edit-input");
  }

  function setDueDate(text: string, dueDate: string) {
    click(element(".todo-due-chip", row(text)));
    setInput(element<HTMLInputElement>(".todo-due-input", row(text)), dueDate);
    click(element(".todo-inline-btn.primary", row(text)));
  }

  function clearDueDate(text: string) {
    click(element(".todo-due-chip", row(text)));
    const clearButton = Array.from(row(text).querySelectorAll<HTMLElement>(".todo-inline-btn"))
      .find((button) => button.textContent === "Clear");
    expect(clearButton).toBeDefined();
    click(clearButton!);
  }

  it.each(dueDateCases)("keeps Inbox actions working after moving into $group", ({ group, dueDate, title }) => {
    openAllTasks();
    addTask("받은 할 일");
    const id = useCalendarStore.getState().data.inbox[0].id;
    setDueDate("받은 할 일", dueDate);

    expect(selectTodoRowsByGroup(useCalendarStore.getState(), { todayDateKey: TODAY })[group])
      .toEqual([expect.objectContaining({ id, isInbox: true, sourceDateKey: null, dueDateKey: dueDate })]);
    expect(row("받은 할 일").closest("section")?.querySelector("h4")?.textContent).toBe(title);
    expect(row("받은 할 일").querySelector(".todo-source-chip")).toBeNull();

    const editor = startEditing("받은 할 일");
    setInput(editor, "수정한 할 일");
    enter(editor);
    expect(useCalendarStore.getState().data.inbox[0].text).toBe("수정한 할 일");

    click(element(".todo-checkbox", row("수정한 할 일")));
    expect(useCalendarStore.getState().data.inbox[0]).toMatchObject({ done: true, completedAt: Date.now() });
    click(element(".done-section-toggle"));
    click(element(".todo-checkbox", row("수정한 할 일")));
    expect(useCalendarStore.getState().data.inbox[0].done).toBe(false);

    clearDueDate("수정한 할 일");
    expect(useCalendarStore.getState().data.inbox[0].dueDateKey).toBeNull();
    expect(row("수정한 할 일").closest(".calendar-inbox-section")).not.toBeNull();

    setDueDate("수정한 할 일", dueDate);
    click(element(".todo-delete-btn", row("수정한 할 일")));
    expect(useCalendarStore.getState().data.inbox).toEqual([]);
    expect(useCalendarStore.getState().data.todos).toEqual({});
    expect(container.querySelector(".todo-item")).toBeNull();
  });

  it("preserves dated task actions in the all-tasks view", () => {
    addTask("Dated task");
    openAllTasks();
    setDueDate("Dated task", "2026-09-06");
    expect(row("Dated task").querySelector(".todo-source-chip")).not.toBeNull();

    const editor = startEditing("Dated task");
    setInput(editor, "Updated dated task");
    enter(editor);
    expect(useCalendarStore.getState().data.todos[TODAY].items[0].text).toBe("Updated dated task");

    click(element(".todo-checkbox", row("Updated dated task")));
    expect(useCalendarStore.getState().data.todos[TODAY].items[0].done).toBe(true);
    click(element(".done-section-toggle"));
    click(element(".todo-checkbox", row("Updated dated task")));
    clearDueDate("Updated dated task");
    expect(useCalendarStore.getState().data.todos[TODAY].items[0].dueDateKey).toBeNull();
    click(element(".todo-delete-btn", row("Updated dated task")));
    expect(useCalendarStore.getState().data.todos).toEqual({});
    expect(useCalendarStore.getState().data.inbox).toEqual([]);
  });

  describe.each(composingCases)("Korean IME Enter using $name", ({ isComposing, keyCode }) => {
    it.each([
      { kind: "task", label: "Task" },
      { kind: "event", label: "Event" },
      { kind: "deadline", label: "Deadline" },
    ] as const)("keeps the day $kind draft until a subsequent non-composing Enter", ({ kind, label }) => {
      const kindButton = Array.from(container.querySelectorAll<HTMLElement>(".todo-kind-option"))
        .find((button) => button.textContent === label);
      expect(kindButton).toBeDefined();
      click(kindButton!);
      const input = element<HTMLInputElement>(".todo-add-input");
      setInput(input, "한글 할 일");
      enter(input, { isComposing, keyCode });
      expect(useCalendarStore.getState().data.todos).toEqual({});
      expect(input.value).toBe("한글 할 일");

      enter(input);
      expect(useCalendarStore.getState().data.todos[TODAY].items)
        .toEqual([expect.objectContaining({ text: "한글 할 일" })]);
      expect(useCalendarStore.getState().data.todos[TODAY].items[0].kind ?? "task").toBe(kind);
      expect(input.value).toBe("");
    });

    it("keeps the Inbox draft until a subsequent non-composing Enter", () => {
      openAllTasks();
      const input = element<HTMLInputElement>(".todo-add-input");
      setInput(input, "한글 Inbox");
      enter(input, { isComposing, keyCode });
      expect(useCalendarStore.getState().data.inbox).toEqual([]);
      expect(input.value).toBe("한글 Inbox");

      enter(input);
      expect(useCalendarStore.getState().data.inbox)
        .toEqual([expect.objectContaining({ text: "한글 Inbox" })]);
      expect(input.value).toBe("");
    });

    it("keeps the edit open and unsaved until a subsequent non-composing Enter", () => {
      addTask("기존 할 일");
      const editor = startEditing("기존 할 일");
      setInput(editor, "수정 중인 한글");
      enter(editor, { isComposing, keyCode });
      expect(useCalendarStore.getState().data.todos[TODAY].items[0].text).toBe("기존 할 일");
      expect(container.querySelector(".todo-edit-input")).toBe(editor);
      expect(editor.value).toBe("수정 중인 한글");

      enter(editor);
      expect(useCalendarStore.getState().data.todos[TODAY].items[0].text).toBe("수정 중인 한글");
      expect(container.querySelector(".todo-edit-input")).toBeNull();
      expect(row("수정 중인 한글")).toBeDefined();
    });
  });
});
