export const THEME_STORAGE_KEY = "deye-theme";

/** Page background. Keep in sync with --bg in style.css and the blocking script in index.html. */
export const THEME_COLOR = {
  light: "#f4f6f8",
  dark: "#10161c",
} as const;

export type Theme = keyof typeof THEME_COLOR;

export function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark";
}

export function resolveTheme(stored: string | null, systemDark: boolean): Theme {
  if (isTheme(stored)) {
    return stored;
  }
  return systemDark ? "dark" : "light";
}

export function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be blocked; the choice still applies for this visit.
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}
