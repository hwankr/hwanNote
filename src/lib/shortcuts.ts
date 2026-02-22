import type { TranslationKey } from "../i18n/messages";

export type ShortcutContext = "global" | "editor" | "non-editor";

export type ShortcutAction =
  | "toggleSidebar"
  | "nextTab"
  | "prevTab"
  | "saveNote"
  | "newNote"
  | "closeTab"
  | "toggleBold"
  | "toggleItalic"
  | "toggleChecklist"
  | "insertToggleBlock";

export interface ShortcutCombo {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export type ShortcutMap = Record<ShortcutAction, ShortcutCombo>;

export interface ShortcutDefinition {
  labelKey: TranslationKey;
  context: ShortcutContext;
  defaultCombo: ShortcutCombo;
}

export interface ShortcutValidationResult {
  ok: boolean;
  conflictAction?: ShortcutAction;
}

export interface ShortcutGroup {
  labelKey: TranslationKey;
  actions: ShortcutAction[];
}

const SPECIAL_KEY_MAP: Record<string, string> = {
  escape: "esc",
  esc: "esc",
  tab: "tab",
  enter: "enter",
  " ": "space",
  spacebar: "space",
  space: "space",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right"
};

const DISPLAY_KEY_MAP: Record<string, string> = {
  esc: "Esc",
  tab: "Tab",
  enter: "Enter",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right"
};

const MODIFIER_KEYS = new Set(["control", "alt", "shift", "meta"]);

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  "toggleSidebar",
  "nextTab",
  "prevTab",
  "saveNote",
  "newNote",
  "closeTab",
  "toggleBold",
  "toggleItalic",
  "toggleChecklist",
  "insertToggleBlock"
];

export const SHORTCUT_DEFINITIONS: Record<ShortcutAction, ShortcutDefinition> = {
  toggleSidebar: {
    labelKey: "shortcut.action.toggleSidebar",
    context: "non-editor",
    defaultCombo: { mod: true, alt: false, shift: false, key: "b" }
  },
  nextTab: {
    labelKey: "shortcut.action.nextTab",
    context: "global",
    defaultCombo: { mod: true, alt: false, shift: false, key: "tab" }
  },
  prevTab: {
    labelKey: "shortcut.action.prevTab",
    context: "global",
    defaultCombo: { mod: true, alt: false, shift: true, key: "tab" }
  },
  saveNote: {
    labelKey: "shortcut.action.saveNote",
    context: "global",
    defaultCombo: { mod: true, alt: false, shift: false, key: "s" }
  },
  newNote: {
    labelKey: "shortcut.action.newNote",
    context: "global",
    defaultCombo: { mod: true, alt: false, shift: false, key: "n" }
  },
  closeTab: {
    labelKey: "shortcut.action.closeTab",
    context: "global",
    defaultCombo: { mod: true, alt: false, shift: false, key: "w" }
  },
  toggleBold: {
    labelKey: "shortcut.action.toggleBold",
    context: "editor",
    defaultCombo: { mod: true, alt: false, shift: false, key: "b" }
  },
  toggleItalic: {
    labelKey: "shortcut.action.toggleItalic",
    context: "editor",
    defaultCombo: { mod: true, alt: false, shift: false, key: "i" }
  },
  toggleChecklist: {
    labelKey: "shortcut.action.toggleChecklist",
    context: "editor",
    defaultCombo: { mod: true, alt: false, shift: true, key: "x" }
  },
  insertToggleBlock: {
    labelKey: "shortcut.action.insertToggleBlock",
    context: "editor",
    defaultCombo: { mod: true, alt: false, shift: true, key: "t" }
  }
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    labelKey: "shortcut.group.app",
    actions: ["toggleSidebar", "nextTab", "prevTab", "saveNote", "newNote", "closeTab"]
  },
  {
    labelKey: "shortcut.group.editor",
    actions: ["toggleBold", "toggleItalic", "toggleChecklist", "insertToggleBlock"]
  }
];

function normalizeShortcutKey(key: string) {
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length === 1) {
    return trimmed.toLowerCase();
  }

  const lowered = trimmed.toLowerCase();
  return SPECIAL_KEY_MAP[lowered] ?? lowered;
}

