"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent, ReactNode } from "react";
import {
  ArrowDownToLine, ArrowRight, BookOpen, CheckCircle2, ChevronDown,
  CircleAlert, CloudUpload, Ellipsis, FileText, LoaderCircle,
  LockKeyhole, LogOut, Pencil, Plus, RotateCcw, Search, Trash2, UserRound, X,
} from "lucide-react";
import type { Book, LibraryResponse, SessionResponse } from "@/lib/types";
import { UploadError, uploadPdf } from "@/lib/client/upload";
import { isDialogBackdropClick, showModalDialog } from "@/lib/client/dialog";
import AccountPanel from "@/components/AccountPanel";
import ThemeToggle from "@/components/ThemeToggle";
import ChatPanel from "@/components/ChatPanel";

type UploadStatus = "queued" | "uploading" | "checking" | "done" | "error";
interface UploadItem {
  id: string;
  file: File;
  status: UploadStatus;
  progress: number;
  error?: string;
  retryable?: boolean;
}
type BookAction = { kind: "rename" | "delete" | "clearHistory"; book: Book };

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 MB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function readError(response: Response, fallback: string) {
  try {
    const data: unknown = await response.json();
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  } catch { /* An upstream error may not contain JSON. */ }
  return fallback;
}

function BookCover({ book, small = false }: { book: Book; small?: boolean }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  return (
    <div className={`shelf-cover${small ? " shelf-cover-small" : ""}`}>
      {status !== "loaded" && <div className="shelf-cover-fallback" aria-hidden="true">
        <BookOpen size={small ? 20 : 32} strokeWidth={1.2} />
      </div>}
      {status !== "error" && <img src={`/api/books/${book.id}/cover`} alt="" loading="lazy"
        onLoad={() => setStatus("loaded")} onError={() => setStatus("error")} />}
    </div>
  );
}

