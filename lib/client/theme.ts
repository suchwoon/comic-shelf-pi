export type Theme = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "comic-shelf-theme";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";
export const THEME_COLORS = { light: "#fafafa", dark: "#141414" } as const;

export function parseTheme(value: string | null): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

export function readTheme(): Theme {
  try { return parseTheme(localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return "system"; }
}

export function applyTheme(theme: Theme) {
  const resolved = theme === "system"
    ? (window.matchMedia(THEME_MEDIA_QUERY).matches ? "dark" : "light")
    : theme;
  document.documentElement.dataset.theme = resolved;
  // The reader keeps its dark surroundings regardless of the shelf preference.
  const color = window.location.pathname.startsWith("/read/") ? THEME_COLORS.dark : THEME_COLORS[resolved];
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
  let theme = "system";
  try {
    const stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (stored === "light" || stored === "dark") theme = stored;
  } catch {}
  const resolved = theme === "system"
    ? (matchMedia(${JSON.stringify(THEME_MEDIA_QUERY)}).matches ? "dark" : "light")
    : theme;
  document.documentElement.dataset.theme = resolved;
  const colors = ${JSON.stringify(THEME_COLORS)};
  // Own this tag outside React: changing a server-rendered meta before hydration
  // would make React's metadata hoisting insert a second tag with the old color.
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = location.pathname.startsWith("/read/") ? colors.dark : colors[resolved];
  document.head.appendChild(meta);
})();`;
