import type { Page } from 'playwright';
import type { BrowserRuntime } from '../browser/chromium.js';
import { z } from 'zod';

const input = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: z.number().min(0).max(999), y: z.number().min(0).max(759) }).strict(),
  z.object({ type: z.literal('drag'), x: z.number().min(0).max(999), y: z.number().min(0).max(759),
    toX: z.number().min(0).max(999), toY: z.number().min(0).max(759) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Backspace', 'Escape']) }).strict()
]);

/** Human-operated official verification page, with snapshots only on request. */
export class LoginAssist {
  private page?: Page;
  private timer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly browser: () => BrowserRuntime | undefined) {}
  get active(): boolean { return Boolean(this.page && !this.page.isClosed()); }
  start(): Promise<void> {
    return this.serial(async () => {
      await this.close();
      const browser = this.browser();
      if (!browser || browser.page.isClosed()) throw new Error('后台抖音会话尚未就绪');
      this.page = await browser.context.newPage();
      try {
        await this.page.setViewportSize({ width: 1000, height: 760 });
        await this.page.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded', timeout: 15000 });
        this.touch();
      } catch (error) { await this.close(); throw error; }
    });
  }
  snapshot(): Promise<Buffer> {
    return this.serial(async () => { const page = this.current(); return page.screenshot({ type: 'jpeg', quality: 70, timeout: 10000 }); });
  }
  act(value: unknown): Promise<void> {
    const operation = input.parse(value);
    return this.serial(async () => {
      const page = this.current();
      if (operation.type === 'click') await page.mouse.click(operation.x, operation.y);
      if (operation.type === 'drag') {
        await page.mouse.move(operation.x, operation.y); await page.mouse.down();
        try { await page.mouse.move(operation.toX, operation.toY, { steps: 20 }); } finally { await page.mouse.up(); }
      }
      if (operation.type === 'text') await page.keyboard.insertText(operation.text);
      if (operation.type === 'key') await page.keyboard.press(operation.key);
    });
  }
  async close(): Promise<void> {
    clearTimeout(this.timer); const page = this.page; this.page = undefined;
    if (page && !page.isClosed()) await page.close().catch(() => undefined);
  }
  private current(): Page {
    const page = this.page;
    if (!page || page.isClosed() || page.context() !== this.browser()?.context) throw new Error('辅助验证已结束，请重新打开');
    const url = new URL(page.url());
    if (url.protocol !== 'https:' || !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) throw new Error('辅助验证仅允许操作抖音官方页面');
    this.touch(); return page;
  }
  private touch() { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.close(); }, 10 * 60 * 1000); this.timer.unref(); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
}
