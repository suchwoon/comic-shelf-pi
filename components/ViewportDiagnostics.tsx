"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "comic-shelf:viewport-debug";
const SAMPLE_INTERVAL_MS = 250;
const SAMPLE_LIMIT = 20;

function rounded(value: number) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function elementGeometry(element: Element | null) {
  if (!element) return null;
  const bounds = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    rect: {
      x: rounded(bounds.x), y: rounded(bounds.y), width: rounded(bounds.width), height: rounded(bounds.height),
      right: rounded(bounds.right), bottom: rounded(bounds.bottom),
    },
    client: { width: element.clientWidth, height: element.clientHeight },
    scroll: {
      x: rounded(element.scrollLeft), y: rounded(element.scrollTop),
      width: element.scrollWidth, height: element.scrollHeight,
    },
    css: {
      position: style.position, top: style.top, bottom: style.bottom, height: style.height,
      overflowX: style.overflowX, overflowY: style.overflowY, paddingBottom: style.paddingBottom,
    },
  };
}

function captureGeometry(event: string) {
  const viewport = window.visualViewport;
  const active = document.activeElement;
  const dialogs = Array.from(document.querySelectorAll("dialog[open]"));
  return {
    ms: Math.round(performance.now()), event,
    window: {
      width: innerWidth, height: innerHeight, outerWidth, outerHeight,
      scrollX: rounded(scrollX), scrollY: rounded(scrollY),
    },
    visualViewport: viewport ? {
      width: rounded(viewport.width), height: rounded(viewport.height),
      offsetTop: rounded(viewport.offsetTop), offsetLeft: rounded(viewport.offsetLeft),
      pageTop: rounded(viewport.pageTop), pageLeft: rounded(viewport.pageLeft), scale: rounded(viewport.scale),
    } : null,
    focusedControl: active?.matches("input, textarea, select, [contenteditable=true]") ? active.tagName.toLowerCase() : null,
    html: elementGeometry(document.documentElement),
    body: elementGeometry(document.body),
    reader: elementGeometry(document.querySelector(".reader-root")),
    workspace: elementGeometry(document.querySelector(".reader-workspace")),
    canvases: Array.from(document.querySelectorAll(".reader-page-surface canvas")).map(elementGeometry),
    readerFooter: elementGeometry(document.querySelector(".reader-footer")),
    shelf: elementGeometry(document.querySelector(".shelf-app")),
    shelfMain: elementGeometry(document.querySelector(".shelf-main")),
    launcher: elementGeometry(document.querySelector(".shelf-chat-launcher")),
    dialogs: dialogs.map(dialog => ({
      kind: dialog.matches(".shelf-account-dialog") ? "account" : dialog.matches(".shelf-chat") ? "chat" : "other",
      modal: dialog.matches(":modal"), geometry: elementGeometry(dialog),
    })),
    probes: {
      fixedBottom: elementGeometry(document.querySelector("[data-viewport-probe=bottom]")),
      dynamicHeight: elementGeometry(document.querySelector("[data-viewport-probe=dvh]")),
    },
  };
}

type Sample = ReturnType<typeof captureGeometry>;

