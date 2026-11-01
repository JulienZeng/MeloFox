/** Rebuild the managed gateway after the API response has been dispatched. */
export class GatewayRestart {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(private readonly recover: (reason: string) => void) {}
  request(delay: number): void {
    if (this.stopped) throw new Error('Gateway is stopping');
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 2147483647) throw new Error('delay must be an integer from 0 to 2147483647 milliseconds');
    if (this.timer) return; // Repeated calls cannot postpone or multiply a pending restart.
    this.timer = setTimeout(() => { this.timer = undefined; if (!this.stopped) this.recover('OneBot set_restart'); }, delay);
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; }
}