function isShortcutCombo(value: unknown): value is ShortcutCombo {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ShortcutCombo>;
  if (
    typeof candidate.mod !== "boolean" ||
    typeof candidate.alt !== "boolean" ||
    typeof candidate.shift !== "boolean" ||
    typeof candidate.key !== "string"
  ) {
    return false;
  }

  const normalizedKey = normalizeShortcutKey(candidate.key);
  if (!normalizedKey || MODIFIER_KEYS.has(normalizedKey)) {
    return false;
  }

  if (!candidate.mod && !candidate.alt) {
    return false;
  }

  return true;
}

function cloneCombo(combo: ShortcutCombo): ShortcutCombo {
  return {
    mod: combo.mod,
    alt: combo.alt,
    shift: combo.shift,
    key: combo.key
  };
}

function contextsOverlap(left: ShortcutContext, right: ShortcutContext) {
  if (left === "global" || right === "global") {
    return true;
  }

  return left === right;
}

export function createDefaultShortcuts(): ShortcutMap {
  return SHORTCUT_ACTIONS.reduce<ShortcutMap>((acc, action) => {
    acc[action] = cloneCombo(SHORTCUT_DEFINITIONS[action].defaultCombo);
    return acc;
  }, {} as ShortcutMap);
}

export function parseShortcutMap(raw: unknown): ShortcutMap {
  const defaults = createDefaultShortcuts();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const source = raw as Partial<Record<ShortcutAction, unknown>>;

  SHORTCUT_ACTIONS.forEach((action) => {
    const value = source[action];
    if (!isShortcutCombo(value)) {
      return;
    }

    defaults[action] = {
      mod: value.mod,
      alt: value.alt,
      shift: value.shift,
      key: normalizeShortcutKey(value.key) ?? value.key
    };
  });

  return defaults;
}

export function formatShortcut(combo: ShortcutCombo) {
  const parts: string[] = [];
  if (combo.mod) {
    parts.push("Ctrl/Cmd");
  }
  if (combo.alt) {
    parts.push("Alt");
  }
  if (combo.shift) {
    parts.push("Shift");
  }

  const displayKey =
    DISPLAY_KEY_MAP[combo.key] ??
    (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key.toUpperCase());

  parts.push(displayKey);
  return parts.join("+");
}

export function areShortcutCombosEqual(left: ShortcutCombo, right: ShortcutCombo) {
  return left.mod === right.mod && left.alt === right.alt && left.shift === right.shift && left.key === right.key;
}

export function validateShortcutAssignment(
  action: ShortcutAction,
  combo: ShortcutCombo,
  current: ShortcutMap
): ShortcutValidationResult {
  for (const otherAction of SHORTCUT_ACTIONS) {
    if (otherAction === action) {
      continue;
    }

    if (!areShortcutCombosEqual(combo, current[otherAction])) {
      continue;
    }

    const leftContext = SHORTCUT_DEFINITIONS[action].context;
    const rightContext = SHORTCUT_DEFINITIONS[otherAction].context;
    if (contextsOverlap(leftContext, rightContext)) {
      return {
        ok: false,
        conflictAction: otherAction
      };
    }
  }

  return { ok: true };
}

export function isContextMatch(context: ShortcutContext, isEditorFocus: boolean) {
  if (context === "editor") {
    return isEditorFocus;
  }

  if (context === "non-editor") {
    return !isEditorFocus;
  }

  return true;
}

type ShortcutKeyboardEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent): ShortcutCombo | null {
  const normalizedKey = normalizeShortcutKey(event.key);
  if (!normalizedKey || MODIFIER_KEYS.has(normalizedKey)) {
    return null;
  }

  const nextCombo: ShortcutCombo = {
    mod: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    key: normalizedKey
  };

  if (!nextCombo.mod && !nextCombo.alt) {
    return null;
  }

  return nextCombo;
}

export function matchesShortcut(event: KeyboardEvent, combo: ShortcutCombo) {
  const normalizedKey = normalizeShortcutKey(event.key);
  if (!normalizedKey) {
    return false;
  }

  return (
    normalizedKey === combo.key &&
    (event.ctrlKey || event.metaKey) === combo.mod &&
    event.altKey === combo.alt &&
    event.shiftKey === combo.shift
  );
}
