export type ReadingDirection = "ltr" | "rtl";
export type FitMode = "page" | "width";

export interface Book {
  id: string;
  title: string;
  originalName: string;
  size: number;
  pageCount: number;
  currentPage: number;
  direction: ReadingDirection;
  fit: FitMode;
  createdAt: string;
  lastReadAt: string | null;
}

export interface LibraryResponse {
  books: Book[];
  totalBytes: number;
  maxUploadBytes: number;
}

export interface SessionResponse {
  authenticated: boolean;
  passwordRequired: boolean;
}
