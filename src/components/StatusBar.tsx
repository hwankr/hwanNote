import { useI18n } from "../i18n/context";
import type { CloudSyncSource } from "../lib/tauriApi";

interface StatusBarProps {
  line: number;
  column: number;
  chars: number;
  themeLabel: string;
  zoomPercent: number;
  fileFormat: "md" | "txt";
  onToggleFileFormat: () => void;
  cloudSyncProvider: string | null;
  cloudSyncSource: CloudSyncSource;
}

const PROVIDER_LABELS: Record<string, string> = {
  onedrive: "OneDrive",
  google_drive: "Google Drive",
};

export default function StatusBar({ line, column, chars, themeLabel, zoomPercent, fileFormat, onToggleFileFormat, cloudSyncProvider, cloudSyncSource }: StatusBarProps) {
  const { t } = useI18n();

  const storageLabel = cloudSyncProvider && cloudSyncSource === "cloud"
    ? PROVIDER_LABELS[cloudSyncProvider] ?? cloudSyncProvider
    : t("status.localStorage");

  return (
    <footer className="statusbar">
      <div className="statusbar-left">{t("status.lineColChars", { line, column, chars })}</div>
      <div className="statusbar-center">
        <button
          type="button"
          className="statusbar-format-toggle"
          onClick={onToggleFileFormat}
          title={fileFormat === "md" ? t("status.switchToTxt") : t("status.switchToMd")}
        >
          {fileFormat === "md" ? t("status.markdown") : t("status.plainText")}
        </button>
      </div>
      <div className="statusbar-right">
        <span className="statusbar-cloud">{storageLabel} | </span>
        {t("status.rightInfo", { theme: themeLabel, zoom: zoomPercent })}
      </div>
    </footer>
  );
}
