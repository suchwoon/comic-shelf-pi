import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WheelPageGesture } from "../lib/reader/wheel-navigation";

function wheel(deltaY: number, timeStamp: number, deltaMode = 0, deltaX = 0) {
  return { deltaX, deltaY, deltaMode, timeStamp };
}

describe("reader wheel gestures", () => {
  it("turns only once during a touchpad gesture whose inertia outlasts the cooldown", () => {
    const gesture = new WheelPageGesture();
    const result = [56, 92, 80, 64, 48, 32, 20, 12, 8, 4, 2, 1]
      .map((delta, index) => gesture.consume(wheel(delta, index * 45), 800));
    assert.deepEqual(result, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(gesture.consume(wheel(60, 700), 800), 1, "a new gesture after idle can turn again");
  });

  it("does not mistake a dense, initially constant touchpad burst for mouse notches", () => {
    const gesture = new WheelPageGesture();
    const results = Array.from({ length: 25 }, (_, index) => gesture.consume(wheel(100, index * 16), 800));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(gesture.consume(wheel(100, 460), 800), 0, "a sparse inertia tail remains locked");
  });

  it("accumulates small movements and drops a partial gesture after idle", () => {
    const gesture = new WheelPageGesture();
    assert.deepEqual([0, 20, 40, 60].map(time => gesture.consume(wheel(10, time), 800)), [0, 0, 0, 1]);
    assert.equal(gesture.consume(wheel(20, 300), 800), 0);
    assert.equal(gesture.consume(wheel(20, 500), 800), 0);
    assert.equal(gesture.consume(wheel(20, 520), 800), 1);
  });

  it("allows an intentional direction reversal without letting tiny jitter unlock momentum", () => {
    const gesture = new WheelPageGesture();
    assert.equal(gesture.consume(wheel(60, 0), 800), 1);
    assert.equal(gesture.consume(wheel(-2, 20), 800), 0);
    assert.equal(gesture.consume(wheel(60, 40), 800), 0);
    assert.equal(gesture.consume(wheel(-20, 60), 800), 0);
    assert.equal(gesture.consume(wheel(-20, 80), 800), -1);
    assert.equal(gesture.consume(wheel(-40, 100), 800), 0);
    assert.equal(gesture.consume(wheel(40, 120), 800), 1);
  });

  it("normalizes line and page deltas in both directions", () => {
    const lines = new WheelPageGesture();
    assert.equal(lines.consume(wheel(1, 0, 1), 800), 0);
    assert.equal(lines.consume(wheel(1, 20, 1), 800), 0);
    assert.equal(lines.consume(wheel(1, 40, 1), 800), 1);
    assert.equal(lines.consume(wheel(-3, 60, 1), 800), -1);
    const pages = new WheelPageGesture();
    assert.equal(pages.consume(wheel(0.04, 0, 2), 800), 0);
    assert.equal(pages.consume(wheel(0.01, 20, 2), 800), 1);
    assert.equal(pages.consume(wheel(-1, 40, 2), 800), -1);
  });

  it("allows controlled repetition of discrete line and large pixel mouse notches", () => {
    for (const [delta, mode] of [[3, 1], [100, 0], [1, 2]]) {
      const gesture = new WheelPageGesture();
      assert.deepEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600]
        .map(time => gesture.consume(wheel(delta, time, mode), 800)), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }
  });

  it("ignores horizontal, zero, unsupported, and nonfinite inputs without poisoning the gesture", () => {
    const gesture = new WheelPageGesture();
    for (const input of [wheel(0, 0), wheel(50, 0, 0, 60), wheel(50, 0, 0, 50),
      wheel(NaN, 0), wheel(Infinity, 0), wheel(50, NaN), wheel(50, 0, 9)]) {
      assert.equal(gesture.consume(input, 800), 0);
    }
    assert.equal(gesture.consume(wheel(1, 0, 2), 0), 0);
    assert.equal(gesture.consume(wheel(1, 0, 2), NaN), 0);
    assert.equal(gesture.consume(wheel(40, 0), 800), 1);
  });

  it("reset clears both a partial movement and a completed gesture lock", () => {
    const gesture = new WheelPageGesture();
    assert.equal(gesture.consume(wheel(30, 0), 800), 0);
    gesture.reset();
    assert.equal(gesture.consume(wheel(20, 10), 800), 0);
    assert.equal(gesture.consume(wheel(20, 20), 800), 1);
    gesture.reset();
    assert.equal(gesture.consume(wheel(40, 30), 800), 1);
  });
});
