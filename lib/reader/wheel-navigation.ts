type PageStep = -1 | 0 | 1;

type WheelInput = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  timeStamp: number;
};

const PAGE_THRESHOLD = 40;
const GESTURE_IDLE_MS = 180;
const NOTCH_COOLDOWN_MS = 250;
const LINE_HEIGHT = 16;

/** Converts one vertical wheel gesture into one logical page turn, independently of RTL. */
export class WheelPageGesture {
  private lastTime: number | null = null;
  private lastMagnitude = 0;
  private pixelNotches = false;
  private lockedDirection: PageStep = 0;
  private pendingDirection: PageStep = 0;
  private pendingDistance = 0;
  private lastNavigation = -Infinity;

  consume(event: WheelInput, viewportHeight: number): PageStep {
    const { deltaX, deltaY, deltaMode, timeStamp } = event;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || !Number.isFinite(timeStamp)
      || deltaY === 0 || Math.abs(deltaX) >= Math.abs(deltaY)) return 0;
    if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return 0;
    if (deltaMode === 2 && (!Number.isFinite(viewportHeight) || viewportHeight <= 0)) return 0;

    const magnitude = Math.abs(deltaY);
    const distance = magnitude * (deltaMode === 1 ? LINE_HEIGHT : deltaMode === 2 ? viewportHeight : 1);
    const direction: PageStep = deltaY > 0 ? 1 : -1;
    const gap = this.lastTime === null ? Infinity : timeStamp - this.lastTime;
    if (gap >= GESTURE_IDLE_MS || gap < 0) this.reset();

    // Some browsers expose mouse notches as fixed, large pixel deltas. Once a
    // burst becomes dense or changes size, treat all of its remaining events as
    // touchpad momentum, even if the tail outlasts the repeat cooldown.
    const largePixelNotch = deltaMode === 0 && magnitude >= 80 && Number.isInteger(magnitude);
    this.pixelNotches = this.lastTime === null
      ? largePixelNotch
      : this.pixelNotches && largePixelNotch && magnitude === this.lastMagnitude && gap >= 40;
    this.lastTime = timeStamp;
    this.lastMagnitude = magnitude;

    const repeating = this.lockedDirection === direction;
    if (repeating && deltaMode === 0 && !this.pixelNotches) {
      this.pendingDirection = 0;
      this.pendingDistance = 0;
      return 0;
    }
    if (this.pendingDirection !== direction) this.pendingDistance = 0;
    this.pendingDirection = direction;
    this.pendingDistance += distance;
    if (this.pendingDistance < PAGE_THRESHOLD) return 0;
    if (repeating && timeStamp - this.lastNavigation < NOTCH_COOLDOWN_MS) return 0;

    // A substantial reversal is intentional; do not make it wait for the
    // previous direction's cooldown. Tiny opposite-direction jitter cannot
    // unlock the gesture or retrigger forward momentum.
    this.lockedDirection = direction;
    this.pendingDirection = 0;
    this.pendingDistance = 0;
    this.lastNavigation = timeStamp;
    return direction;
  }

  reset(): void {
    this.lastTime = null;
    this.lastMagnitude = 0;
    this.pixelNotches = false;
    this.lockedDirection = 0;
    this.pendingDirection = 0;
    this.pendingDistance = 0;
    this.lastNavigation = -Infinity;
  }
}
