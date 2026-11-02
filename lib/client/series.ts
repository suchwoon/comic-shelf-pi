import type { Book } from "../types";

export interface ShelfEntry {
  id: string;
  title: string;
  series: boolean;
  books: Book[];
}

export function compareInstallments(a: Book, b: Book) {
  return (a.installmentNumber ?? Infinity) - (b.installmentNumber ?? Infinity)
    || a.title.localeCompare(b.title, "en", { numeric: true, sensitivity: "base" })
    || a.id.localeCompare(b.id);
}

export function shelfEntries(books: Book[]): ShelfEntry[] {
  const entries = new Map<string, ShelfEntry>();
  for (const book of books) {
    const key = book.seriesId ? `series:${book.seriesId}` : `book:${book.id}`;
    const existing = entries.get(key);
    if (existing) existing.books.push(book);
    else entries.set(key, {
      id: book.seriesId || book.id,
      title: book.seriesTitle || book.title,
      series: !!book.seriesId,
      books: [book],
    });
  }
  for (const entry of entries.values()) entry.books.sort(compareInstallments);
  return [...entries.values()];
}

export function installmentLabel(book: Book) {
  if (book.installmentNumber === null || book.installmentNumber === undefined) return "Special";
  return `${book.installmentType === "chapter" ? "Chapter" : "Volume"} ${book.installmentNumber}`;
}

export function installmentCount(books: Book[]) {
  const type = books.every(book => book.installmentType === "volume") ? "volume"
    : books.every(book => book.installmentType === "chapter") ? "chapter" : "book";
  return `${books.length} ${type}${books.length === 1 ? "" : "s"}`;
}

export function isCompleted(book: Book) {
  return !!book.lastReadAt && book.currentPage >= book.pageCount;
}

export function seriesReadingTarget(books: Book[]): { book: Book; label: string } | null {
  const ordered = [...books].sort(compareInstallments);
  const started = ordered.filter(book => book.lastReadAt).sort((a, b) => Date.parse(b.lastReadAt!) - Date.parse(a.lastReadAt!));
  // Resume an unfinished installment before offering any later one.
  const unfinished = started.find(book => !isCompleted(book));
  if (unfinished) return { book: unfinished, label: "Continue reading" };
  const unread = ordered.find(book => !book.lastReadAt);
  if (unread) return { book: unread, label: started.length ? "Read next" : "Start reading" };
  return null;
}
