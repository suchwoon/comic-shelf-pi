"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, Columns2, Eye, EyeOff, LoaderCircle, Maximize, Minimize, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { ImagePageDocument, type PageDocument } from "@/lib/reader/page-document";
import type { Book, ReadingDirection } from "@/lib/types";
import { PdfPageCache } from "@/lib/reader/page-cache";
import { WheelPageGesture } from "@/lib/reader/wheel-navigation";
import { ProgressSaveQueue, type ProgressSnapshot, type SaveStatus } from "@/lib/reader/progress";

const PAGE_LOADING_DELAY_MS = 200;
const TAP_MAX_DISTANCE = 12;
const TAP_MAX_DURATION_MS = 500;
const TWO_PAGE_STORAGE_KEY = "comic-shelf:two-page-view";

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
  const [editingPage, setEditingPage] = useState(false);
  const [direction, setDirection] = useState<ReadingDirection>("ltr");
  const [twoPages, setTwoPages] = useState(false);
  const [controls, setControls] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [renderedPages, setRenderedPages] = useState<number[]>([]);
  const displayedPages = useRef<number[]>([]);
  const spreadNavigating = useRef(false);
  const wheelGesture = useRef(new WheelPageGesture());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasCenterRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const centerTapRef = useRef<HTMLButtonElement>(null);
  const revealRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
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
    try { setTwoPages(localStorage.getItem(TWO_PAGE_STORAGE_KEY) === "true"); }
    catch { /* Reading remains available when browser storage is disabled. */ }
  }, []);

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
    setRenderedPages([]);
    displayedPages.current = [];
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
    spreadNavigating.current = true;
    setShowPageLoading(false);
    setRenderError("");
    // A prepared page replaces the old canvas before this indicator is needed.
    // Keep the previous page fully visible during uncached/slow transitions too.
    const loadingTimer = window.setTimeout(() => {
      if (active) setShowPageLoading(true);
    }, PAGE_LOADING_DELAY_MS);
    async function render() {
      try {
        const spread = twoPages
          ? await pageCache!.requestSpread(page, layout)
          : { pages: [page], canvases: [await pageCache!.request(page, layout)] };
        if (!active || !surfaceRef.current || requestedPage.current !== page || leavingRef.current) return;
        spread.canvases.forEach((canvas, index) => canvas.setAttribute("aria-label", `${book?.title ?? "Comic"}, page ${spread.pages[index]}`));
        surfaceRef.current.replaceChildren(...(direction === "rtl" ? [...spread.canvases].reverse() : spread.canvases));
        if (twoPages) pageCache!.commitSpread(spread.canvases);
        else pageCache!.commit(spread.canvases[0]);
        window.clearTimeout(loadingTimer);
        displayedPages.current = spread.pages;
        setRenderedPages(spread.pages);
        setRenderedPage(page);
        spreadNavigating.current = false;
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
        if (twoPages) pageCache!.prefetchSpread(page, layout);
        else pageCache!.prefetch(page, layout);
      } catch (error) {
        if (!active || (error instanceof Error && ["AbortError", "RenderingCancelledException"].includes(error.name))) return;
        window.clearTimeout(loadingTimer);
        setRenderError("Try again or move to another page.");
        spreadNavigating.current = false;
        setRendering(false);
        setShowPageLoading(false);
      }
    }
    void render();
    return () => { active = false; window.clearTimeout(loadingTimer); };
  }, [pageCache, page, size, renderAttempt, book?.title, latest, change, leaving, missing, twoPages, direction]);

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

  useEffect(() => {
    if (!controls) setSettingsOpen(false);
  }, [controls]);

  useEffect(() => {
    if (!settingsOpen || !controls) return;
    const panel = settingsPanelRef.current;
    (panel?.querySelector<HTMLButtonElement>(".reader-setting:not(:disabled)") ?? panel?.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !panel?.contains(target) && !settingsButtonRef.current?.contains(target)) {
        setSettingsOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setSettingsOpen(false);
      settingsButtonRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [settingsOpen, controls]);

  const goToPage = useCallback((nextPage: number) => {
    if (leavingRef.current || missing || !pageDocument || !Number.isFinite(nextPage)) return;
    const next = Math.max(1, Math.min(pageDocument.numPages, Math.trunc(nextPage)));
    setPageInput(String(next));
    if (next === requestedPage.current) {
      if (renderError) setRenderAttempt(value => value + 1);
      return;
    }
    if (twoPages) spreadNavigating.current = true;
    requestedPage.current = next;
    setPage(next);
  }, [pageDocument, missing, twoPages, renderError]);

  const goRelative = useCallback((delta: -1 | 1) => {
    if (!twoPages) {
      goToPage(requestedPage.current + delta);
      return;
    }
    // Wait for the current spread to determine its actual boundaries: a wide
    // source page may stand alone. Never skip its portrait neighbor.
    if (spreadNavigating.current || !displayedPages.current.length) return;
    const boundary = delta > 0 ? displayedPages.current.at(-1)! : displayedPages.current[0];
    goToPage(boundary + delta);
  }, [goToPage, twoPages]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const workspace = viewport?.parentElement;
    if (!viewport || !workspace) return;
    const gesture = wheelGesture.current;
    const wheel = (event: WheelEvent) => {
      if (!pageDocument || leavingRef.current || missing || !displayedPages.current.length) return;
      const control = event.target instanceof Element
        ? event.target.closest("input, textarea, select, button, a, [contenteditable=true]") : null;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || (window.visualViewport?.scale ?? 1) > 1.01
        || (control && !control.classList.contains("reader-tap-zone"))) {
        gesture.reset();
        return;
      }
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (viewport.scrollHeight > viewport.clientHeight + 1 || viewport.scrollWidth > viewport.clientWidth + 1) {
        gesture.reset();
        return;
      }
      event.preventDefault();
      const delta = gesture.consume(event, viewport.clientHeight);
      if (delta) goRelative(delta);
    };
    workspace.addEventListener("wheel", wheel, { passive: false });
    return () => workspace.removeEventListener("wheel", wheel);
  }, [goRelative, pageDocument, missing]);

  const toggleTwoPages = () => {
    const value = !twoPages;
    spreadNavigating.current = true;
    setTwoPages(value);
    wheelGesture.current.reset();
    try { localStorage.setItem(TWO_PAGE_STORAGE_KEY, String(value)); }
    catch { /* The preference still applies for this reading session. */ }
  };

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
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true], .reader-settings-panel")) return;
      if (event.key === "ArrowRight") goRelative(direction === "ltr" ? 1 : -1);
      else if (event.key === "ArrowLeft") goRelative(direction === "ltr" ? -1 : 1);
      else if (event.key === "Home") goToPage(1);
      else if (event.key === "End") goToPage(pageDocument.numPages);
      else if (event.key.toLowerCase() === "h") setControls(value => !value);
      else if (event.key.toLowerCase() === "f" && fullscreenAvailable) void toggleFullscreen();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [pageDocument, direction, goToPage, goRelative, fullscreenAvailable, toggleFullscreen]);

  const pageCount = pageDocument?.numPages ?? book?.pageCount ?? 0;
  const bookError = missing ? "This book is no longer in your library." : loadError;
  const leftIsNext = direction === "rtl";
  const firstVisiblePage = renderedPages[0] ?? page;
  const lastVisiblePage = renderedPages.at(-1) ?? page;
  const atStart = (twoPages ? firstVisiblePage : page) <= 1;
  const atEnd = (twoPages ? lastVisiblePage : page) >= pageCount;
  const pageRange = renderedPages.length > 1 ? `${firstVisiblePage}–${lastVisiblePage}` : "";
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
      goRelative(next ? 1 : -1);
    }
  };

  return (
    <div className={`reader-root${touchNavigation ? " reader-touch" : ""}${controls ? "" : " reader-controls-hidden"}`} ref={rootRef}
      onPointerDownCapture={startTap} onPointerMoveCapture={moveTap} onPointerUpCapture={endTap} onPointerCancelCapture={cancelTap}>
      <header className="reader-heading">
        <div className="reader-heading-book">
          <Link className="reader-back reader-glass" href="/" onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            void backToLibrary();
          }} aria-label="Back to library" aria-busy={leaving}>
            {leaving ? <LoaderCircle className="reader-spin" size={18} /> : <ArrowLeft size={19} />}<span className="sr-only">{leaving ? "Saving…" : "Library"}</span>
          </Link>
          <h1 className="reader-book-title reader-glass" title={book?.title}>{book?.title || "Opening book"}</h1>
        </div>
        <div className="reader-heading-actions">
          <button type="button" className="reader-icon-button reader-glass" ref={settingsButtonRef}
            onClick={() => setSettingsOpen(value => !value)} aria-label="Reading settings" title="Reading settings"
            aria-expanded={settingsOpen} aria-haspopup="dialog" aria-controls="reader-settings">
            <SlidersHorizontal size={18} />
          </button>
          <button type="button" className="reader-icon-button reader-glass" onClick={() => {
            setSettingsOpen(false);
            setControls(false);
            requestAnimationFrame(() => (centerTapRef.current ?? revealRef.current)?.focus({ preventScroll: true }));
          }} aria-label="Hide controls" title="Hide controls (H)"><EyeOff size={18} /></button>
          {settingsOpen && controls && <div id="reader-settings" className="reader-settings-panel reader-glass" ref={settingsPanelRef} role="dialog" aria-labelledby="reader-settings-title">
            <div className="reader-settings-heading">
              <h2 id="reader-settings-title">Reading settings</h2>
              <button type="button" className="reader-icon-button" aria-label="Close reading settings" onClick={() => {
                setSettingsOpen(false);
                settingsButtonRef.current?.focus({ preventScroll: true });
              }}><X size={17} /></button>
            </div>
            <button type="button" className="reader-setting reader-spread-toggle" onClick={toggleTwoPages}
              disabled={!pageDocument || leaving || missing} aria-label="Two-page view" aria-pressed={twoPages}>
              <Columns2 size={19} /><span><strong>Two-page view</strong><small>{twoPages ? "Two pages" : "Single page"}</small></span>
              <span className="reader-setting-switch" aria-hidden="true"><span /></span>
            </button>
            <button type="button" className="reader-setting reader-direction" onClick={toggleDirection}
              disabled={!pageDocument || leaving || missing} aria-label={`Reading direction: ${direction === "ltr" ? "Left to right" : "Right to left"}`}>
              {direction === "ltr" ? <ArrowRight size={19} /> : <ArrowLeft size={19} />}
              <span><strong>Reading direction</strong><small>{direction === "ltr" ? "Left to right" : "Right to left"}</small></span>
            </button>
            {fullscreenAvailable && <button type="button" className="reader-setting" onClick={() => void toggleFullscreen()}
              aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} title={fullscreen ? "Exit fullscreen (F)" : "Enter fullscreen (F)"}>
              {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}<span><strong>Fullscreen</strong><small>{fullscreen ? "Return to window" : "Fill your screen"}</small></span><kbd>F</kbd>
            </button>}
          </div>}
        </div>
      </header>

      {!controls && !touchNavigation && <button type="button" className="reader-reveal reader-icon-button reader-glass" ref={revealRef} onClick={() => {
        setControls(true);
        requestAnimationFrame(() => settingsButtonRef.current?.focus({ preventScroll: true }));
      }} aria-label="Show controls" title="Show controls (H)"><Eye size={18} /></button>}

      <main className="reader-workspace" aria-label="Comic reader">
        <div className="reader-canvas-scroll" ref={viewportRef} tabIndex={0} aria-label="Comic page">
          <div ref={canvasCenterRef} className="reader-canvas-center"><div className={`reader-page-surface${renderError ? " reader-page-pending" : ""}`} ref={surfaceRef} aria-busy={rendering} /></div>
        </div>
        {touchNavigation && <div className="reader-tap-zones" role="group" aria-label="Touch navigation">
          <button type="button" className="reader-tap-zone" onClick={event => activateTap(event, "left")}
            disabled={!pageDocument || !pageReady || missing || (leftIsNext ? atEnd : atStart)}
            aria-label={`${leftIsNext ? "Next" : "Previous"} page (left area)`} />
          <button type="button" className="reader-tap-zone" ref={centerTapRef} onClick={event => activateTap(event, "center")}
            aria-label={`${controls ? "Hide" : "Show"} controls (center area)`} aria-expanded={controls} />
          <button type="button" className="reader-tap-zone" onClick={event => activateTap(event, "right")}
            disabled={!pageDocument || !pageReady || missing || (leftIsNext ? atStart : atEnd)}
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
        <div className="reader-save-status reader-glass" role="status">
          {missing ? <span>Book deleted</span> : saveStatus === "error" ? (
            <button type="button" onClick={() => void flush()} title="Progress could not be saved. Retry" aria-label="Save failed. Retry"><RotateCcw size={14} /><span>Retry save</span></button>
          ) : saveStatus === "saving" ? (
            <><LoaderCircle className="reader-spin" size={13} /><span>Saving</span></>
          ) : saveStatus === "saved" ? (
            <><Check size={14} /><span>Saved</span></>
          ) : <span className="reader-save-idle">Auto-save on</span>}
        </div>
        <div className="reader-pagination reader-glass" aria-label="Page navigation">
          <button type="button" className="reader-page-button" disabled={!pageDocument || missing || (leftIsNext ? atEnd : atStart)} onClick={() => goRelative(leftIsNext ? 1 : -1)} aria-label={leftIsNext ? "Next page" : "Previous page"} title={leftIsNext ? "Next page (←)" : "Previous page (←)"}>
            <ChevronLeft size={20} />
          </button>
          <form className="reader-page-form" onSubmit={event => { event.preventDefault(); submitPage(); }}>
            <label className="sr-only" htmlFor="reader-page-input">Page number</label>
            <span className={`reader-page-input${pageRange && !editingPage ? " reader-page-input-range" : ""}`}>
              <input id="reader-page-input" type="text" inputMode="numeric" pattern="[0-9]*" value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={() => { submitPage(); setEditingPage(false); }} onFocus={event => { setEditingPage(true); event.target.select(); }} disabled={!pageDocument || missing} autoComplete="off" maxLength={6} aria-describedby="reader-total-pages" />
              {pageRange && !editingPage && <span aria-hidden="true">{pageRange}</span>}
            </span>
            <span id="reader-total-pages">/ {pageCount || "—"}</span>
            <button type="submit" className="sr-only" disabled={!pageDocument || missing}>Go to page</button>
          </form>
          <button type="button" className="reader-page-button" disabled={!pageDocument || missing || (leftIsNext ? atStart : atEnd)} onClick={() => goRelative(leftIsNext ? -1 : 1)} aria-label={leftIsNext ? "Previous page" : "Next page"} title={leftIsNext ? "Previous page (→)" : "Next page (→)"}>
            <ChevronRight size={20} />
          </button>
        </div>
      </footer>
      {fullscreenError && <div className="reader-toast" role="status"><span>{fullscreenError}</span><button type="button" onClick={() => setFullscreenError("")}>Dismiss</button></div>}
      {navigationError && <div className="reader-toast" role="alert"><span>{navigationError}</span><button type="button" onClick={() => void backToLibrary()}>Try again</button></div>}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{pageDocument && !rendering && !bookError && !renderError ? `${pageRange ? `Pages ${pageRange}` : `Page ${renderedPage}`} of ${pageCount}` : ""}</span>
    </div>
  );
}
