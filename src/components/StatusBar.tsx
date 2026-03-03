import { useI18n } from "../i18n/context";

interface StatusBarProps {
  line: number;
  column: number;
  chars: number;
  themeLabel: string;
  zoomPercent: number;
  fileFormat: "md" | "txt";
  onToggleFileFormat: () => void;
  cloudSyncProvider: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  onedrive: "OneDrive",
  google_drive: "Google Drive",
};

export default function StatusBar({ line, column, chars, themeLabel, zoomPercent, fileFormat, onToggleFileFormat, cloudSyncProvider }: StatusBarProps) {
  const { t } = useI18n();

  const cloudLabel = cloudSyncProvider ? PROVIDER_LABELS[cloudSyncProvider] ?? cloudSyncProvider : null;

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
        {cloudLabel && <span className="statusbar-cloud">{cloudLabel} | </span>}
        {t("status.rightInfo", { theme: themeLabel, zoom: zoomPercent })}
      </div>
    </footer>
  );
}
