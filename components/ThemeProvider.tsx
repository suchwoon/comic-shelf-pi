"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { applyTheme, parseTheme, readTheme, THEME_MEDIA_QUERY, THEME_STORAGE_KEY, type Theme } from "@/lib/client/theme";

const ThemeContext = createContext<{ theme: Theme; ready: boolean; setTheme: (theme: Theme) => void } | null>(null);

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [ready, setReady] = useState(false);
  const preference = useRef<Theme>("system");
  const pathname = usePathname();

  const syncTheme = useCallback((next: Theme) => {
    preference.current = next;
    setThemeState(next);
    applyTheme(next);
  }, []);

  useEffect(() => {
    syncTheme(readTheme());
    setReady(true);
    const media = window.matchMedia(THEME_MEDIA_QUERY);
    const onSystemChange = () => {
      if (preference.current === "system") applyTheme("system");
    };
    const onStorage = (event: StorageEvent) => {
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch { return; }
      if (event.key === THEME_STORAGE_KEY || event.key === null) syncTheme(parseTheme(event.newValue));
    };
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [syncTheme]);

  // Client navigation retains the provider; refresh the browser toolbar color.
  useEffect(() => { if (ready) applyTheme(preference.current); }, [pathname, ready]);

  const setTheme = useCallback((next: Theme) => {
    syncTheme(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); }
    catch { /* Keep this tab usable when browser storage is unavailable. */ }
  }, [syncTheme]);

  return <ThemeContext.Provider value={{ theme, ready, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme requires ThemeProvider");
  return context;
}
