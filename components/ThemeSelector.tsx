"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { parseTheme } from "@/lib/client/theme";

export default function ThemeSelector() {
  const { theme, ready, setTheme } = useTheme();
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return <label className="shelf-theme-selector" title="Appearance">
    <Icon size={17} aria-hidden="true" />
    <select aria-label="Appearance" value={theme} disabled={!ready} onChange={event => setTheme(parseTheme(event.target.value))}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>;
}
