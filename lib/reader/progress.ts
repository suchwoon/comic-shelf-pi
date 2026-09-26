import type { Book } from "../types";

export type ProgressSnapshot = Pick<Book, "currentPage" | "direction" | "fit">;
export type SaveStatus = "idle" | "saving" | "saved" | "error";
export type ProgressWrite = ProgressSnapshot & { writerId: string; sequence: number };

/** One writer belongs to one mounted reader; its sequence never goes backwards. */
export class ProgressSaveQueue {
  private writerId: string | undefined;
  private sequence = 0;
  private acknowledged = 0;
  private latest: ProgressWrite | null = null;
  private pending: ProgressWrite | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(
    private send: (value: ProgressWrite) => Promise<void>,
    private onStatus: (status: SaveStatus) => void,
  ) {}

  change(value: ProgressSnapshot) {
    // getRandomValues is also available on LAN HTTP; randomUUID is not.
    this.writerId ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    this.latest = { ...value, writerId: this.writerId, sequence: ++this.sequence };
    this.pending = this.latest;
    this.onStatus("saving");
  }

  async flush(): Promise<boolean> {
    while (this.inFlight || this.pending) {
      this.inFlight ??= this.drain().finally(() => { this.inFlight = null; });
      if (!await this.inFlight) return false;
    }
    return true;
  }

  /** Exit events cannot wait for an earlier request, so send the newest value now. */
  sendLatest() {
    const value = this.latest;
    if (!value || value.sequence <= this.acknowledged) return;
    void this.send(value).then(() => this.acknowledge(value), () => {
      if (value.sequence > this.acknowledged) {
        this.pending = this.latest;
        this.onStatus("error");
      }
    });
  }

  private acknowledge(value: ProgressWrite) {
    this.acknowledged = Math.max(this.acknowledged, value.sequence);
    if (this.pending && this.pending.sequence <= this.acknowledged) this.pending = null;
    if (this.latest && this.latest.sequence <= this.acknowledged) this.onStatus("saved");
  }

  private async drain(): Promise<boolean> {
    this.onStatus("saving");
    while (this.pending) {
      const value = this.pending;
      this.pending = null;
      try {
        await this.send(value);
        this.acknowledge(value);
      } catch {
        // An exit request may already have saved this or a newer snapshot.
        if (value.sequence <= this.acknowledged) continue;
        this.pending ??= value;
        this.onStatus("error");
        return false;
      }
    }
    return true;
  }
}
