import { useI18n } from "../i18n/context";

interface StatusBarProps {
  line: number;
  column: number;
  chars: number;
  themeLabel: string;
  zoomPercent: number;
  fileFormat: "md" | "txt";
  onToggleFileFormat: () => void;
}

export default function StatusBar({ line, column, chars, themeLabel, zoomPercent, fileFormat, onToggleFileFormat }: StatusBarProps) {
  const { t } = useI18n();

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
      <div className="statusbar-right">{t("status.rightInfo", { theme: themeLabel, zoom: zoomPercent })}</div>
    </footer>
  );
}
