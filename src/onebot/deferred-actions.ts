/** Accepted async calls are memory-only and never retried after failure/restart. */
export class DeferredActions {
  private readonly jobs: Array<{ run: () => Promise<void>; limited: boolean }> = [];
  private timer?: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private lastLimited = 0;
  constructor(private readonly intervalMs = 500, private readonly capacity = 128) {}
  enqueue(run: () => Promise<void>, limited: boolean): void {
    if (this.closed) throw new Error('OneBot session is stopping');
    if (this.jobs.length >= this.capacity) throw new Error('OneBot asynchronous action queue is full');
    this.jobs.push({ run, limited }); this.schedule();
  }
  stop(): void { this.closed = true; clearTimeout(this.timer); this.jobs.length = 0; }
  private schedule(): void {
    if (this.running || this.timer || this.closed || !this.jobs.length) return;
    const wait = this.jobs[0].limited ? Math.max(0, this.lastLimited + this.intervalMs - Date.now()) : 0;
    this.timer = setTimeout(() => {
      this.timer = undefined; const job = this.jobs.shift(); if (!job || this.closed) return;
      this.running = true; if (job.limited) this.lastLimited = Date.now();
      // The router reports failures; the queue never replays an accepted mutation.
      void job.run().catch(() => undefined).finally(() => { this.running = false; this.schedule(); });
    }, wait);
    this.timer.unref();
  }
}
