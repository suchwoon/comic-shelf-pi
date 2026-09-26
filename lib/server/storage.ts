import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Book } from "../types";
import { ApiError } from "./http";

interface Store { db: DatabaseSync; root: string }
const state = globalThis as typeof globalThis & { __comicStore?: Store };

export function dataRoot() {
  return resolve(process.env.DATA_DIR || join(process.cwd(), "data"));
}

export function store(): Store {
  const root = dataRoot();
  if (state.__comicStore?.root === root) return state.__comicStore;
  state.__comicStore?.db.close();
  for (const dir of [root, join(root, "books"), join(root, "covers"), join(root, "tmp")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(join(root, "library.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      originalName TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size > 0),
      pageCount INTEGER NOT NULL CHECK (pageCount > 0),
      currentPage INTEGER NOT NULL DEFAULT 1,
      direction TEXT NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr', 'rtl')),
      fit TEXT NOT NULL DEFAULT 'page' CHECK (fit IN ('page', 'width')),
      createdAt TEXT NOT NULL,
      lastReadAt TEXT,
      sha256 TEXT NOT NULL UNIQUE
    );
  `);
  return state.__comicStore = { root, db };
}

const columns = "id, title, originalName, size, pageCount, currentPage, direction, fit, createdAt, lastReadAt";

export function listBooks(): Book[] {
  return store().db.prepare(`SELECT ${columns} FROM books ORDER BY COALESCE(lastReadAt, createdAt) DESC`).all() as unknown as Book[];
}

export function getBook(id: string): Book {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError(404, "Book not found.");
  }
  const book = store().db.prepare(`SELECT ${columns} FROM books WHERE id = ?`).get(id) as unknown as Book | undefined;
  if (!book) throw new ApiError(404, "Book not found.");
  return book;
}

export function bookFile(id: string) { return join(store().root, "books", `${id}.pdf`); }
export function coverFile(id: string) { return join(store().root, "covers", `${id}.jpg`); }

export function maxUploadBytes() {
  const megabytes = Number(process.env.MAX_UPLOAD_MB || 256);
  return (Number.isFinite(megabytes) && megabytes > 0 ? Math.min(megabytes, 4096) : 256) * 1024 * 1024;
}

export function validateTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 200 || /[\u0000-\u001f]/.test(title)) {
    throw new ApiError(400, "Enter a title between 1 and 200 characters.");
  }
  return title.trim();
}

export function updateProgress(id: string, input: Record<string, unknown>): Book {
  const book = getBook(id);
  if (!Object.keys(input).length || Object.keys(input).some(key => !["currentPage", "direction", "fit"].includes(key))) {
    throw new ApiError(400, "The reading settings are invalid.");
  }
  if (input.currentPage !== undefined) {
    if (typeof input.currentPage !== "number" || !Number.isInteger(input.currentPage) || input.currentPage < 1 || input.currentPage > book.pageCount) {
      throw new ApiError(400, "This page number is outside the book.");
    }
    book.currentPage = input.currentPage;
    book.lastReadAt = new Date().toISOString();
  }
  if (input.direction !== undefined) {
    if (input.direction !== "ltr" && input.direction !== "rtl") throw new ApiError(400, "The reading direction is invalid.");
    book.direction = input.direction;
  }
  if (input.fit !== undefined) {
    if (input.fit !== "page" && input.fit !== "width") throw new ApiError(400, "The page fit setting is invalid.");
    book.fit = input.fit;
  }
  store().db.prepare("UPDATE books SET currentPage = ?, direction = ?, fit = ?, lastReadAt = ? WHERE id = ?")
    .run(book.currentPage, book.direction, book.fit, book.lastReadAt, id);
  return book;
}
