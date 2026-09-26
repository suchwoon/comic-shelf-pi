import assert from "node:assert/strict";
import { it } from "node:test";
import { ProgressSaveQueue, type ProgressWrite, type SaveStatus } from "../lib/reader/progress";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const snapshot = (currentPage: number) => ({ currentPage, direction: "ltr" as const, fit: "page" as const });
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

it("new changes stop reporting Saved before the debounce starts a request", async () => {
  const statuses: SaveStatus[] = [];
  let requests = 0;
  const queue = new ProgressSaveQueue(async () => { requests++; }, status => statuses.push(status));
  queue.change(snapshot(1));
  await queue.flush();
  assert.equal(statuses.at(-1), "saved");
  queue.change(snapshot(2));
  assert.equal(statuses.at(-1), "saving");
  assert.equal(requests, 1);
  await queue.flush();
  assert.equal(statuses.at(-1), "saved");
});

it("flush waits for an existing request and the latest position queued during it", async () => {
  const first = deferred();
  const second = deferred();
  const sent: ProgressWrite[] = [];
  const queue = new ProgressSaveQueue(async value => {
    sent.push(value);
    await (sent.length === 1 ? first : second).promise;
  }, () => {});
  queue.change(snapshot(2));
  const autoSave = queue.flush();
  queue.change(snapshot(3));
  let finished = false;
  const leave = queue.flush().then(result => { finished = true; return result; });
  await nextTurn();
  assert.equal(finished, false);
  assert.deepEqual(sent.map(value => value.currentPage), [2]);
  first.resolve();
  await nextTurn();
  assert.equal(finished, false);
  assert.deepEqual(sent.map(value => value.currentPage), [2, 3]);
  second.resolve();
  assert.equal(await leave, true);
  assert.equal(await autoSave, true);
  assert.equal(sent[0].writerId, sent[1].writerId);
  assert.ok(sent[1].sequence > sent[0].sequence);
});

it("a failed save blocks departure and retry retains the newest complete snapshot", async () => {
  const first = deferred();
  const sent: ProgressWrite[] = [];
  const statuses: SaveStatus[] = [];
  const queue = new ProgressSaveQueue(async value => {
    sent.push(value);
    if (sent.length === 1) await first.promise;
  }, status => statuses.push(status));
  queue.change(snapshot(2));
  const save = queue.flush();
  queue.change({ ...snapshot(3), direction: "rtl" });
  first.reject(new Error("offline"));
  assert.equal(await save, false);
  assert.equal(statuses.at(-1), "error");
  assert.equal(await queue.flush(), true);
  assert.equal(sent.at(-1)?.currentPage, 3);
  assert.equal(sent.at(-1)?.direction, "rtl");
  assert.equal(statuses.at(-1), "saved");
});

it("exit sends the newest snapshot immediately while an older request is delayed", async () => {
  const first = deferred();
  const exit = deferred();
  const sent: ProgressWrite[] = [];
  const statuses: SaveStatus[] = [];
  const queue = new ProgressSaveQueue(async value => {
    sent.push(value);
    await (sent.length === 1 ? first : exit).promise;
  }, status => statuses.push(status));
  queue.change(snapshot(2));
  const save = queue.flush();
  queue.change(snapshot(3));
  queue.sendLatest();
  assert.deepEqual(sent.map(value => value.currentPage), [2, 3]);
  exit.resolve();
  await nextTurn();
  // The late failure must not replace the successfully saved newer position.
  first.reject(new Error("connection_closed"));
  assert.equal(await save, true);
  assert.equal(statuses.at(-1), "saved");
  assert.equal(await queue.flush(), true);
  queue.sendLatest();
  assert.equal(sent.length, 2);
});

it("exit failure remains retryable and another reader uses a distinct writer", async () => {
  const sent: ProgressWrite[] = [];
  let fail = true;
  const queue = new ProgressSaveQueue(async value => {
    sent.push(value);
    if (fail) throw new Error("offline");
  }, () => {});
  queue.change(snapshot(2));
  queue.sendLatest();
  await nextTurn();
  fail = false;
  assert.equal(await queue.flush(), true);
  assert.deepEqual(sent[0], sent[1]);
  const another = new ProgressSaveQueue(async value => { sent.push(value); }, () => {});
  another.change(snapshot(1));
  await another.flush();
  assert.notEqual(sent[0].writerId, sent[2].writerId);
});
