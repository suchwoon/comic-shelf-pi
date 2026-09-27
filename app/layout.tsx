import type { Metadata, Viewport } from "next";
import ThemeProvider from "@/components/ThemeProvider";
import { THEME_INIT_SCRIPT } from "@/lib/client/theme";
import "@fontsource-variable/noto-sans-kr";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shelf — Your personal library",
  description: "A quiet place for your PDF comics. Upload a book and pick up where you left off.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning>
    <head>
      <script id="shelf-theme-init" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
    </head>
    <body><ThemeProvider>{children}</ThemeProvider></body>
  </html>;
}
