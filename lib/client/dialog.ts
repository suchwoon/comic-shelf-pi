import type { MouseEvent } from "react";
import { containDialogTouch } from "./dialog-touch";

type ScrollLock = { owners: Set<symbol>; restore: () => void };
const scrollLocks = new WeakMap<Document, ScrollLock>();

function preserveStyles(element: HTMLElement, properties: string[]) {
  const previous = properties.map(property => ({
    property,
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  }));
  return () => {
    for (const { property, value, priority } of previous) {
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
  };
}

function lockDocumentScroll(document: Document) {
  const owner = Symbol("modal scroll lock");
  let lock = scrollLocks.get(document);
  if (!lock) {
    const window = document.defaultView!;
    const root = document.documentElement;
    const body = document.body;
    const { scrollX, scrollY } = window;
    const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
    const paddingRight = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
    const overflowProperties = ["overflow-x", "overflow-y", "overscroll-behavior-x", "overscroll-behavior-y"];
    const restoreRoot = preserveStyles(root, overflowProperties);
    const restoreBody = preserveStyles(body, [
      ...overflowProperties, "position", "top", "right", "bottom", "left", "width", "padding-right",
    ]);

    // Fix the background in place without moving the visible shelf. Root
    // overflow alone does not reliably stop document panning on iPad.
    for (const element of [root, body]) {
      element.style.overflowX = "hidden";
      element.style.overflowY = "hidden";
      element.style.overscrollBehaviorX = "none";
      element.style.overscrollBehaviorY = "none";
    }
    body.style.position = "fixed";
    body.style.top = `${-scrollY}px`;
    body.style.left = `${-scrollX}px`;
    body.style.right = "auto";
    body.style.bottom = "auto";
    body.style.width = "100%";
    if (scrollbarWidth) body.style.paddingRight = `${paddingRight + scrollbarWidth}px`;

    lock = {
      owners: new Set(),
      restore: () => {
        restoreRoot();
        restoreBody();
        // A route change may have installed the reader's own fixed-body CSS.
        // Do not restore the shelf's old document offset into that route.
        if (window.getComputedStyle(body).position !== "fixed") {
          window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
        }
      },
    };
    scrollLocks.set(document, lock);
  }
  lock.owners.add(owner);
  return () => {
    if (!lock.owners.delete(owner) || lock.owners.size) return;
    scrollLocks.delete(document);
    lock.restore();
  };
}

export function showModalDialog(dialog: HTMLDialogElement) {
  // Acquire before showModal() moves focus, so opening a modal also preserves
  // the background position when its first field receives focus.
  const unlock = lockDocumentScroll(dialog.ownerDocument);
  try { dialog.showModal(); }
  catch (error) { unlock(); throw error; }
  const stopTouchGuard = containDialogTouch(dialog);
  const onClose = () => {
    // close events are queued. Ignore one from an earlier open/close cycle if
    // a responsive dialog has already reopened by the time it is delivered.
    if (!dialog.open) { stopTouchGuard(); unlock(); }
  };
  dialog.addEventListener("close", onClose);
  return () => {
    dialog.removeEventListener("close", onClose);
    stopTouchGuard();
    dialog.close();
    unlock();
  };
}

export function isDialogBackdropClick(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  // Native dialogs also receive clicks on their own padding and border.
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX >= bounds.right
    || event.clientY < bounds.top || event.clientY >= bounds.bottom;
}
