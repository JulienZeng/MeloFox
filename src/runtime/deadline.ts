export class ActionDeadline {
  readonly signal: AbortSignal;
  private readonly expiresAt: number;

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs;
    this.signal = AbortSignal.timeout(timeoutMs);
  }

  remainingMs(): number {
    this.signal.throwIfAborted();
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) throw new Error('Action timed out; delivery may have succeeded. Do not retry automatically');
    return remaining;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.remainingMs();
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Action timed out; delivery may have succeeded. Do not retry automatically'));
      this.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([operation(), aborted]);
    } finally {
      this.signal.removeEventListener('abort', abort);
    }
  }
}
