// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideNavigationIntent,
  layoutFocusPermission,
  type LayoutFocusView,
  type NavigationCommitFacts,
  type NavigationIntent,
  type NavigationTarget
} from "./layoutFocusPolicy";

type TestView = { dom: HTMLElement; composing: boolean };

function editorView(composing = false): TestView {
  const dom = document.createElement("div");
  dom.className = "note-editor";
  dom.contentEditable = "true";
  dom.setAttribute("contenteditable", "true");
  dom.tabIndex = 0;
  dom.innerHTML = '<p>text</p><ul><li><label contenteditable="false"><input type="checkbox"></label><p>task</p></li></ul>';
  document.body.appendChild(dom);
  const view: TestView = { dom, composing };
  return view;
}

function intentFrom(sourceElement: Element | null, targetOrOperation: NavigationTarget = { kind: "target", tabId: "b" }): NavigationIntent {
  return { sourceElement, targetOrOperation, applied: true };
}

function add<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, parent: Element = document.body) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  parent.appendChild(element);
  return element;
}

function focus(element: HTMLElement) {
  element.focus();
  expect(document.activeElement).toBe(element);
}

describe("layoutFocusPermission", () => {
  let target: ReturnType<typeof editorView>;
  let other: ReturnType<typeof editorView>;

  beforeEach(() => {
    target = editorView();
    other = editorView();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  function permission(intent: NavigationIntent | null = null, eligible = true, registered: LayoutFocusView[] = [target, other]) {
    return layoutFocusPermission({ eligible, target, registered, intent });
  }

  it("denies a request that is not eligible, even with focus on the page", () => {
    expect(document.activeElement).toBe(document.body);
    expect(permission(intentFrom(document.body), false)).toBe("deny");
  });

  it("allows when focus is on the page", () => {
    expect(permission()).toBe("allow");
  });

  it("allows when another registered editor root has focus", () => {
    focus(other.dom);
    expect(permission()).toBe("allow");
  });

  it("denies when the focused other editor is composing, even for a navigation started there", () => {
    other.composing = true;
    focus(other.dom);
    expect(permission(intentFrom(other.dom))).toBe("deny");
  });

  it("reports already-focused for the target root, composing or not", () => {
    focus(target.dom);
    expect(permission()).toBe("already-focused");
    target.composing = true;
    expect(permission()).toBe("already-focused");
  });

  it("does not treat an editor element that is not registered as editor focus", () => {
    focus(other.dom);
    // `other` is not registered: its root is just contenteditable content.
    expect(permission(intentFrom(other.dom), true, [target])).toBe("deny");
  });

  it.each([
    ["input", () => add("input")],
    ["textarea", () => add("textarea")],
    ["select", () => add("select")],
    ["contenteditable outside the editors", () => add("div", { contenteditable: "true", tabindex: "0" })],
    ["plaintext-only contenteditable", () => add("div", { contenteditable: "plaintext-only", tabindex: "0" })],
  ])("keeps focus in a text control (%s), even for a navigation started there", (_name, create) => {
    const control = create();
    focus(control);
    expect(permission()).toBe("deny");
    expect(permission(intentFrom(control))).toBe("deny");
  });

  it("counts a checkbox inside the target editor as a control of its own, not as editor focus", () => {
    const checkbox = target.dom.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    focus(checkbox);
    expect(permission()).toBe("deny");
    expect(permission(intentFrom(checkbox))).toBe("deny");
  });

  it("does not count a button inside another editor as that editor's focus", () => {
    const button = add("button", {}, other.dom.querySelector("p")!);
    focus(button);
    expect(permission()).toBe("deny");
  });

  it.each([
    ["an open dialog", () => add("dialog", { open: "" })],
    ["role=dialog", () => add("div", { role: "dialog" })],
    ["role=alertdialog", () => add("div", { role: "alertdialog" })],
    ["aria-modal=true", () => add("div", { "aria-modal": "true" })],
    ["a hidden role=dialog", () => add("div", { role: "dialog", hidden: "" })],
  ])("keeps focus in %s, even for a navigation started there", (_name, createDialog) => {
    const button = add("button", {}, createDialog());
    focus(button);
    expect(permission()).toBe("deny");
    expect(permission(intentFrom(button))).toBe("deny");
  });

  const dialogAncestors = [
    ["an open dialog", () => add("dialog", { open: "" })],
    ["role=dialog", () => add("div", { role: "dialog" })],
    ["role=alertdialog", () => add("div", { role: "alertdialog" })],
    ["aria-modal=true", () => add("div", { "aria-modal": "true" })],
  ] as const;

  it.each(dialogAncestors)("keeps focus on another registered editor root inside %s, even for a navigation started there", (_name, createDialog) => {
    createDialog().appendChild(other.dom);
    focus(other.dom);
    expect(permission()).toBe("deny");
    expect(permission(intentFrom(other.dom))).toBe("deny");
  });

  it.each(dialogAncestors)("denies, without moving focus, when the target root inside %s already has focus", (_name, createDialog) => {
    createDialog().appendChild(target.dom);
    focus(target.dom);
    // Rule 2 (dialog) comes before rule 4 (already focused). Both end the request untouched.
    expect(permission()).toBe("deny");
    expect(document.activeElement).toBe(target.dom);
  });

  it.each([
    ["role=alert", { role: "alert" }],
    ["role=status", { role: "status" }],
    ["a dialog element that is not open", null],
  ])("treats a button in %s as an ordinary control", (_name, attributes) => {
    const parent = attributes ? add("section", attributes) : add("dialog");
    const button = add("button", {}, parent);
    focus(button);
    expect(permission()).toBe("deny");
    expect(permission(intentFrom(button))).toBe("allow");
  });

  it.each([
    ["a button", () => add("button")],
    ["a treeitem", () => add("div", { role: "treeitem", tabindex: "0" })],
    ["a menu item", () => add("div", { role: "menuitem", tabindex: "-1" }, add("div", { role: "menu" }))],
    ["a non-editable element with tabindex", () => add("div", { contenteditable: "false", tabindex: "0" })],
    ["a tab in the title bar's tab strip", () => {
      const tabs = add("div", { class: "tabs" }, add("header", { class: "titlebar" }));
      return add("button", { class: "tab", "data-tab-id": "b" }, tabs);
    }],
  ])("keeps focus in %s unless the navigation started there", (_name, create) => {
    const control = create();
    focus(control);
    const elsewhere = add("button");
    expect(permission()).toBe("deny");
    expect(permission(intentFrom(elsewhere))).toBe("deny");
    expect(permission(intentFrom(document.body))).toBe("deny");
    expect(permission(intentFrom(control))).toBe("allow");
  });
});

describe("decideNavigationIntent", () => {
  const base: NavigationCommitFacts = {
    layoutChanged: true,
    notesVisible: true,
    openTabIds: ["a", "b", "c"],
    focusedTabId: "b",
    previousPaneTabIds: ["a", "b"],
  };
  const target = (tabId: string, applied = true): NavigationIntent =>
    ({ sourceElement: null, targetOrOperation: { kind: "target", tabId }, applied });
  const close = (tabIds: string[], applied = true): NavigationIntent =>
    ({ sourceElement: null, targetOrOperation: { kind: "close", tabIds }, applied });

  it("discards any intent once the notes view is hidden or settings open", () => {
    expect(decideNavigationIntent(target("b"), { ...base, notesVisible: false })).toBe("discard");
    expect(decideNavigationIntent(close(["a"], false), { ...base, notesVisible: false })).toBe("discard");
  });

  it("discards a target that is no longer open, and a close that left no tab", () => {
    expect(decideNavigationIntent(target("d"), base)).toBe("discard");
    expect(decideNavigationIntent(target("d", false), base)).toBe("discard");
    expect(decideNavigationIntent(close(["a"]), { ...base, openTabIds: [], focusedTabId: null })).toBe("discard");
  });

  it("keeps an intent that is not applied yet, whatever the layout does", () => {
    expect(decideNavigationIntent(target("b", false), base)).toBe("keep");
    expect(decideNavigationIntent(close(["b"], false), { ...base, openTabIds: ["a", "c"], focusedTabId: "a" })).toBe("keep");
  });

  it("consumes a target once the focused pane shows it", () => {
    expect(decideNavigationIntent(target("b"), base)).toBe("consume");
  });

  it("discards a target whose commit left the layout unchanged, or showed another tab", () => {
    expect(decideNavigationIntent(target("b"), { ...base, layoutChanged: false })).toBe("discard");
    expect(decideNavigationIntent(target("c"), base)).toBe("discard");
  });

  it("keeps a target while the focused pane has no editor", () => {
    expect(decideNavigationIntent(target("b"), { ...base, focusedTabId: null })).toBe("keep");
  });

  it("consumes a close at the layout change that closing a shown tab made, once a pane is focused", () => {
    const closed = { ...base, openTabIds: ["a", "c"], previousPaneTabIds: ["a", "b"] };
    expect(decideNavigationIntent(close(["b"]), { ...closed, focusedTabId: null })).toBe("keep");
    // The pane normalization right after: the panes still named the closed tab.
    expect(decideNavigationIntent(close(["b"]), { ...closed, focusedTabId: "a" })).toBe("consume");
  });

  it("keeps a close through commits its closing did not change", () => {
    // Its tab is still open, or was never shown, or nothing changed.
    expect(decideNavigationIntent(close(["b"]), base)).toBe("keep");
    expect(decideNavigationIntent(close(["c"]), { ...base, openTabIds: ["a", "b"] })).toBe("keep");
    expect(decideNavigationIntent(close(["b"]), { ...base, openTabIds: ["a", "c"], layoutChanged: false })).toBe("keep");
  });
});
