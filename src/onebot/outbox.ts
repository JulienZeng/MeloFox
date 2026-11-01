import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readCacheJson, writeCacheJson } from '../runtime/cache-file.js';
import type { OneBotEvent } from './types.js';

const schema = z.object({ accountId: z.string(), entries: z.array(z.object({ id: z.string(),
  createdAt: z.number(), event: z.record(z.unknown()) })).max(10000) });

/** Durable transport queue. A WebSocket write is not an application acknowledgement. */
export class EventOutbox {
  private entries: Array<{ id: string; createdAt: number; event: OneBotEvent }> = [];
  private chain: Promise<unknown> = Promise.resolve();
  private initialized = false;
  constructor(private readonly path: string, private readonly accountId: string) {}
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const raw = await readCacheJson(this.path);
    if (raw) {
      const value = schema.parse(raw);
      if (value.accountId === this.accountId) this.entries = value.entries as typeof this.entries;
    }
    this.initialized = true;
  }
  get size(): number { return this.entries.length; }
  enqueue(event: OneBotEvent): Promise<void> {
    return this.serial(async () => {
      await this.initialize();
      if (String(event.self_id) !== this.accountId) throw new Error('Event outbox account mismatch');
      if (this.entries.length >= 10000) throw new Error('Event outbox full; restore the OneBot connection before continuing');
      const entry = { id: randomUUID(), createdAt: Date.now(), event };
      this.entries.push(entry);
      try { await this.persist(); } catch (error) { this.entries.pop(); throw error; }
    });
  }
  drain(deliver: (event: OneBotEvent) => Promise<boolean>): Promise<void> {
    return this.serial(async () => {
      await this.initialize();
      while (this.entries.length) {
        if (!await deliver(this.entries[0].event)) break;
        const entry = this.entries.shift()!;
        try { await this.persist(); } catch (error) { this.entries.unshift(entry); throw error; }
      }
    });
  }
  settled(): Promise<unknown> { return this.chain; }
  private persist() { return writeCacheJson(this.path, JSON.stringify({ accountId: this.accountId, entries: this.entries })); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation); this.chain = result.catch(() => undefined); return result;
  }
}
