export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "comic-shelf-theme";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";
export const THEME_COLORS = { light: "#fafafa", dark: "#141414" } as const;

export function resolveTheme(value: string | null): Theme {
  // Missing, invalid, and legacy "system" preferences use the device as an initial value.
  return value === "light" || value === "dark"
    ? value
    : window.matchMedia(THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

export function readTheme(): Theme {
  let stored: string | null = null;
  try { stored = localStorage.getItem(THEME_STORAGE_KEY); }
  catch { /* Device preference is enough when storage is unavailable. */ }
  return resolveTheme(stored);
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  // The reader keeps its dark surroundings regardless of the shelf preference.
  const color = window.location.pathname.startsWith("/read/") ? THEME_COLORS.dark : THEME_COLORS[theme];
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = color;
}

// Runs in <head> before the body is painted, independently of React hydration.
// Only application constants are interpolated into this script.
export const THEME_INIT_SCRIPT = `(() => {
  let theme;
  try { theme = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}); } catch {}
  if (theme !== "light" && theme !== "dark") {
    theme = matchMedia(${JSON.stringify(THEME_MEDIA_QUERY)}).matches ? "dark" : "light";
  }
  document.documentElement.dataset.theme = theme;
  const colors = ${JSON.stringify(THEME_COLORS)};
  // Own this tag outside React: changing a server-rendered meta before hydration
  // would make React's metadata hoisting insert a second tag with the old color.
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = location.pathname.startsWith("/read/") ? colors.dark : colors[theme];
  document.head.appendChild(meta);
})();`;
