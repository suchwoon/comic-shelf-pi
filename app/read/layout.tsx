import type { ReactNode } from "react";

export default function ReadingLayout({ children }: { children: ReactNode }) {
  // This element survives installment changes and leaves fullscreen naturally
  // when the reader route is closed, including browser back navigation.
  return <div data-reader-fullscreen>{children}</div>;
}
