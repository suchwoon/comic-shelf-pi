"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";

export default function ThemeToggle() {
  const { theme, ready, setTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";
  const Icon = nextTheme === "dark" ? Moon : Sun;
  const label = `Switch to ${nextTheme} mode`;
  return <button className="shelf-icon-button" type="button" aria-label={label} title={label} disabled={!ready} onClick={() => setTheme(nextTheme)}>
    <Icon size={17} aria-hidden="true" />
  </button>;
}
