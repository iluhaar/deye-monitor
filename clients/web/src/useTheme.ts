import { useEffect, useLayoutEffect, useState } from "react";
import { applyTheme, readStoredTheme, resolveTheme, storeTheme, systemPrefersDark } from "./theme";
import type { Theme } from "./theme";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    resolveTheme(readStoredTheme(), systemPrefersDark()),
  );

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      if (readStoredTheme() !== null) {
        return;
      }
      setTheme(resolveTheme(null, event.matches));
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    storeTheme(next);
    setTheme(next);
  };

  return { theme, toggleTheme };
}
