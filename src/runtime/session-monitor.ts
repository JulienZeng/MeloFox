import type { BrowserContext, Page } from 'playwright';

export interface SessionProbe {
  loggedIn: boolean;
  accountId?: string;
}

export class SessionMonitor {
  healthy = true;
  private stopped = false;
  private checking = false;
  private disconnectedAt: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly onCrash = () => this.recover('browser page crashed');
  private readonly onClose = () => this.recover('browser page closed');
  private readonly onContextClose = () => this.recover('browser context closed');

  constructor(private readonly options: {
    page: Page;
    context: BrowserContext;
    accountId?: string;
    intervalMs: number;
    disconnectGraceMs: number;
    probe(): Promise<SessionProbe>;
    isImConnected(): boolean;
    recover(reason: string): void;
    onHealthChange(healthy: boolean, error?: unknown): void;
    now?: () => number;
  }) {
    options.page.on('crash', this.onCrash);
    options.page.on('close', this.onClose);
    options.context.on('close', this.onContextClose);
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => { void this.check(); }, this.options.intervalMs);
  }

  bindAccount(accountId: string | undefined): void {
    this.options.accountId = accountId;
  }

  async check(): Promise<void> {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      const result = await this.options.probe();
      if (this.stopped) return;
      this.setHealthy(result.loggedIn);
      if (!result.loggedIn) {
        this.disconnectedAt = undefined;
        return;
      }
      if (result.accountId !== this.options.accountId) {
        this.recover('authenticated account changed');
        return;
      }
      const now = (this.options.now ?? Date.now)();
      if (this.options.isImConnected()) this.disconnectedAt = undefined;
      else {
        this.disconnectedAt ??= now;
        if (now - this.disconnectedAt >= this.options.disconnectGraceMs) this.recover('Douyin IM connection stalled');
      }
    } catch (error) {
      if (!this.stopped) this.setHealthy(false, error);
    } finally {
      this.checking = false;
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.options.page.off('crash', this.onCrash);
    this.options.page.off('close', this.onClose);
    this.options.context.off('close', this.onContextClose);
  }

  private recover(reason: string): void {
    if (this.stopped) return;
    this.setHealthy(false);
    this.stop();
    this.options.recover(reason);
  }

  private setHealthy(value: boolean, error?: unknown): void {
    if (this.healthy === value) return;
    this.healthy = value;
    this.options.onHealthChange(value, error);
  }
}
