import { type KeyboardEvent, useState } from "react";
import {
  SHORTCUT_DEFINITIONS,
  SHORTCUT_GROUPS,
  formatShortcut,
  shortcutFromKeyboardEvent,
  type ShortcutAction,
  type ShortcutCombo,
  type ShortcutMap,
  type ShortcutValidationResult
} from "../lib/shortcuts";

export type ThemeMode = "light" | "dark" | "system";

interface SettingsPanelProps {
  open: boolean;
  themeMode: ThemeMode;
  autoSaveDir: string;
  shortcuts: ShortcutMap;
  onThemeModeChange: (mode: ThemeMode) => void;
  onShortcutChange: (action: ShortcutAction, combo: ShortcutCombo) => ShortcutValidationResult;
  onResetShortcuts: () => void;
  onClose: () => void;
}

export default function SettingsPanel({
  open,
  themeMode,
  autoSaveDir,
  shortcuts,
  onThemeModeChange,
  onShortcutChange,
  onResetShortcuts,
  onClose
}: SettingsPanelProps) {
  const [listeningAction, setListeningAction] = useState<ShortcutAction | null>(null);
  const [shortcutHint, setShortcutHint] = useState("");

  if (!open) {
    return null;
  }

  const startCapture = (action: ShortcutAction) => {
    setListeningAction(action);
    setShortcutHint(`Press a new shortcut for "${SHORTCUT_DEFINITIONS[action].label}". (Esc to cancel)`);
  };

  const handleShortcutKeyDown =
    (action: ShortcutAction) => (event: KeyboardEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setListeningAction(null);
        setShortcutHint("");
        return;
      }

      const nextCombo = shortcutFromKeyboardEvent(event.nativeEvent);
      if (!nextCombo) {
        setShortcutHint("Use Ctrl/Cmd or Alt with another key.");
        return;
      }

      const result = onShortcutChange(action, nextCombo);
      if (!result.ok && result.conflictAction) {
        setShortcutHint(
          `"${formatShortcut(nextCombo)}" is already used by "${SHORTCUT_DEFINITIONS[result.conflictAction].label}".`
        );
        return;
      }

      setListeningAction(null);
      setShortcutHint(`Updated: ${SHORTCUT_DEFINITIONS[action].label} -> ${formatShortcut(nextCombo)}`);
    };

  const handleResetShortcuts = () => {
    onResetShortcuts();
    setListeningAction(null);
    setShortcutHint("All shortcuts restored to default values.");
  };

  return (
    <div className="settings-overlay no-drag" onClick={onClose}>
      <section className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-item">
            <label htmlFor="theme-mode">Theme Mode</label>
            <select
              id="theme-mode"
              value={themeMode}
              onChange={(event) => onThemeModeChange(event.target.value as ThemeMode)}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">Use System</option>
            </select>
          </div>

          <div className="settings-item">
            <label>Auto-save Directory</label>
            <div className="settings-readonly">{autoSaveDir || "Checking..."}</div>
          </div>

          <div className="settings-item">
            <label>Keyboard Shortcuts</label>
            <div className="settings-shortcut-help">
              Click a shortcut, press a new key combo, then release keys. Esc cancels capture.
            </div>

            {SHORTCUT_GROUPS.map((group) => (
              <div className="shortcut-group" key={group.label}>
                <div className="shortcut-group-title">{group.label}</div>
                <div className="shortcut-list">
                  {group.actions.map((action) => {
                    const isListening = listeningAction === action;
                    const comboText = formatShortcut(shortcuts[action]);

                    return (
                      <div className="shortcut-row" key={action}>
                        <span className="shortcut-name">{SHORTCUT_DEFINITIONS[action].label}</span>
                        <button
                          type="button"
                          className={`shortcut-capture${isListening ? " listening" : ""}`}
                          data-shortcut-capture="true"
                          onClick={() => startCapture(action)}
                          onKeyDown={isListening ? handleShortcutKeyDown(action) : undefined}
                          onBlur={() => {
                            if (listeningAction === action) {
                              setListeningAction(null);
                            }
                          }}
                        >
                          {isListening ? "Press keys..." : comboText}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <button type="button" className="shortcut-reset-btn" onClick={handleResetShortcuts}>
              Reset Shortcuts
            </button>

            <div className="settings-shortcut-hint">{shortcutHint || "\u00a0"}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
