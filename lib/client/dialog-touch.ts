type ModalOwner = { dialog: HTMLDialogElement };
const modalOwners = new WeakMap<Document, ModalOwner[]>();

function canScroll(element: HTMLElement, horizontal: boolean, movement: number) {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  const overflow = horizontal ? style.overflowX : style.overflowY;
  if (!/^(auto|scroll|overlay)$/.test(overflow)) return false;
  const extent = horizontal
    ? element.scrollWidth - element.clientWidth
    : element.scrollHeight - element.clientHeight;
  if (extent <= 1) return false;
  const rtl = horizontal && style.direction === "rtl";
  const position = horizontal ? (rtl ? -element.scrollLeft : element.scrollLeft) : element.scrollTop;
  const towardStart = rtl ? movement < 0 : movement > 0;
  return towardStart ? position > 1 : position < extent - 1;
}

/** Keep native modal gestures inside the modal without replacing its scrolling. */
export function containDialogTouch(dialog: HTMLDialogElement) {
  const document = dialog.ownerDocument;
  const window = document.defaultView!;
  const owner = { dialog };
  const owners = modalOwners.get(document) ?? [];
  owners.push(owner);
  modalOwners.set(document, owners);
  let startPoint: { x: number; y: number } | null = null;
  let lastPoint: { x: number; y: number } | null = null;
  let target: Element | null = null;
  let backdrop = false;
  let multiTouch = false;
  let startedAt = 0;
  let holdingStill = true;
  let nativeSelectionGesture = false;

  const start = (event: TouchEvent) => {
    if (owners.at(-1) !== owner) return;
    if (event.touches.length > 1) { multiTouch = true; return; }
    if (event.touches.length !== 1 || multiTouch) return;
    const touch = event.touches[0];
    lastPoint = { x: touch.clientX, y: touch.clientY };
    startPoint = lastPoint;
    startedAt = event.timeStamp;
    holdingStill = true;
    nativeSelectionGesture = false;
    target = event.target instanceof Element ? event.target : null;
    const bounds = dialog.getBoundingClientRect();
    // Native ::backdrop events target the dialog, even when its content can
    // scroll. Coordinates distinguish them from drags on dialog padding.
    backdrop = touch.clientX < bounds.left || touch.clientX >= bounds.right
      || touch.clientY < bounds.top || touch.clientY >= bounds.bottom;
  };

  const end = (event: TouchEvent) => {
    if (event.touches.length) return;
    // Lifting just one finger must not turn the rest of a pinch into a pan
    // that we cancel. Reset only when the complete gesture has ended.
    multiTouch = false;
    startPoint = null;
    lastPoint = null;
    target = null;
    backdrop = false;
  };

  const move = (event: TouchEvent) => {
    if (owners.at(-1) !== owner || !dialog.matches(":modal")) return;
    if (event.touches.length > 1) { multiTouch = true; return; }
    if (multiTouch || event.touches.length !== 1 || !lastPoint) return;
    const touch = event.touches[0];
    const dx = touch.clientX - lastPoint.x;
    const dy = touch.clientY - lastPoint.y;
    lastPoint = { x: touch.clientX, y: touch.clientY };
    // A stationary hold may enter the native text-selection mode. A normal
    // drag must not acquire that exemption just because it lasts half a second.
    if (holdingStill && event.timeStamp - startedAt >= 500) nativeSelectionGesture = true;
    if (startPoint && Math.hypot(touch.clientX - startPoint.x, touch.clientY - startPoint.y) > 10) holdingStill = false;
    if (!event.cancelable || (window.visualViewport?.scale ?? 1) > 1.01 || (!dx && !dy)) return;
    if (backdrop || !target || !dialog.contains(target)) {
      event.preventDefault();
      return;
    }

    const selection = window.getSelection();
    if (target !== dialog && selection && !selection.isCollapsed
      && dialog.contains(selection.anchorNode) && dialog.contains(selection.focusNode)) {
      // Keep selection handles working on ordinary text as well as fields,
      // without letting a selection elsewhere exempt an unrelated gesture.
      for (let index = 0; index < selection.rangeCount; index++) {
        if (selection.getRangeAt(index).intersectsNode(target)) return;
      }
    }

    const horizontal = Math.abs(dx) > Math.abs(dy);
    // Preserve picker/slider controls and native cursor/selection gestures.
    // Short vertical drags over text fields still need to scroll an ancestor
    // or stop at its boundary, rather than pan the native browser viewport.
    if (target.closest('select, input[type="range"]')) return;
    const editable = target.closest("input, textarea, [contenteditable]:not([contenteditable=false])");
    if (editable) {
      if (horizontal || nativeSelectionGesture) return;
      if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        if (editable.selectionStart !== null && editable.selectionStart !== editable.selectionEnd) return;
      }
    }

    const movement = horizontal ? dx : dy;
    for (let element: Element | null = target; element; element = element.parentElement) {
      if (element instanceof HTMLElement && canScroll(element, horizontal, movement)) return;
      if (element === dialog) break;
    }
    event.preventDefault();
  };

  dialog.addEventListener("touchstart", start, { passive: true });
  dialog.addEventListener("touchmove", move, { passive: false });
  dialog.addEventListener("touchend", end, { passive: true });
  dialog.addEventListener("touchcancel", end, { passive: true });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    dialog.removeEventListener("touchstart", start);
    dialog.removeEventListener("touchmove", move);
    dialog.removeEventListener("touchend", end);
    dialog.removeEventListener("touchcancel", end);
    const index = owners.indexOf(owner);
    if (index !== -1) owners.splice(index, 1);
    if (!owners.length) modalOwners.delete(document);
  };
}
