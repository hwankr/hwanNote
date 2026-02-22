export type ThemeMode = "light" | "dark" | "system";

interface SettingsPanelProps {
  open: boolean;
  themeMode: ThemeMode;
  autoSaveDir: string;
  onThemeModeChange: (mode: ThemeMode) => void;
  onClose: () => void;
}

export default function SettingsPanel({
  open,
  themeMode,
  autoSaveDir,
  onThemeModeChange,
  onClose
}: SettingsPanelProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="settings-overlay no-drag" onClick={onClose}>
      <section className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <h2>설정</h2>
          <button type="button" onClick={onClose} aria-label="설정 닫기">
            닫기
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-item">
            <label htmlFor="theme-mode">테마 모드</label>
            <select
              id="theme-mode"
              value={themeMode}
              onChange={(event) => onThemeModeChange(event.target.value as ThemeMode)}
            >
              <option value="light">라이트</option>
              <option value="dark">다크</option>
              <option value="system">시스템 설정 따르기</option>
            </select>
          </div>

          <div className="settings-item">
            <label>자동 저장 위치</label>
            <div className="settings-readonly">{autoSaveDir || "확인 중..."}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
