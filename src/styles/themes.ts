export type ThemeName = "light" | "dark";

export const lightTheme = {
  "--bg-shell": "#F5F0EB",
  "--bg-surface": "#F5F0EB",
  "--bg-editor": "#FFFFFF",
  "--bg-status": "#F0EBE5",
  "--bg-elevated": "#FFFFFF",
  "--bg-hover": "rgba(0, 0, 0, 0.06)",
  "--bg-active": "rgba(0, 120, 212, 0.12)",
  "--text-primary": "#1A1A1A",
  "--text-muted": "#666666",
  "--accent": "#0078D4",
  "--border-soft": "#E6DED8",
  "--shadow-soft": "0 8px 24px rgba(0, 0, 0, 0.18)",
  "--shadow-tab": "0 1px 3px rgba(0, 0, 0, 0.08)"
};

export const darkTheme = {
  "--bg-shell": "#2D2D2D",
  "--bg-surface": "#2D2D2D",
  "--bg-editor": "#1E1E1E",
  "--bg-status": "#2A2A2A",
  "--bg-elevated": "#252525",
  "--bg-hover": "rgba(255, 255, 255, 0.08)",
  "--bg-active": "rgba(79, 195, 247, 0.18)",
  "--text-primary": "#E0E0E0",
  "--text-muted": "#888888",
  "--accent": "#4FC3F7",
  "--border-soft": "#3C3C3C",
  "--shadow-soft": "0 8px 24px rgba(0, 0, 0, 0.45)",
  "--shadow-tab": "0 1px 3px rgba(255, 255, 255, 0.06)"
};

export function applyTheme(theme: ThemeName) {
  const root = document.documentElement;
  const variables = theme === "dark" ? darkTheme : lightTheme;

  root.dataset.theme = theme;

  Object.entries(variables).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
}