function BookDialog({ action, onClose, onSaved, onUnauthorized }: {
  action: BookAction;
  onClose: () => void;
  onSaved: (book: Book | null) => void;
  onUnauthorized: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(action.book.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const deleting = action.kind === "delete";
  const clearingHistory = action.kind === "clearHistory";
  const renaming = action.kind === "rename";
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) return showModalDialog(dialog);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmed = title.trim();
    if (renaming && !trimmed) { setError("Enter a book title."); return; }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/books/${action.book.id}${clearingHistory ? "/progress" : ""}`, {
        method: renaming ? "PATCH" : "DELETE",
        ...(renaming ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: trimmed }) } : {}),
      });
      if (response.status === 401) { onUnauthorized(); onClose(); return; }
      if (!response.ok) throw new Error(await readError(response, "Could not save your changes. Please try again."));
      if (deleting) onSaved(null);
      else { const data: { book: Book } = await response.json(); onSaved(data.book); }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check your connection and try again.");
    } finally { setBusy(false); }
  }

  return (
    <dialog ref={dialogRef} className="shelf-dialog" aria-labelledby="shelf-dialog-title" aria-describedby="shelf-dialog-description"
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={event => { if (!busy && isDialogBackdropClick(event)) onClose(); }}>
      <form onSubmit={submit}>
        <button className="shelf-icon-button shelf-dialog-close" type="button" aria-label="Close dialog" onClick={onClose} disabled={busy}><X size={21} /></button>
        <h2 id="shelf-dialog-title">{deleting ? "Delete book?" : clearingHistory ? "Clear reading history?" : "Rename book"}</h2>
        <p id="shelf-dialog-description">{deleting ? <>This will delete “{action.book.title}” and its reading progress.</> : clearingHistory ? <>Clear your reading history for “{action.book.title}”? You'll start from page 1 next time. The book, your reading settings, and other members' progress will stay the same.</> : "Choose a title for this book."}</p>
        {renaming && <label className="shelf-field-label">Book title<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={160} disabled={busy} required /></label>}
        {error && <p className="shelf-form-error" role="alert"><CircleAlert size={16} />{error}</p>}
        <div className="shelf-dialog-actions">
          <button type="button" className="shelf-button shelf-button-light" onClick={onClose} disabled={busy} autoFocus={!renaming}>Cancel</button>
          <button type="submit" className={`shelf-button ${renaming ? "shelf-button-primary" : "shelf-button-danger"}`} disabled={busy || (renaming && !title.trim())}>
            {busy && <LoaderCircle size={16} className="shelf-spin" />}{deleting ? "Delete" : clearingHistory ? "Clear history" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function UploadList({ uploads, onRetry, onClear }: { uploads: UploadItem[]; onRetry: (id: string) => void; onClear: () => void }) {
  const pending = uploads.filter(item => ["queued", "uploading", "checking"].includes(item.status)).length;
  const completed = uploads.filter(item => item.status === "done").length;
  return (
    <section className="shelf-upload-panel" aria-label="Upload status">
      <div className="shelf-upload-panel-header">
        <div><CloudUpload size={20} /><strong>{pending ? "Uploading" : "Uploads"}</strong><span>{completed} of {uploads.length} complete</span></div>
        <button type="button" className="shelf-icon-button" onClick={onClear} aria-label="Dismiss finished uploads" disabled={pending === uploads.length}><X size={19} /></button>
      </div>
      <div className="shelf-upload-items">
        {uploads.map(item => (
          <div key={item.id} className={`shelf-upload-item shelf-upload-item-${item.status}`}>
            <div className="shelf-upload-file-icon"><FileText size={21} strokeWidth={1.5} /></div>
            <div className="shelf-upload-item-content">
              <p title={item.file.name}>{item.file.name}</p>
              <div className="shelf-upload-item-meta"><span>{formatBytes(item.file.size)}</span><span>{item.status === "queued" ? "Queued" : item.status === "uploading" ? `Uploading · ${item.progress}%` : item.status === "checking" ? "Checking PDF" : item.status === "done" ? "Added to library" : item.error}</span></div>
              {(item.status === "uploading" || item.status === "checking") && <div className={`shelf-upload-track${item.status === "checking" ? " shelf-upload-track-checking" : ""}`} role="progressbar" aria-label={`Uploading ${item.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}><span style={{ width: `${item.progress}%` }} /></div>}
            </div>
            {item.status === "done" ? <CheckCircle2 className="shelf-upload-success" size={20} /> : item.status === "error" ? (item.retryable ? <button className="shelf-icon-button" type="button" aria-label={`Retry upload ${item.file.name}`} onClick={() => onRetry(item.id)}><RotateCcw size={18} /></button> : <CircleAlert className="shelf-upload-error" size={20} />) : item.status === "queued" ? <span className="shelf-upload-waiting" /> : <LoaderCircle size={19} className="shelf-spin" />}
          </div>
        ))}
      </div>
      <p className="shelf-upload-panel-note" aria-live="polite">{pending ? "Keep this page open until uploads finish." : completed === uploads.length ? "All uploads complete." : "Some files could not be uploaded. See details above."}</p>
    </section>
  );
}

