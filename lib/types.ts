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
  user: AccountUser | null;
}

export interface AccountUser {
  id: string;
  username: string;
  role: "admin" | "reader";
  createdAt: string;
}

export interface ManagedUser extends AccountUser {
  disabled: boolean;
}

export interface AccountInvitation {
  id: string;
  kind: "invite" | "reset";
  username: string | null;
  expiresAt: string;
  createdAt: string;
}

// Keep every upload request comfortably below common proxy request limits.
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export interface UploadSession {
  id: string;
  chunkBytes: number;
}
