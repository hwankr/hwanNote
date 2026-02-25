import { useI18n } from "../i18n/context";

interface StatusBarProps {
  line: number;
  column: number;
  chars: number;
  themeLabel: string;
  zoomPercent: number;
}

export default function StatusBar({ line, column, chars, themeLabel, zoomPercent }: StatusBarProps) {
  const { t } = useI18n();

  return (
    <footer className="statusbar">
      <div className="statusbar-left">{t("status.lineColChars", { line, column, chars })}</div>
      <div className="statusbar-center">{t("status.markdown")}</div>
      <div className="statusbar-right">{t("status.rightInfo", { theme: themeLabel, zoom: zoomPercent })}</div>
    </footer>
  );
}
