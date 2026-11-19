"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { installmentLabel } from "@/lib/client/series";
import type { Book } from "@/lib/types";

export default function InstallmentPicker({ books, value, disabled = false, onChange }: {
  books: Book[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  const id = useId();
  const menuId = `${id}-installments`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const options = useMemo(() => {
    const counts = new Map<string, number>();
    for (const book of books) {
      const label = installmentLabel(book);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return books.map(book => {
      const shortLabel = installmentLabel(book);
      const needsTitle = book.installmentNumber === null || (counts.get(shortLabel) ?? 0) > 1;
      const label = `${shortLabel}${needsTitle ? ` · ${book.title}` : ""}`;
      return {
        id: book.id,
        label,
        search: [label, book.title, book.installmentNumber?.toString() ?? ""].map(text => text.toLocaleLowerCase()),
      };
    });
  }, [books]);
  const selectedIndex = Math.max(0, options.findIndex(option => option.id === value));
  const selected = options[selectedIndex];
  const unavailable = disabled || options.length === 0;

  const close = () => {
    setOpen(false);
    searchRef.current = { text: "", at: 0 };
  };

  const openAt = (index: number) => {
    if (unavailable) return;
    searchRef.current = { text: "", at: 0 };
    setActiveIndex(index);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (unavailable || !option) return;
    close();
    triggerRef.current?.focus({ preventScroll: true });
    if (option.id !== value) onChange(option.id);
  };

  useEffect(() => {
    setOpen(false);
    setActiveIndex(selectedIndex);
    searchRef.current = { text: "", at: 0 };
  }, [value, unavailable, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
        searchRef.current = { text: "", at: 0 };
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!root || !trigger || !menu) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const triggerBounds = trigger.getBoundingClientRect();
      const rootBounds = root.getBoundingClientRect();
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
      const menuWidth = menu.getBoundingClientRect().width;
      const left = Math.max(viewportLeft + 12,
        Math.min(triggerBounds.right - menuWidth, viewportLeft + viewportWidth - menuWidth - 12));
      root.style.setProperty("--reader-installment-menu-left", `${left - rootBounds.left}px`);
      root.style.setProperty("--reader-installment-max-height", `${Math.max(0, viewportBottom - triggerBounds.bottom - 20)}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(trigger);
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const option = menu?.children[activeIndex] as HTMLElement | undefined;
    if (!menu || !option) return;
    // Only move the menu's scroll position; scrolling ancestors would move the reader.
    const menuBounds = menu.getBoundingClientRect();
    const optionBounds = option.getBoundingClientRect();
    const top = menuBounds.top + menu.clientTop;
    const bottom = top + menu.clientHeight;
    if (optionBounds.top < top) menu.scrollTop -= top - optionBounds.top;
    else if (optionBounds.bottom > bottom) menu.scrollTop += optionBounds.bottom - bottom;
  }, [open, activeIndex]);

  const keydown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (unavailable || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter" || event.key === " ") {
        if (open) choose(activeIndex);
        else openAt(selectedIndex);
      } else if (event.key === "Home") openAt(0);
      else if (event.key === "End") openAt(options.length - 1);
      else if (!open) openAt(selectedIndex);
      else {
        searchRef.current = { text: "", at: 0 };
        setActiveIndex(index => Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
      }
      return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    const previous = now - searchRef.current.at < 700 ? searchRef.current.text : "";
    const text = previous + event.key.toLocaleLowerCase();
    searchRef.current = { text, at: now };
    const repeated = !/^\d+$/.test(text) && [...text].every(character => character === text[0]);
    const query = repeated ? text[0] : text;
    const start = open ? activeIndex : selectedIndex;
    for (let step = repeated ? 1 : 0; step < options.length + (repeated ? 1 : 0); step++) {
      const index = (start + step) % options.length;
      if (options[index].search.some(term => term.startsWith(query))) {
        setActiveIndex(index);
        setOpen(true);
        break;
      }
    }
  };

  return <div className="reader-installment-picker" ref={rootRef}>
    <button ref={triggerRef} type="button" role="combobox" className="reader-installment-trigger"
      aria-label="Choose installment" aria-description={selected?.label} aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-activedescendant={open && options[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
      disabled={unavailable} onKeyDown={keydown} onClick={() => open ? close() : openAt(selectedIndex)}>
      <span className="reader-installment-label">{selected?.label ?? "Choose installment"}</span>
      <ChevronDown className="reader-installment-chevron" size={14} aria-hidden="true" />
    </button>
    {open && <div ref={menuRef} id={menuId} role="listbox" aria-label="Installments" className="reader-installment-menu"
      onMouseDown={event => event.preventDefault()}>
      {options.map((option, index) => <div key={option.id} id={`${id}-option-${index}`} role="option"
        aria-selected={option.id === value} data-active={index === activeIndex} className="reader-installment-option"
        onPointerMove={event => { if (event.pointerType === "mouse") setActiveIndex(index); }}
        onClick={() => choose(index)}>
        <span className="reader-installment-label">{option.label}</span>
        <span className="reader-installment-check" aria-hidden="true">{option.id === value && <Check size={14} />}</span>
      </div>)}
    </div>}
  </div>;
}
