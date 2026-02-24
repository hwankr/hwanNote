import { type KeyboardEvent, useState } from "react";
import { useI18n } from "../i18n/context";
import type { AppLanguage } from "../i18n/messages";
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
  editorLineHeight: number;
  tabSize: number;
  autoSaveDir: string;
  autoSaveDirIsDefault: boolean;
  onBrowseAutoSaveDir: () => void;
  onResetAutoSaveDir: () => void;
  shortcuts: ShortcutMap;
  onThemeModeChange: (mode: ThemeMode) => void;
  onEditorLineHeightChange: (value: number) => void;
  onTabSizeChange: (size: number) => void;
  onShortcutChange: (action: ShortcutAction, combo: ShortcutCombo) => ShortcutValidationResult;
  onResetShortcuts: () => void;
  onClose: () => void;
}

export default function SettingsPanel({
  open,
  themeMode,
  editorLineHeight,
  tabSize,
  autoSaveDir,
  autoSaveDirIsDefault,
  onBrowseAutoSaveDir,
  onResetAutoSaveDir,
  shortcuts,
  onThemeModeChange,
  onEditorLineHeightChange,
  onTabSizeChange,
  onShortcutChange,
  onResetShortcuts,
  onClose
}: SettingsPanelProps) {
  const { t, language, setLanguage } = useI18n();
  const [listeningAction, setListeningAction] = useState<ShortcutAction | null>(null);
  const [shortcutHint, setShortcutHint] = useState("");

  if (!open) {
    return null;
  }

  const startCapture = (action: ShortcutAction) => {
    setListeningAction(action);
    setShortcutHint(
      t("settings.shortcutCaptureStarted", {
        action: t(SHORTCUT_DEFINITIONS[action].labelKey)
      })
    );
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
        setShortcutHint(t("settings.shortcutUseModifier"));
        return;
      }

      const result = onShortcutChange(action, nextCombo);
      if (!result.ok && result.conflictAction) {
        setShortcutHint(
          t("settings.shortcutConflict", {
            combo: formatShortcut(nextCombo),
            action: t(SHORTCUT_DEFINITIONS[result.conflictAction].labelKey)
          })
        );
        return;
      }

      setListeningAction(null);
      setShortcutHint(
        t("settings.shortcutUpdated", {
          action: t(SHORTCUT_DEFINITIONS[action].labelKey),
          combo: formatShortcut(nextCombo)
        })
      );
    };

  const handleResetShortcuts = () => {
    onResetShortcuts();
    setListeningAction(null);
    setShortcutHint(t("settings.shortcutResetDone"));
  };

  return (
    <div className="settings-overlay no-drag" onClick={onClose}>
      <section className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <h2>{t("settings.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("settings.closeAria")}>
            {t("settings.close")}
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-item">
            <label htmlFor="theme-mode">{t("settings.themeMode")}</label>
            <select
              id="theme-mode"
              value={themeMode}
              onChange={(event) => onThemeModeChange(event.target.value as ThemeMode)}
            >
              <option value="light">{t("settings.themeLight")}</option>
              <option value="dark">{t("settings.themeDark")}</option>
              <option value="system">{t("settings.themeSystem")}</option>
            </select>
          </div>

          <div className="settings-item">
            <label htmlFor="language">{t("settings.language")}</label>
            <select
              id="language"
              value={language}
              onChange={(event) => setLanguage(event.target.value as AppLanguage)}
            >
              <option value="ko">{t("settings.languageKo")}</option>
              <option value="en">{t("settings.languageEn")}</option>
            </select>
          </div>

          <div className="settings-item">
            <label htmlFor="editor-line-height">{t("settings.lineSpacing")}</label>
            <div className="settings-range-row">
              <input
                id="editor-line-height"
                type="range"
                min={1.2}
                max={2.2}
                step={0.05}
                value={editorLineHeight}
                onChange={(event) => onEditorLineHeightChange(Number.parseFloat(event.target.value))}
              />
              <span className="settings-range-value">
                {editorLineHeight.toFixed(2)}
                x
              </span>
            </div>
            <div className="settings-subtext">{t("settings.lineSpacingHelp")}</div>
          </div>

          <div className="settings-item">
            <label htmlFor="tab-size">{t("settings.tabSize")}</label>
            <select
              id="tab-size"
              value={tabSize}
              onChange={(event) => onTabSizeChange(Number.parseInt(event.target.value, 10))}
            >
              <option value="2">2</option>
              <option value="4">4</option>
              <option value="8">8</option>
            </select>
            <div className="settings-subtext">{t("settings.tabSizeHelp")}</div>
          </div>

          <div className="settings-item">
            <label>{t("settings.autoSaveDir")}</label>
            <div className="settings-autosave-row">
              <div className="settings-readonly settings-autosave-path">
                {autoSaveDir || t("settings.autoSaveLoading")}
              </div>
              <button type="button" className="settings-autosave-btn" onClick={onBrowseAutoSaveDir}>
                {t("settings.autoSaveBrowse")}
              </button>
              {!autoSaveDirIsDefault && (
                <button
                  type="button"
                  className="settings-autosave-btn settings-autosave-reset"
                  onClick={onResetAutoSaveDir}
                >
                  {t("settings.autoSaveReset")}
                </button>
              )}
            </div>
            <div className="settings-subtext">{t("settings.autoSaveDirHelp")}</div>
          </div>

          <div className="settings-item">
            <label>{t("settings.shortcuts")}</label>
            <div className="settings-shortcut-help">{t("settings.shortcutHelp")}</div>

            {SHORTCUT_GROUPS.map((group) => (
              <div className="shortcut-group" key={group.labelKey}>
                <div className="shortcut-group-title">{t(group.labelKey)}</div>
                <div className="shortcut-list">
                  {group.actions.map((action) => {
                    const isListening = listeningAction === action;
                    const comboText = formatShortcut(shortcuts[action]);

                    return (
                      <div className="shortcut-row" key={action}>
                        <span className="shortcut-name">{t(SHORTCUT_DEFINITIONS[action].labelKey)}</span>
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
                          {isListening ? t("settings.shortcutPressKeys") : comboText}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <button type="button" className="shortcut-reset-btn" onClick={handleResetShortcuts}>
              {t("settings.resetShortcuts")}
            </button>

            <div className="settings-shortcut-hint">{shortcutHint || "\u00a0"}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
