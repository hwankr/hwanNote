interface StatusBarProps {
  line: number;
  column: number;
  chars: number;
  themeLabel: string;
}

export default function StatusBar({ line, column, chars, themeLabel }: StatusBarProps) {
  return (
    <footer className="statusbar">
      <div className="statusbar-left">{`줄 ${line}, 열 ${column} | ${chars}자`}</div>
      <div className="statusbar-center">마크다운</div>
      <div className="statusbar-right">{`${themeLabel} | 100% | Windows (CRLF) | UTF-8`}</div>
    </footer>
  );
}
