import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_READING_DIRECTION, type Book } from "../types";
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
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      originalName TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size > 0),
      pageCount INTEGER NOT NULL CHECK (pageCount > 0),
      currentPage INTEGER NOT NULL DEFAULT 1,
      direction TEXT NOT NULL DEFAULT '${DEFAULT_READING_DIRECTION}' CHECK (direction IN ('ltr', 'rtl')),
      fit TEXT NOT NULL DEFAULT 'page' CHECK (fit IN ('page', 'width')),
      createdAt TEXT NOT NULL,
      lastReadAt TEXT,
      sha256 TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS progress_writers (
      bookId TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      writerId TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (bookId, writerId)
    );
  `);
  return state.__comicStore = { root, db };
}

const columns = "id, title, originalName, size, pageCount, currentPage, direction, fit, createdAt, lastReadAt";
const userColumns = `b.id, b.title, b.originalName, b.size, b.pageCount, b.createdAt,
  COALESCE(p.currentPage, 1) AS currentPage, COALESCE(p.direction, '${DEFAULT_READING_DIRECTION}') AS direction,
  COALESCE(p.fit, 'page') AS fit, p.lastReadAt`;

function ensureUserProgressTables() {
  // Account setup creates users first. Keep these tables lazy so low-level
  // upload/storage operations can still work before accounts are initialized.
  store().db.exec(`
    CREATE TABLE IF NOT EXISTS user_progress (
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bookId TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      currentPage INTEGER NOT NULL DEFAULT 1 CHECK (currentPage > 0),
      direction TEXT NOT NULL DEFAULT '${DEFAULT_READING_DIRECTION}' CHECK (direction IN ('ltr', 'rtl')),
      fit TEXT NOT NULL DEFAULT 'page' CHECK (fit IN ('page', 'width')),
      lastReadAt TEXT,
      PRIMARY KEY (userId, bookId)
    );
    CREATE TABLE IF NOT EXISTS user_progress_writers (
      userId TEXT NOT NULL,
      bookId TEXT NOT NULL,
      writerId TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (userId, bookId, writerId),
      FOREIGN KEY (userId, bookId) REFERENCES user_progress(userId, bookId) ON DELETE CASCADE
    );
  `);
}

/** Only the first administrator inherits the pre-account library's progress. */
export function migrateLegacyProgress(userId: string) {
  ensureUserProgressTables();
  const { db } = store();
  db.prepare(`INSERT OR IGNORE INTO user_progress (userId, bookId, currentPage, direction, fit, lastReadAt)
    SELECT ?, id, currentPage, direction, fit, lastReadAt FROM books`).run(userId);
  db.prepare(`INSERT OR IGNORE INTO user_progress_writers (userId, bookId, writerId, sequence)
    SELECT ?, bookId, writerId, sequence FROM progress_writers`).run(userId);
}

export function listBooks(userId?: string): Book[] {
  if (userId !== undefined) {
    ensureUserProgressTables();
    return store().db.prepare(`SELECT ${userColumns} FROM books b
      LEFT JOIN user_progress p ON p.bookId = b.id AND p.userId = ?
      ORDER BY COALESCE(p.lastReadAt, b.createdAt) DESC`).all(userId) as unknown as Book[];
  }
  return store().db.prepare(`SELECT ${columns} FROM books ORDER BY COALESCE(lastReadAt, createdAt) DESC`).all() as unknown as Book[];
}

export function getBook(id: string, userId?: string): Book {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError(404, "Book not found.");
  }
  if (userId !== undefined) ensureUserProgressTables();
  const book = (userId === undefined
    ? store().db.prepare(`SELECT ${columns} FROM books WHERE id = ?`).get(id)
    : store().db.prepare(`SELECT ${userColumns} FROM books b
      LEFT JOIN user_progress p ON p.bookId = b.id AND p.userId = ? WHERE b.id = ?`).get(userId, id)) as unknown as Book | undefined;
  if (!book) throw new ApiError(404, "Book not found.");
  return book;
}

export function bookFile(id: string) { return join(store().root, "books", `${id}.pdf`); }
export function coverFile(id: string) { return join(store().root, "covers", `${id}.jpg`); }

export function maxUploadBytes() {
  const megabytes = Number(process.env.MAX_UPLOAD_MB || 256);
  return (Number.isFinite(megabytes) && megabytes > 0 ? Math.min(megabytes, 2048) : 256) * 1024 * 1024;
}

export function validateTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 200 || /[\u0000-\u001f]/.test(title)) {
    throw new ApiError(400, "Enter a title between 1 and 200 characters.");
  }
  return title.trim();
}

export function clearProgress(id: string, userId: string): Book {
  ensureUserProgressTables();
  const { db } = store();
  db.exec("BEGIN IMMEDIATE");
  try {
    getBook(id, userId);
    // Keep reader preferences and writer sequences so replayed saves cannot
    // restore cleared history. A newer save starts recording progress again.
    db.prepare("UPDATE user_progress SET currentPage = 1, lastReadAt = NULL WHERE userId = ? AND bookId = ?")
      .run(userId, id);
    const book = getBook(id, userId);
    db.exec("COMMIT");
    return book;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateProgress(id: string, input: Record<string, unknown>, userId?: string): Book {
  const keys = Object.keys(input);
  if (!keys.some(key => ["currentPage", "direction", "fit"].includes(key))
    || keys.some(key => !["currentPage", "direction", "fit", "writerId", "sequence"].includes(key))) {
    throw new ApiError(400, "The reading settings are invalid.");
  }
  const ordered = input.writerId !== undefined || input.sequence !== undefined;
  if (ordered && (typeof input.writerId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.writerId)
    || typeof input.sequence !== "number" || !Number.isSafeInteger(input.sequence) || input.sequence < 1)) {
    throw new ApiError(400, "The reading save sequence is invalid.");
  }
  const { db } = store();
  if (userId !== undefined) ensureUserProgressTables();
  // Protect both the sequence check and partial-setting merge, even when
  // several server processes share this database.
  db.exec("BEGIN IMMEDIATE");
  try {
    const book = applyProgress(id, input, ordered, userId);
    db.exec("COMMIT");
    return book;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyProgress(id: string, input: Record<string, unknown>, ordered: boolean, userId?: string): Book {
  const book = getBook(id, userId);
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
  const { db } = store();
  if (ordered) {
    const previous = (userId === undefined
      ? db.prepare("SELECT sequence FROM progress_writers WHERE bookId = ? AND writerId = ?").get(id, input.writerId as string)
      : db.prepare("SELECT sequence FROM user_progress_writers WHERE userId = ? AND bookId = ? AND writerId = ?")
        .get(userId, id, input.writerId as string)) as { sequence: number } | undefined;
    // Repeated exit events and delayed older requests are successful no-ops.
    // Other writers still use arrival order, preserving cross-device behavior.
    if (previous && previous.sequence >= (input.sequence as number)) return getBook(id, userId);
  }
  if (userId === undefined) {
    db.prepare("UPDATE books SET currentPage = ?, direction = ?, fit = ?, lastReadAt = ? WHERE id = ?")
      .run(book.currentPage, book.direction, book.fit, book.lastReadAt, id);
  } else {
    db.prepare(`INSERT INTO user_progress (userId, bookId, currentPage, direction, fit, lastReadAt) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (userId, bookId) DO UPDATE SET currentPage = excluded.currentPage,
        direction = excluded.direction, fit = excluded.fit, lastReadAt = excluded.lastReadAt`)
      .run(userId, id, book.currentPage, book.direction, book.fit, book.lastReadAt);
  }
  if (ordered) {
    if (userId === undefined) {
      db.prepare(`INSERT INTO progress_writers (bookId, writerId, sequence) VALUES (?, ?, ?)
        ON CONFLICT (bookId, writerId) DO UPDATE SET sequence = excluded.sequence`)
        .run(id, input.writerId as string, input.sequence as number);
    } else {
      db.prepare(`INSERT INTO user_progress_writers (userId, bookId, writerId, sequence) VALUES (?, ?, ?, ?)
        ON CONFLICT (userId, bookId, writerId) DO UPDATE SET sequence = excluded.sequence`)
        .run(userId, id, input.writerId as string, input.sequence as number);
    }
  }
  return book;
}
