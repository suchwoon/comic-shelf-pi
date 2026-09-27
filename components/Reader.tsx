"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { ArrowLeft, ArrowLeftRight, BookOpen, Check, ChevronLeft, ChevronRight, Eye, EyeOff, LoaderCircle, Maximize, Minimize, RotateCcw } from "lucide-react";
import { ImagePageDocument, type PageDocument } from "@/lib/reader/page-document";
import type { Book, ReadingDirection } from "@/lib/types";
import { PdfPageCache } from "@/lib/reader/page-cache";
import { ProgressSaveQueue, type ProgressSnapshot, type SaveStatus } from "@/lib/reader/progress";

const PAGE_LOADING_DELAY_MS = 200;
const TAP_MAX_DISTANCE = 12;
const TAP_MAX_DURATION_MS = 500;

type PageTap = { pointerId: number; x: number; y: number; time: number; target: HTMLButtonElement };

function useProgress(bookId: string) {
  const latest = useRef<ProgressSnapshot | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const missingRef = useRef(false);
  const [missing, setMissing] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const queue = useMemo(() => new ProgressSaveQueue(async value => {
    if (missingRef.current) throw new Error("book_not_found");
    const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/progress`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
      keepalive: true,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) window.location.assign("/");
    if (response.status === 404) {
      missingRef.current = true;
      if (mounted.current) setMissing(true);
    }
    if (!response.ok) throw new Error("save_failed");
  }, value => { if (mounted.current) setStatus(value); }), [bookId]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (missingRef.current) return true;
    const saved = await queue.flush();
    // A deleted book has no reading position left to save and cannot block exit.
    return saved || missingRef.current;
  }, [queue]);

  const change = useCallback((patch: Partial<ProgressSnapshot>) => {
    if (!latest.current || missingRef.current) return;
    latest.current = { ...latest.current, ...patch };
    queue.change(latest.current);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 450);
  }, [flush, queue]);

  useEffect(() => {
    mounted.current = true;
    const onPageHide = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (!missingRef.current) queue.sendLatest();
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") onPageHide(); };
    const onOnline = () => void flush();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      onPageHide();
    };
  }, [flush, queue]);

  return { latest, change, flush, status, missing };
}

export default function Reader({ bookId }: { bookId: string }) {
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [pageDocument, setPageDocument] = useState<PageDocument | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const requestedPage = useRef(1);
  const [pageInput, setPageInput] = useState("1");
  const [direction, setDirection] = useState<ReadingDirection>("ltr");
  const [controls, setControls] = useState(true);
  const [touchNavigation, setTouchNavigation] = useState(false);
  const [showTouchHint, setShowTouchHint] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const leavingRef = useRef(false);
  const [rendering, setRendering] = useState(true);
  const [showPageLoading, setShowPageLoading] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasCenterRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const centerTapRef = useRef<HTMLButtonElement>(null);
  const initialReadMarked = useRef(false);
  const tapStart = useRef<PageTap | null>(null);
  const tapClick = useRef<{ target: HTMLButtonElement; time: number } | null>(null);
  const { latest, change, flush, status: saveStatus, missing } = useProgress(bookId);
  const pageCache = useMemo(() => pageDocument ? new PdfPageCache(pageDocument) : null, [pageDocument]);

  const backToLibrary = async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    setNavigationError("");
    if (await flush()) {
      router.push("/");
    } else {
      leavingRef.current = false;
      setLeaving(false);
      setControls(true);
      setNavigationError("Your reading position could not be saved. Check your connection and try again.");
    }
  };

  useEffect(() => () => pageCache?.dispose(), [pageCache]);

  useEffect(() => {
    // Input capability also covers phones held in landscape, without changing
    // the desktop reader when a mouse user simply narrows their window.
    const media = window.matchMedia("(hover: none) and (pointer: coarse)");
    const update = () => {
      setTouchNavigation(media.matches);
      setControls(!media.matches);
      tapStart.current = null;
      tapClick.current = null;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const pageReady = renderedPage !== null;
  useEffect(() => {
    if (!touchNavigation || !pageReady || !showTouchHint) return;
    const timer = window.setTimeout(() => setShowTouchHint(false), 5000);
    return () => window.clearTimeout(timer);
  }, [touchNavigation, pageReady, showTouchHint]);

  useEffect(() => {
    let active = true;
    let document: PageDocument | undefined;
    const controller = new AbortController();
    setLoadError("");
    setPageDocument(null);
    setBook(null);
    initialReadMarked.current = false;
    setRenderedPage(null);
    async function load() {
      try {
        const response = await fetch(`/api/books/${encodeURIComponent(bookId)}`, { signal: controller.signal, cache: "no-store" });
        if (response.status === 401) { window.location.replace("/"); return; }
        if (!response.ok) throw new Error(response.status === 404 ? "book_not_found" : "book_load_failed");
        const data = await response.json();
        if (!active) return;
        const value = data.book as Book;
        setBook({ ...value, fit: "page" });
        setDirection(value.direction);
        // Older books may have saved width-fit settings. The reader now always
        // fits a full page, and the first successful read persists that setting.
        // Page images are rendered on the server. The browser never receives
        // original PDF bytes, including when an administrator reads a book.
        document = new ImagePageDocument(bookId, value.pageCount);
        const initialPage = Math.max(1, Math.min(value.currentPage, value.pageCount));
        requestedPage.current = initialPage;
        setPage(initialPage);
        setPageInput(String(initialPage));
        latest.current = { currentPage: initialPage, direction: value.direction, fit: "page" };
        setPageDocument(document);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "";
        setLoadError(message === "book_not_found" ? "This book is no longer in your library." : "Check your connection and try again.");
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
      document?.destroy();
    };
  }, [bookId, loadAttempt, latest]);

  useEffect(() => {
    const element = viewportRef.current;
    const center = canvasCenterRef.current;
    if (!element || !center) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const padding = getComputedStyle(center);
      setSize({
        width: Math.max(0, Math.floor(rect.width - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight))),
        height: Math.max(0, Math.floor(rect.height - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom))),
      });
    };
    measure();
    const observer = new ResizeObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(measure, 100);
    });
    observer.observe(element);
    return () => { clearTimeout(timeout); observer.disconnect(); };
  }, [touchNavigation]);

  useEffect(() => {
    if (!pageCache || !size.width || !size.height || leaving || missing) return;
    let active = true;
    const layout = { ...size, fit: "page" as const, zoom: 1, pixelRatio: window.devicePixelRatio || 1 };
    setRendering(true);
    setShowPageLoading(false);
    setRenderError("");
    // A prepared page replaces the old canvas before this indicator is needed.
    // Keep the previous page fully visible during uncached/slow transitions too.
    const loadingTimer = window.setTimeout(() => {
      if (active) setShowPageLoading(true);
    }, PAGE_LOADING_DELAY_MS);
    async function render() {
      try {
        const canvas = await pageCache!.request(page, layout);
        if (!active || !surfaceRef.current || requestedPage.current !== page || leavingRef.current) return;
        canvas.setAttribute("aria-label", `${book?.title ?? "Comic"}, page ${page}`);
        surfaceRef.current.replaceChildren(canvas);
        pageCache!.commit(canvas);
        window.clearTimeout(loadingTimer);
        setRenderedPage(page);
        setRendering(false);
        setShowPageLoading(false);
        // Only displayed pages become bookmarks. Navigation may still be loading
        // or fail while the previous canvas remains visible.
        if (!initialReadMarked.current || latest.current?.currentPage !== page) {
          initialReadMarked.current = true;
          change({ currentPage: page, fit: "page" });
        }
        // Only a visible page schedules nearby work; stale navigation cannot
        // warm the wrong neighborhood or change the saved reading position.
        pageCache!.prefetch(page, layout);
      } catch (error) {
        if (!active || (error instanceof Error && ["AbortError", "RenderingCancelledException"].includes(error.name))) return;
        window.clearTimeout(loadingTimer);
        setRenderError("Try again or move to another page.");
        setRendering(false);
        setShowPageLoading(false);
      }
    }
    void render();
    return () => { active = false; window.clearTimeout(loadingTimer); };
  }, [pageCache, page, size, renderAttempt, book?.title, latest, change, leaving, missing]);

  useEffect(() => {
    setPageInput(String(page));
    viewportRef.current?.scrollTo({ top: 0, left: 0 });
  }, [page]);

  useEffect(() => {
    setFullscreenAvailable(Boolean(document.fullscreenEnabled && rootRef.current?.requestFullscreen));
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const goToPage = useCallback((nextPage: number) => {
    if (leavingRef.current || missing || !pageDocument || !Number.isFinite(nextPage)) return;
    const next = Math.max(1, Math.min(pageDocument.numPages, Math.trunc(nextPage)));
    requestedPage.current = next;
    setPage(next);
    setPageInput(String(next));
  }, [pageDocument, missing]);

  const toggleDirection = () => {
    const value = direction === "ltr" ? "rtl" : "ltr";
    setDirection(value);
    change({ direction: value });
  };

  const toggleFullscreen = useCallback(async () => {
    setFullscreenError("");
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {
      setFullscreenError("Fullscreen is not available in this browser.");
    }
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!pageDocument || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      const current = requestedPage.current;
      if (event.key === "ArrowRight") goToPage(current + (direction === "ltr" ? 1 : -1));
      else if (event.key === "ArrowLeft") goToPage(current + (direction === "ltr" ? -1 : 1));
      else if (event.key === "Home") goToPage(1);
      else if (event.key === "End") goToPage(pageDocument.numPages);
      else if (event.key.toLowerCase() === "h") setControls(value => !value);
      else if (event.key.toLowerCase() === "f" && fullscreenAvailable) void toggleFullscreen();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [pageDocument, direction, goToPage, fullscreenAvailable, toggleFullscreen]);

  const pageCount = pageDocument?.numPages ?? book?.pageCount ?? 0;
  const bookError = missing ? "This book is no longer in your library." : loadError;
  const leftIsNext = direction === "rtl";
  const submitPage = () => {
    if (/^\d+$/.test(pageInput)) goToPage(Number(pageInput));
    else setPageInput(String(page));
  };

  const startTap = (event: PointerEvent<HTMLDivElement>) => {
    tapClick.current = null;
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".reader-tap-zone") : null;
    // A second finger anywhere in the reader cancels the whole gesture.
    tapStart.current = touchNavigation && target && event.isPrimary && event.button === 0
      ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, target }
      : null;
  };
  const moveTap = (event: PointerEvent<HTMLDivElement>) => {
    const start = tapStart.current;
    if (start?.pointerId === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_MAX_DISTANCE) {
      tapStart.current = null;
    }
  };
  const endTap = (event: PointerEvent<HTMLDivElement>) => {
    const start = tapStart.current;
    tapStart.current = null;
    tapClick.current = start?.pointerId === event.pointerId
      && event.timeStamp - start.time <= TAP_MAX_DURATION_MS
      && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= TAP_MAX_DISTANCE
      ? { target: start.target, time: event.timeStamp } : null;
  };
  const cancelTap = () => {
    tapStart.current = null;
    tapClick.current = null;
  };
  const activateTap = (event: MouseEvent<HTMLButtonElement>, area: "left" | "center" | "right") => {
    const click = tapClick.current;
    tapClick.current = null;
    // Native clicks keep keyboard and screen-reader activation available.
    // Pointer clicks must belong to a short, stationary, single-finger tap.
    if (event.detail !== 0 && (!click || click.target !== event.currentTarget || event.timeStamp - click.time > TAP_MAX_DURATION_MS)) return;
    if (area === "center") {
      setShowTouchHint(false);
      setControls(value => !value);
    } else {
      // While browser-zoomed, touches are for inspecting/panning the page.
      if (event.detail !== 0 && (window.visualViewport?.scale ?? 1) > 1.01) return;
      setShowTouchHint(false);
      const next = (area === "left") === leftIsNext;
      goToPage(requestedPage.current + (next ? 1 : -1));
    }
  };

  return (
    <div className={`reader-root${touchNavigation ? " reader-touch" : ""}${controls ? "" : " reader-controls-hidden"}`} ref={rootRef}
      onPointerDownCapture={startTap} onPointerMoveCapture={moveTap} onPointerUpCapture={endTap} onPointerCancelCapture={cancelTap}>
      <header className="reader-heading">
        <Link className="reader-back" href="/" onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          void backToLibrary();
        }} aria-label="Back to library" aria-busy={leaving}>
          <ArrowLeft size={18} /><span>{leaving ? "Saving…" : "Library"}</span>
        </Link>
        <h1 className="reader-book-title" title={book?.title}>{book?.title || "Opening book"}</h1>
        <div className="reader-heading-actions">
          <button type="button" className="reader-direction reader-button" onClick={toggleDirection} disabled={!pageDocument || leaving || missing} title="Change reading direction" aria-label={`Reading direction: ${direction === "ltr" ? "Left to right" : "Right to left"}`}>
            <ArrowLeftRight size={17} /><span>{direction === "ltr" ? "Left to right" : "Right to left"}</span>
          </button>
          <button type="button" className="reader-icon-button" onClick={() => {
            setControls(false);
            centerTapRef.current?.focus({ preventScroll: true });
          }} aria-label="Hide controls" title="Hide controls (H)"><EyeOff size={18} /></button>
        </div>
      </header>

      {!controls && !touchNavigation && <button type="button" className="reader-reveal reader-button" onClick={() => setControls(true)} aria-label="Show controls" title="Show controls (H)"><Eye size={17} /><span>Show controls</span></button>}

      <main className="reader-workspace" aria-label="Comic reader">
        <div className="reader-canvas-scroll" ref={viewportRef} tabIndex={0} aria-label="Comic page">
          <div ref={canvasCenterRef} className="reader-canvas-center"><div className={`reader-page-surface${renderError ? " reader-page-pending" : ""}`} ref={surfaceRef} aria-busy={rendering} /></div>
        </div>
        {touchNavigation && <div className="reader-tap-zones" role="group" aria-label="Touch navigation">
          <button type="button" className="reader-tap-zone" onClick={event => activateTap(event, "left")}
            disabled={!pageDocument || !pageReady || missing || (leftIsNext ? page >= pageCount : page <= 1)}
            aria-label={`${leftIsNext ? "Next" : "Previous"} page (left area)`} />
          <button type="button" className="reader-tap-zone" ref={centerTapRef} onClick={event => activateTap(event, "center")}
            aria-label={`${controls ? "Hide" : "Show"} controls (center area)`} aria-expanded={controls} />
          <button type="button" className="reader-tap-zone" onClick={event => activateTap(event, "right")}
            disabled={!pageDocument || !pageReady || missing || (leftIsNext ? page <= 1 : page >= pageCount)}
            aria-label={`${leftIsNext ? "Previous" : "Next"} page (right area)`} />
        </div>}
        {touchNavigation && pageReady && showTouchHint && !controls && <p className="reader-touch-hint" role="status">
          Tap the sides to turn pages. Tap the center for controls.
        </p>}
        {(bookError || renderError) ? (
          <div className="reader-message" role="alert">
            <BookOpen size={25} />
            <h2>{bookError ? "Unable to open this book" : "Unable to load this page"}</h2>
            <p>{bookError || renderError}</p>
            {!missing && <button type="button" className="reader-primary" onClick={() => loadError ? setLoadAttempt(value => value + 1) : setRenderAttempt(value => value + 1)}><RotateCcw size={15} />Try again</button>}
            {bookError && <Link href="/" className="reader-message-back">Back to library</Link>}
          </div>
        ) : (!pageDocument || (rendering && (renderedPage === null || showPageLoading))) && (
          <div className={`reader-loading${renderedPage ? " reader-loading-small" : ""}`} role="status">
            <LoaderCircle className="reader-spin" size={22} />
            <span>{!pageDocument ? "Opening book" : "Loading page"}</span>
          </div>
        )}
      </main>

      <footer className="reader-footer">
        <div className="reader-save-status" role="status">
          {missing ? <span>Book deleted</span> : saveStatus === "error" ? (
            <button type="button" onClick={() => void flush()} title="Progress could not be saved. Retry" aria-label="Save failed. Retry"><RotateCcw size={14} /><span>Retry save</span></button>
          ) : saveStatus === "saving" ? (
            <><LoaderCircle className="reader-spin" size={13} /><span>Saving</span></>
          ) : saveStatus === "saved" ? (
            <><Check size={14} /><span>Saved</span></>
          ) : <span className="reader-save-idle">Auto-save on</span>}
        </div>
        <div className="reader-pagination" aria-label="Page navigation">
          <button type="button" className="reader-page-button" disabled={!pageDocument || missing || (leftIsNext ? page >= pageCount : page <= 1)} onClick={() => goToPage(requestedPage.current + (leftIsNext ? 1 : -1))} aria-label={leftIsNext ? "Next page" : "Previous page"} title={leftIsNext ? "Next page (←)" : "Previous page (←)"}>
            <ChevronLeft size={19} /><span>{leftIsNext ? "Next" : "Previous"}</span>
          </button>
          <form className="reader-page-form" onSubmit={event => { event.preventDefault(); submitPage(); }}>
            <label className="sr-only" htmlFor="reader-page-input">Page number</label>
            <input id="reader-page-input" type="text" inputMode="numeric" pattern="[0-9]*" value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={submitPage} onFocus={event => event.target.select()} disabled={!pageDocument || missing} autoComplete="off" maxLength={6} aria-describedby="reader-total-pages" />
            <span id="reader-total-pages">/ {pageCount || "—"}</span>
            <button type="submit" className="sr-only" disabled={!pageDocument || missing}>Go to page</button>
          </form>
          <button type="button" className="reader-page-button" disabled={!pageDocument || missing || (leftIsNext ? page <= 1 : page >= pageCount)} onClick={() => goToPage(requestedPage.current + (leftIsNext ? -1 : 1))} aria-label={leftIsNext ? "Previous page" : "Next page"} title={leftIsNext ? "Previous page (→)" : "Next page (→)"}>
            <span>{leftIsNext ? "Previous" : "Next"}</span><ChevronRight size={19} />
          </button>
        </div>
        <div className="reader-footer-actions">
          {fullscreenAvailable && <button type="button" className="reader-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} title={fullscreen ? "Exit fullscreen (F)" : "Enter fullscreen (F)"}>{fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}</button>}
        </div>
      </footer>
      {fullscreenError && <div className="reader-toast" role="status"><span>{fullscreenError}</span><button type="button" onClick={() => setFullscreenError("")}>Dismiss</button></div>}
      {navigationError && <div className="reader-toast" role="alert"><span>{navigationError}</span><button type="button" onClick={() => void backToLibrary()}>Try again</button></div>}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{pageDocument && !rendering && !bookError && !renderError ? `Page ${renderedPage} of ${pageCount}` : ""}</span>
    </div>
  );
}
