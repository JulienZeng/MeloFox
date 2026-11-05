import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import { scopedLogger, type AppLogger } from '../logger/index.js';
import type { OneBotActionRouter } from './actions.js';
import type { OneBotEvent } from './types.js';
import { parseOneBotJson, stringifyOneBotJson } from './json.js';
import { EventOutbox } from './outbox.js';
import { lifecycleEvent } from './events.js';

export class OneBotReverseHttp {
  private readonly outbox: EventOutbox;
  private readonly abort = new AbortController();
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private stopped = true;
  private online = false;
  private failures = 0;
  private lastWarningAt = 0;
  private lifecycle?: OneBotEvent;
  private heartbeat?: OneBotEvent;
  private flushRequested = false;
  constructor(private readonly config: AppConfig, private readonly logger: AppLogger, private readonly router: OneBotActionRouter) {
    this.logger = scopedLogger(logger, 'OneBot HTTP回传');
    const key = createHash('sha256').update(`http:${config.onebot.reverseHttp.url}:${config.app.selfId}`).digest('hex');
    this.outbox = new EventOutbox(join(config.runtime.messageCacheDir, 'events', `${key}.json`), config.app.selfId);
  }
  async start(): Promise<void> {
    await this.outbox.initialize(); this.stopped = false;
    this.lifecycle = lifecycleEvent(this.config, 'enable'); this.flush();
    this.timer = setInterval(() => this.flush(), this.config.runtime.reconnectIntervalMs);
    this.timer.unref();
  }
  async emit(event: OneBotEvent): Promise<void> {
    if (this.stopped) return;
    if (String(event.self_id) !== this.config.app.selfId) throw new Error('HTTP event account mismatch');
    if (event.post_type === 'meta_event') {
      // Retain only current state: old heartbeats must not flood a recovering receiver.
      if (event.meta_event_type === 'heartbeat') this.heartbeat = event;
      else if (event.meta_event_type === 'lifecycle' && ['enable', 'disable'].includes(String(event.sub_type))) this.lifecycle = event;
      else return;
    } else await this.outbox.enqueue(event);
    this.flushRequested = true; this.flush();
  }
  status() { return { state: this.stopped ? 'waiting' : this.online ? 'connected' : 'connecting', pendingEvents: this.outbox.size }; }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.abort.abort();
    await this.flushing; await this.outbox.settled();
    this.lifecycle = this.heartbeat = undefined;
    // Shutdown reporting is best effort and bounded; chat events remain durable.
    await this.post(lifecycleEvent(this.config, 'disable'), AbortSignal.timeout(Math.min(1000, this.config.onebot.reverseHttp.timeoutMs)));
  }

  private flush(): void {
    if (this.stopped || this.flushing) return;
    const operations: Array<{ context: OneBotEvent; operation: unknown }> = [];
    this.flushRequested = false;
    this.flushing = (async () => {
      for (const kind of ['lifecycle', 'heartbeat'] as const) {
        const event = this[kind];
        if (!event || this.stopped) continue;
        const result = await this.post(event);
        if (result.ok && this[kind] === event) this[kind] = undefined;
      }
      await this.outbox.drain(async event => {
        if (this.stopped) return false;
        const result = await this.post(event);
        if (result.ok && result.operation !== undefined) operations.push({ context: event, operation: result.operation });
        return result.ok;
      });
    })().then(async () => {
      // Never replay an acknowledged event merely because a reply failed or timed out.
      for (const params of operations) {
        if (this.stopped) break;
        const result = await this.router.handle({ action: '.handle_quick_operation', params });
        if (result.status !== 'ok') this.logger.warn({ retcode: result.retcode }, '反向 HTTP 快速操作失败，不自动重试');
      }
    }).catch(() => this.logger.warn('反向 HTTP 事件队列保存失败，将重试投递'))
      .finally(() => { this.flushing = undefined; if (this.flushRequested) this.flush(); });
  }
  private async post(event: OneBotEvent, signal = AbortSignal.any([
    this.abort.signal, AbortSignal.timeout(this.config.onebot.reverseHttp.timeoutMs)
  ])): Promise<{ ok: boolean; operation?: unknown }> {
    try {
      const body = stringifyOneBotJson(event), settings = this.config.onebot.reverseHttp;
      const response = await fetch(settings.url, { method: 'POST', body, redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', 'X-Self-ID': this.config.app.selfId,
          ...(settings.secret ? { 'X-Signature': `sha1=${createHmac('sha1', settings.secret).update(body).digest('hex')}` } : {}) } });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      if (!this.online && !this.stopped) this.logger.info({ endpoint: settings.url }, 'OneBot 反向 HTTP 已连接');
      this.online = true; this.failures = 0;
      if (event.post_type !== 'message' && event.post_type !== 'request') { await response.body?.cancel(); return { ok: true }; }
      // A 2xx response acknowledges delivery even if its optional quick operation is invalid.
      try {
        const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        if (reader) try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength; if (size > 256 * 1024) throw new Error('Quick operation response exceeds 256 KiB');
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        const text = Buffer.concat(chunks).toString('utf8').trim();
        return { ok: true, ...(text ? { operation: parseOneBotJson(text) } : {}) };
      } catch { this.logger.warn('反向 HTTP 快速操作响应无效，事件已确认接收'); return { ok: true }; }
    } catch (error) {
      this.online = false; this.failures++;
      if (!this.stopped && (this.failures === 1 || Date.now() - this.lastWarningAt >= 60000)) {
        this.lastWarningAt = Date.now();
        this.logger.warn({ endpoint: this.config.onebot.reverseHttp.url, error, attempts: this.failures }, '反向 HTTP 投递失败，事件已保留待重试');
      }
      return { ok: false };
    }
  }

}
