import { useI18n } from "../i18n/context";

interface StatusBarProps {
  line: number;
  column: number;
  chars: number;
  themeLabel: string;
}

export default function StatusBar({ line, column, chars, themeLabel }: StatusBarProps) {
  const { t } = useI18n();

  return (
    <footer className="statusbar">
      <div className="statusbar-left">{t("status.lineColChars", { line, column, chars })}</div>
      <div className="statusbar-center">{t("status.markdown")}</div>
      <div className="statusbar-right">{t("status.rightInfo", { theme: themeLabel })}</div>
    </footer>
  );
}
