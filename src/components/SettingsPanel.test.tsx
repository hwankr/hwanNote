// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/context";
import { createDefaultShortcuts } from "../lib/shortcuts";
import type { AutoSaveDirInfo } from "../lib/tauriApi";
import SettingsPanel from "./SettingsPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unavailableInfo: AutoSaveDirInfo = {
  customDir: "Z:/Detached/HwanNote",
  effectiveDir: null,
  isDefault: false,
  status: "unavailable",
  expectedDir: "Z:/Detached/HwanNote",
  error: "custom_auto_save_dir_unavailable",
};

describe("SettingsPanel custom storage status", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(language: "ko" | "en") {
    window.localStorage.setItem("hwan-note:language", language);
    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsPanel
            open
            themeMode="light"
            editorLineHeight={1.55}
            editorFontSize={14}
            editorSpellcheck
            tabSize={4}
            autoSaveDirInfo={unavailableInfo}
            onBrowseAutoSaveDir={vi.fn()}
            onResetAutoSaveDir={vi.fn()}
            cloudSyncProvider={null}
            cloudSyncSource="local"
            cloudSyncFolder={null}
            cloudProviders={[]}
            noteCount={0}
            onCloudSyncChange={vi.fn().mockResolvedValue(undefined)}
            onCloudSyncSourceChange={vi.fn().mockResolvedValue(undefined)}
            shortcuts={createDefaultShortcuts()}
            onThemeModeChange={vi.fn()}
            onEditorLineHeightChange={vi.fn()}
            onEditorFontSizeChange={vi.fn()}
            onEditorSpellcheckChange={vi.fn()}
            onTabSizeChange={vi.fn()}
            onShortcutChange={() => ({ ok: true })}
            onResetShortcuts={vi.fn()}
            weekStartsOn={1}
            onWeekStartsOnChange={vi.fn()}
            onClose={vi.fn()}
          />
        </I18nProvider>
      );
    });
  }

  it("shows the expected unavailable path and explicit recovery actions in Korean", async () => {
    await render("ko");

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("사용자 지정 저장 경로에 연결할 수 없습니다");
    expect(alert?.textContent).toContain("Z:/Detached/HwanNote");
    expect(alert?.textContent).toContain("불러오기와 저장을 중단했습니다");
    expect(container.textContent).toContain("변경");
    expect(container.textContent).toContain("기본값으로 복원");
    expect(container.textContent).not.toContain("기본 경로를 사용합니다");
  });

  it("shows the same fail-closed guidance in English", async () => {
    await render("en");

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("The custom storage path is unavailable");
    expect(alert?.textContent).toContain("Expected path: Z:/Detached/HwanNote");
    expect(alert?.textContent).toContain("Loading and saving the local library are paused");
    expect(container.textContent).toContain("Browse");
    expect(container.textContent).toContain("Reset to default");
    expect(container.textContent).not.toContain("Using the default directory");
  });
});