export default function Bookshelf() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [maxUploadBytes, setMaxUploadBytes] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [action, setAction] = useState<BookAction | null>(null);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [logoutBusy, setLogoutBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const processing = useRef(false);
  const activeUpload = useRef<AbortController | null>(null);
  const nextUploadId = useRef(0);
  const clearedHistoryBook = useRef<string | null>(null);

  useEffect(() => {
    if (action || !clearedHistoryBook.current) return;
    // A reader's history menu disappears after clearing; restore focus to
    // the book link that remains available instead of the removed trigger.
    document.querySelector<HTMLAnchorElement>(`.shelf-book-link[href="/read/${clearedHistoryBook.current}"]`)?.focus();
    clearedHistoryBook.current = null;
  }, [action, books]);

  const requireLogin = useCallback(() => {
    activeUpload.current?.abort();
    dragCounter.current = 0;
    setSession({ authenticated: false, passwordRequired: true, user: null });
    setBooks([]);
    setUploads([]);
    setLoading(false);
    setAction(null);
    setAccountOpen(false);
    setDragging(false);
  }, []);

  const loadSession = useCallback(async () => {
    setSessionError("");
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "Could not connect to your library."));
      const data: SessionResponse = await response.json();
      setSession(data);
      if (!data.authenticated) setLoading(false);
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : "Check your connection to the server.");
      setLoading(false);
    }
  }, []);

  const loadBooks = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/books", { cache: "no-store" });
      if (response.status === 401) { requireLogin(); return; }
      if (!response.ok) throw new Error(await readError(response, "Could not load your library."));
      const data: LibraryResponse = await response.json();
      setBooks(data.books);
      setMaxUploadBytes(data.maxUploadBytes);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Check your connection to the server and try again.");
    } finally { setLoading(false); }
  }, [requireLogin]);

  useEffect(() => { void loadSession(); }, [loadSession]);
  useEffect(() => { if (session?.authenticated && session.user) void loadBooks(); }, [session?.authenticated, session?.user?.id, loadBooks]);
  useEffect(() => () => { activeUpload.current?.abort(); }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    const closeMenus = (event: globalThis.MouseEvent) => {
      document.querySelectorAll<HTMLDetailsElement>("details.shelf-book-menu[open]").forEach(menu => {
        if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
      });
    };
    document.addEventListener("click", closeMenus);
    return () => document.removeEventListener("click", closeMenus);
  }, []);

  const updateUpload = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item));
  }, []);

  useEffect(() => {
    if (processing.current || !session?.authenticated || session.user?.role !== "admin" || loading) return;
    const next = uploads.find(item => item.status === "queued");
    if (!next) return;
    processing.current = true;
    updateUpload(next.id, { status: "uploading", progress: 0 });
    const controller = new AbortController();
    activeUpload.current = controller;
    void uploadPdf(next.file, {
      signal: controller.signal,
      onProgress: (progress, checking) => updateUpload(next.id, { progress, status: checking ? "checking" : "uploading" }),
    }).then(book => {
      processing.current = false;
      if (!controller.signal.aborted) {
        setBooks(previous => [book, ...previous.filter(existing => existing.id !== book.id)]);
        updateUpload(next.id, { status: "done", progress: 100 });
      }
    }).catch(cause => {
      processing.current = false;
      if (controller.signal.aborted) return;
      if (cause instanceof UploadError && cause.status === 401) requireLogin();
      updateUpload(next.id, { status: "error", error: cause instanceof Error ? cause.message : "Upload failed. Please try again.", retryable: cause instanceof UploadError ? cause.retryable : true });
    }).finally(() => {
      processing.current = false;
      activeUpload.current = null;
    });
  }, [uploads, session?.authenticated, session?.user?.role, loading, updateUpload, requireLogin]);

  const pendingCount = uploads.filter(item => ["queued", "uploading", "checking"].includes(item.status)).length;
  useEffect(() => {
    if (!pendingCount) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [pendingCount]);

  function enqueue(files: FileList | File[] | null) {
    if (!files || !session?.authenticated || session.user?.role !== "admin" || loading || loadError) return;
    const incoming: UploadItem[] = Array.from(files).map(file => {
      const error = !/\.pdf$/i.test(file.name) ? "Only PDF files are supported." : file.size === 0 ? "This file is empty." : maxUploadBytes && file.size > maxUploadBytes ? `Each file must be ${formatBytes(maxUploadBytes)} or smaller.` : "";
      return { id: String(++nextUploadId.current), file, status: error ? "error" : "queued", progress: 0, ...(error ? { error, retryable: false } : {}) };
    });
    setUploads(previous => [...previous, ...incoming]);
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      const response = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: username.trim(), password }) });
      if (!response.ok) throw new Error(await readError(response, "Check your password and try again."));
      const data: SessionResponse = await response.json();
      setPassword("");
      setLoading(true);
      setSession(data);
    } catch (cause) {
      setLoginError(cause instanceof Error ? cause.message : "Check your connection and try again.");
    } finally { setLoginBusy(false); }
  }

  async function logout() {
    if (logoutBusy || pendingCount) return;
    setLogoutBusy(true);
    try {
      const response = await fetch("/api/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not sign out. Please try again.");
      setUploads([]);
      requireLogin();
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Could not sign out."); }
    finally { setLogoutBusy(false); }
  }

  const filteredBooks = useMemo(() => {
    const search = query.trim().toLocaleLowerCase("en");
    return books.filter(book => book.title.toLocaleLowerCase("en").includes(search)).sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title, "en", { numeric: true, sensitivity: "base" });
      if (sort === "added") return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return (b.lastReadAt ? Date.parse(b.lastReadAt) : 0) - (a.lastReadAt ? Date.parse(a.lastReadAt) : 0) || Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
  }, [books, query, sort]);
  const recent = useMemo(() => [...books].filter(book => book.lastReadAt !== null).sort((a, b) => Date.parse(b.lastReadAt!) - Date.parse(a.lastReadAt!))[0], [books]);
  const totalSize = books.reduce((sum, book) => sum + book.size, 0);
  const isAdmin = !!session?.authenticated && session.user?.role === "admin";
  const canUpload = isAdmin && !loading && !loadError;
  const showLogin = !!session && !session.authenticated;
  const pickFiles = () => inputRef.current?.click();

  function openAction(kind: BookAction["kind"], book: Book, target: HTMLButtonElement) {
    if (!session?.authenticated || (kind !== "clearHistory" && !isAdmin)) return;
    const menu = target.closest("details");
    menu?.removeAttribute("open");
    menu?.querySelector("summary")?.focus();
    setAction({ kind, book });
  }

  function saveBookAction(book: Book | null) {
    if (!action) return;
    setBooks(previous => book ? previous.map(existing => existing.id === book.id ? book : existing) : previous.filter(existing => existing.id !== action.book.id));
    if (action.kind === "clearHistory") {
      clearedHistoryBook.current = action.book.id;
      setNotice("Reading history cleared.");
    } else {
      setNotice(book ? "Book renamed." : "Book deleted.");
    }
  }

  function openReader(event: MouseEvent<HTMLAnchorElement>) {
    if (!pendingCount) return;
    event.preventDefault();
    setNotice("Wait for your uploads to finish before opening a book.");
  }

  let content: ReactNode;
  if (sessionError) {
    content = (
      <section className="shelf-state-card">
        <CircleAlert size={28} strokeWidth={1.5} />
        <h1>Unable to connect</h1>
        <p>{sessionError}</p>
        <button className="shelf-button shelf-button-primary" onClick={() => { setLoading(true); void loadSession(); }}><RotateCcw size={16} />Try again</button>
      </section>
    );
  } else if (showLogin && !session.passwordRequired) {
    content = (
      <section className="shelf-state-card">
        <LockKeyhole size={28} strokeWidth={1.5} />
        <h1>Library unavailable</h1>
        <p>Ask the administrator to finish setting up access, then try again.</p>
        <button className="shelf-button shelf-button-primary" onClick={() => void loadSession()}><RotateCcw size={16} />Try again</button>
      </section>
    );
  } else if (showLogin) {
    content = (
      <section className="shelf-login">
        <form className="shelf-login-form" onSubmit={login}>
          <h1>Your library</h1>
          <p>Sign in to continue where you left off.</p>
          <label className="shelf-field-label">Username<input autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus value={username} onChange={event => setUsername(event.target.value)} required disabled={loginBusy} /></label>
          <label className="shelf-field-label">Library password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={loginBusy} /></label>
          {loginError && <p className="shelf-form-error" role="alert"><CircleAlert size={16} />{loginError}</p>}
          <button type="submit" className="shelf-button shelf-button-primary" disabled={loginBusy || !username.trim() || !password}>{loginBusy && <LoaderCircle size={16} className="shelf-spin" />}Open library<ArrowRight size={16} /></button>
          <p className="shelf-login-help">Need an account or a password reset? Ask the library administrator for a link.</p>
        </form>
      </section>
    );
  } else {
    content = <>
      <section className="shelf-library-header">
        <div className="shelf-library-heading">
          <h1 id="shelf-collection-title">Library</h1>
          <p>{books.length} {books.length === 1 ? "book" : "books"}{books.length > 0 && <> · {formatBytes(totalSize)}</>}</p>
        </div>
        {recent && !loading && (
          <Link href={`/read/${recent.id}`} onClick={openReader} className="shelf-continue" aria-label={`Continue reading ${recent.title}`}>
            <BookCover key={recent.id} book={recent} small />
            <div className="shelf-continue-copy"><span>Continue reading</span><h2 title={recent.title}>{recent.title}</h2><p>Page {recent.currentPage} of {recent.pageCount}</p></div>
            <ArrowRight size={17} />
          </Link>
        )}
      </section>
      <section className="shelf-collection" aria-labelledby="shelf-collection-title">
        <div className="shelf-collection-bar">
          <label className="shelf-search"><Search size={16} /><span className="sr-only">Search books</span><input type="search" placeholder="Search books" value={query} onChange={event => setQuery(event.target.value)} disabled={!session?.authenticated || loading} /></label>
          <label className="shelf-sort"><span className="sr-only">Sort books</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Recently read</option><option value="added">Recently added</option><option value="title">Title</option></select><ChevronDown size={14} /></label>
        </div>
        {isAdmin && uploads.length > 0 && <UploadList uploads={uploads} onRetry={id => updateUpload(id, { status: "queued", progress: 0, error: undefined })} onClear={() => setUploads(previous => previous.filter(item => !["done", "error"].includes(item.status)))} />}
        {loading || !session ? (
          <div className="shelf-loading" role="status"><LoaderCircle className="shelf-spin" size={20} strokeWidth={1.5} /><span>Loading library</span></div>
        ) : loadError ? (
          <div className="shelf-state-card shelf-state-inline"><CircleAlert size={28} strokeWidth={1.5} /><h2>Unable to load library</h2><p>{loadError}</p><button className="shelf-button shelf-button-light" onClick={() => void loadBooks()}><RotateCcw size={16} />Try again</button></div>
        ) : books.length === 0 ? (
          <div className="shelf-empty">
            <BookOpen size={32} strokeWidth={1.2} />
            <h2>Your library is empty</h2>
            <p>{isAdmin ? "Add a PDF to start reading." : "Books added by the administrator will appear here."}</p>
            {isAdmin && <><button type="button" className="shelf-button shelf-button-primary" onClick={pickFiles} disabled={!canUpload}><Plus size={16} />Upload PDF</button>
            <span className="shelf-upload-hint">Or drop your files here{maxUploadBytes > 0 && <> · {formatBytes(maxUploadBytes)} per file</>}</span></>}
          </div>
        ) : filteredBooks.length === 0 ? (
          <div className="shelf-no-results"><Search size={28} strokeWidth={1.4} /><h2>No books found</h2><p>Try a different title.</p><button className="shelf-button shelf-button-light" onClick={() => setQuery("")}>Clear search</button></div>
        ) : <>
          <div className="shelf-book-grid">{filteredBooks.map(book => {
            const percentage = Math.min(100, Math.round(book.currentPage / Math.max(1, book.pageCount) * 100));
            return (
              <article key={book.id} className="shelf-book-card">
                <Link className="shelf-book-link" href={`/read/${book.id}`} onClick={openReader} aria-label={`Read ${book.title}`}><BookCover book={book} /><h3 title={book.title}>{book.title}</h3></Link>
                <div className="shelf-book-meta">
                  <span>{book.pageCount.toLocaleString("en-US")} {book.pageCount === 1 ? "page" : "pages"}{book.lastReadAt && <> · {percentage}% read</>}</span>
                  <div className="shelf-book-tools">{isAdmin && <a className="shelf-icon-button" href={`/api/books/${book.id}/file`} download={book.originalName} aria-label={`Download ${book.title}`} title="Download PDF"><ArrowDownToLine size={15} /></a>}
                  {(isAdmin || book.lastReadAt) && <details className="shelf-book-menu">
                    <summary className="shelf-icon-button" aria-label={isAdmin ? `Manage ${book.title}` : `Reading options for ${book.title}`}><Ellipsis size={18} /></summary>
                    <div className="shelf-book-menu-options">
                      {book.lastReadAt && <button type="button" onClick={event => openAction("clearHistory", book, event.currentTarget)}><RotateCcw size={14} />Clear history</button>}
                      {isAdmin && <><button type="button" onClick={event => openAction("rename", book, event.currentTarget)}><Pencil size={14} />Rename</button><button type="button" className="shelf-menu-danger" onClick={event => openAction("delete", book, event.currentTarget)}><Trash2 size={14} />Delete book</button></>}
                    </div>
                  </details>}</div>
                </div>
                {book.lastReadAt && <div className="shelf-book-reading-track" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></div>}
              </article>
            );
          })}</div>
          <div className="shelf-collection-bottom"><span>{query.trim() ? `${filteredBooks.length} ${filteredBooks.length === 1 ? "result" : "results"}` : isAdmin ? "Drop PDF files anywhere to add them." : "Your reading progress is saved to your account."}</span>{isAdmin && maxUploadBytes > 0 && <span>{formatBytes(maxUploadBytes)} per file</span>}</div>
        </>}
      </section>
    </>;
  }

  return (
    <div className="shelf-app" onDragEnter={event => { if (!canUpload || !event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragCounter.current++; setDragging(true); }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = canUpload ? "copy" : "none"; } }} onDragLeave={event => { if (!canUpload) return; event.preventDefault(); dragCounter.current = Math.max(0, dragCounter.current - 1); if (!dragCounter.current) setDragging(false); }} onDrop={event => { event.preventDefault(); dragCounter.current = 0; setDragging(false); enqueue(event.dataTransfer.files); }}>
      <header className="shelf-header">
        <div className="shelf-header-inner">
          <Link className="shelf-brand" href="/" aria-label="Shelf home">Shelf.</Link>
          <div className="shelf-header-actions">
            {session?.authenticated && session.user && <>
              {isAdmin && <button className="shelf-button shelf-button-primary shelf-header-upload" type="button" title="Upload PDF" onClick={pickFiles} disabled={!canUpload}><Plus size={16} /><span>Upload PDF</span></button>}
              <button className="shelf-button shelf-button-light shelf-account-button" type="button" onClick={() => setAccountOpen(true)} aria-label="Account settings" title={`Account settings · ${session.user.username}`}><UserRound size={16} /><span>{session.user.username}</span></button>
            </>}
            <ThemeToggle />
            {session?.authenticated && session.user && <button className="shelf-icon-button shelf-logout" type="button" onClick={() => void logout()} aria-label="Sign out" title={pendingCount ? "Wait for uploads to finish before signing out" : "Sign out"} disabled={!!pendingCount || logoutBusy}><LogOut size={17} /></button>}
          </div>
        </div>
      </header>
      {isAdmin && <input ref={inputRef} type="file" accept=".pdf,application/pdf" multiple className="sr-only" tabIndex={-1} aria-label="Choose PDF files" onChange={event => { enqueue(event.target.files); event.currentTarget.value = ""; }} />}
      <main className="shelf-main">{content}</main>
      {session?.authenticated && session.user && <ChatPanel key={session.user.id} user={session.user} onUnauthorized={requireLogin} />}
      {dragging && <div className="shelf-drop-overlay" aria-hidden="true"><div><ArrowDownToLine size={32} strokeWidth={1.4} /><h2>Drop PDFs to upload</h2><p>Add files to your library.</p></div></div>}
      {session?.authenticated && action && (isAdmin || action.kind === "clearHistory") && <BookDialog key={`${action.kind}-${action.book.id}`} action={action} onClose={() => setAction(null)} onUnauthorized={requireLogin} onSaved={saveBookAction} />}
      {accountOpen && session?.user && <AccountPanel user={session.user} onClose={() => setAccountOpen(false)} onUnauthorized={requireLogin} onSession={setSession} />}
      {notice && <div className="shelf-toast" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button className="shelf-icon-button" type="button" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={16} /></button></div>}
    </div>
  );
}