export default function ViewportDiagnostics() {
  const [enabled, setEnabled] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);
  const [notice, setNotice] = useState("");
  const [fallback, setFallback] = useState("");
  const samples = useRef<Sample[]>([]);
  const initialSample = useRef<Sample | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const captureRef = useRef<((event: string) => void) | null>(null);

  useEffect(() => {
    const readPreference = () => {
      const flag = new URLSearchParams(window.location.search).get("viewport-debug");
      let active = flag === "1";
      try {
        if (flag === "0") sessionStorage.removeItem(STORAGE_KEY);
        else if (flag === "1") sessionStorage.setItem(STORAGE_KEY, "1");
        active = flag !== "0" && (active || sessionStorage.getItem(STORAGE_KEY) === "1");
      } catch { /* A query parameter can still enable this visit without storage. */ }
      setEnabled(active);
    };
    readPreference();
    window.addEventListener("popstate", readPreference);
    return () => window.removeEventListener("popstate", readPreference);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settledTimeout: ReturnType<typeof setTimeout> | undefined;
    let lastSampleAt = 0;
    const pending = new Set<string>();
    const viewport = window.visualViewport;
    const capture = (event: string) => {
      lastSampleAt = performance.now();
      const sample = captureGeometry(event);
      initialSample.current ??= sample;
      samples.current = [...samples.current, sample].slice(-SAMPLE_LIMIT);
      setSampleCount(samples.current.length);
    };
    const flush = () => {
      timeout = undefined;
      const event = Array.from(pending).join(",");
      pending.clear();
      capture(event);
    };
    const schedule = (event: string) => {
      pending.add(event);
      if (timeout !== undefined) return;
      timeout = setTimeout(flush, Math.max(0, SAMPLE_INTERVAL_MS - (performance.now() - lastSampleAt)));
    };
    captureRef.current = capture;
    const onResize = () => schedule("window.resize");
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-viewport-diagnostics]")) return;
      schedule(event.target === document ? "document.scroll" : "element.scroll");
    };
    const onViewportResize = () => schedule("viewport.resize");
    const onViewportScroll = () => schedule("viewport.scroll");
    const onPageShow = () => schedule("pageshow");
    const onFocus = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-viewport-diagnostics]")) return;
      schedule(event.type);
    };
    // A native compositor can move without emitting viewport geometry events.
    // Capture gesture boundaries too, without retaining touch coordinates.
    const onTouch = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-viewport-diagnostics]")) return;
      schedule(event.type);
      clearTimeout(settledTimeout);
      if (event.type !== "touchstart") settledTimeout = setTimeout(() => schedule("touch.settled"), 350);
    };
    const observer = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element)
        || !record.target.closest("[data-viewport-diagnostics], [data-viewport-probe]"))) schedule("dom");
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "class"] });
    window.addEventListener("resize", onResize);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    document.addEventListener("touchstart", onTouch, { capture: true, passive: true });
    document.addEventListener("touchend", onTouch, { capture: true, passive: true });
    document.addEventListener("touchcancel", onTouch, { capture: true, passive: true });
    viewport?.addEventListener("resize", onViewportResize);
    viewport?.addEventListener("scroll", onViewportScroll);
    capture("enabled");
    return () => {
      clearTimeout(timeout);
      clearTimeout(settledTimeout);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
      document.removeEventListener("touchstart", onTouch, true);
      document.removeEventListener("touchend", onTouch, true);
      document.removeEventListener("touchcancel", onTouch, true);
      viewport?.removeEventListener("resize", onViewportResize);
      viewport?.removeEventListener("scroll", onViewportScroll);
      captureRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!fallback) return;
    textRef.current?.focus({ preventScroll: true });
    textRef.current?.select();
  }, [fallback]);

  async function copy() {
    captureRef.current?.("copy");
    const payload = JSON.stringify({
      version: 1, userAgent: navigator.userAgent, devicePixelRatio,
      screen: {
        width: screen.width, height: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight,
        orientation: screen.orientation?.type ?? null,
      },
      initial: initialSample.current, samples: samples.current,
    });
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(payload);
      setFallback("");
      setNotice("복사했습니다.");
    } catch {
      setFallback(payload);
      setNotice("아래 내용을 길게 눌러 복사해 주세요.");
    }
  }

  function close() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
    const url = new URL(window.location.href);
    if (url.searchParams.has("viewport-debug")) {
      url.searchParams.delete("viewport-debug");
      window.history.replaceState(window.history.state, "", url);
    }
    samples.current = [];
    initialSample.current = null;
    setSampleCount(0);
    setFallback("");
    setNotice("");
    setExpanded(false);
    setEnabled(false);
  }

  if (!enabled) return null;
  return <>
    <div data-viewport-probe="bottom" className="viewport-diagnostics-probe viewport-diagnostics-probe-bottom" aria-hidden="true" />
    <div data-viewport-probe="dvh" className="viewport-diagnostics-probe viewport-diagnostics-probe-dvh" aria-hidden="true" />
    <aside className="viewport-diagnostics" data-viewport-diagnostics="" aria-label="화면 진단">
      <div className="viewport-diagnostics-heading">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>화면 진단 · {sampleCount}</button>
        <button type="button" onClick={close} aria-label="화면 진단 끄기">×</button>
      </div>
      {expanded && <div className="viewport-diagnostics-content">
        <p>문제를 재현한 뒤 계정·채팅 창을 닫고 복사해 주세요.</p>
        <p>화면 크기·스크롤 위치만 이 탭에 기록합니다. 책 정보·입력 내용은 기록하거나 전송하지 않습니다.</p>
        <button type="button" onClick={() => void copy()}>진단 내용 복사</button>
        {notice && <p role="status">{notice}</p>}
        {fallback && <textarea ref={textRef} readOnly value={fallback} aria-label="복사할 화면 진단 내용" onFocus={event => event.currentTarget.select()} />}
      </div>}
    </aside>
  </>;
}
