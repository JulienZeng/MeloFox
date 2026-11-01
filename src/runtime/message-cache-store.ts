import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import type { DouyinBridgeCache } from '../douyin/bridge.js';
import type { AppLogger } from '../logger/index.js';
import { cleanupCacheTemps, readCacheJson, writeCacheJson } from './cache-file.js';
import type { CacheEntry } from './bounded-cache.js';
import type { CacheArchive, RetainedCache } from './retained-cache.js';

const id = z.string().min(1);
const scope = z.enum(['private', 'group']);
const message = z.object({
  messageId: id, conversationId: id, conversationShortId: id.optional(), conversationType: scope,
  senderId: id, senderName: z.string().optional(), messageType: z.number().int().optional(),
  senderCard: z.string().optional(), senderRole: z.enum(['owner', 'admin', 'member']).optional(),
  clientMessageId: z.string().optional(), content: z.string().optional(), text: z.string().optional(),
  segments: z.array(z.object({ type: id, data: z.record(z.union([z.string(), z.number(), z.boolean()])) })).optional(),
  timestamp: z.number().finite(), raw: z.unknown()
}).transform(value => ({ ...value, raw: value.raw }));
const target = z.object({ type: scope, conversationId: id.optional(), conversationShortId: id.optional(),
  userId: id.optional(), inboxType: z.number().int().optional() });
const recall = z.object({ messageId: id, conversationId: id, conversationShortId: id, conversationType: scope,
  senderId: id.optional(), peerUserId: id.optional(), operatorId: id, timestamp: z.number().finite(), raw: z.unknown()
}).transform(value => ({ ...value, raw: value.raw }));
const entries = <T extends z.ZodTypeAny>(value: T) => z.array(z.object({ key: id, value, expiresAt: z.number().finite() }));
const legacySnapshotSchema = z.object({
  pendingSends: entries(z.object({ target, createdAt: z.number(), messageId: z.string().optional(), rejected: z.boolean().optional() })).default([]),
  notifications: entries(z.boolean()).default([]),
  version: z.literal(1), accountId: id, messages: entries(message), sentClientMessageIds: entries(id),
  sentTargets: entries(z.object({ target, senderId: id })), recalls: entries(z.object({ notice: recall, emitted: z.boolean() }))
}).superRefine((saved, context) => {
  for (const collection of [saved.messages, saved.sentClientMessageIds, saved.sentTargets, saved.recalls]) {
    if (new Set(collection.map(entry => entry.key)).size !== collection.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate cache keys' });
    }
  }
  if (saved.messages.some(entry => entry.key !== entry.value.messageId) ||
    saved.recalls.some(entry => entry.key !== entry.value.notice.messageId) ||
    saved.sentTargets.some(entry => entry.value.senderId !== saved.accountId)) {
    context.addIssue({ code: 'custom', message: 'Cache identity mismatch' });
  }
});

const valueSchemas = { messages: message, notifications: z.boolean(), sentClientMessageIds: id,
  pendingSends: z.object({ target, createdAt: z.number(), messageId: z.string().optional(), rejected: z.boolean().optional() }),
  sentTargets: z.object({ target, senderId: id }), recalls: z.object({ notice: recall, emitted: z.boolean() }) };
type Kind = keyof typeof valueSchemas;
const kinds = Object.keys(valueSchemas) as Kind[];
const metadata = z.object({ key: id, expiresAt: z.number().finite(), createdAt: z.number().finite() });
type Metadata = z.infer<typeof metadata>;
const manifestSchema = z.object({ version: z.literal(2), accountId: id,
  pendingSends: z.array(metadata).default([]),
  notifications: z.array(metadata).default([]),
  syncCursors: z.record(z.object({ version: z.string().regex(/^\d{1,19}$/), cmdIndex: z.string().regex(/^\d{1,19}$/),
    readVersion: z.string().regex(/^\d{1,19}$/) })).optional(),
  messages: z.array(metadata), sentClientMessageIds: z.array(metadata), sentTargets: z.array(metadata), recalls: z.array(metadata)
}).superRefine((saved, context) => {
  for (const kind of kinds) if (new Set(saved[kind].map(entry => entry.key)).size !== saved[kind].length) {
    context.addIssue({ code: 'custom', message: 'Duplicate cache keys' });
  }
});
const recordSchema = z.object({ version: z.literal(1), accountId: id,
  kind: z.enum(['messages', 'notifications', 'pendingSends', 'sentClientMessageIds', 'sentTargets', 'recalls']), entry: z.object({
    key: id, expiresAt: z.number().finite(), value: z.unknown()
  }) });
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

export function messageRecordName(kind: Kind, key: string): string {
  return createHash('sha256').update(`${kind}\0${key}`).digest('hex') + '.json';
}

export class MessageCacheStore {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private saveAgain = false;
  private lastJson?: string;
  private readonly path: string;
  private readonly recordsDir: string;
  private readonly records = new Map<Kind, Map<string, Metadata>>(kinds.map(kind => [kind, new Map()]));
  private readonly changes = new Map<string, { kind: Kind; entry: CacheEntry<unknown> }>();
  private readonly garbage = new Set<string>();
  private initialized = false;

  constructor(private readonly cache: DouyinBridgeCache, private readonly config: AppConfig, private readonly logger: AppLogger) {
    this.path = resolve(config.runtime.messageCacheDir, 'messages.json');
    this.recordsDir = resolve(config.runtime.messageCacheDir, 'records');
    this.cache.persist = config.runtime.messageCachePersist ? () => this.flush() : undefined;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.config.runtime.messageCachePersist) return;
    try {
      await cleanupCacheTemps(this.path);
      const raw = await readCacheJson(this.path);
      if (raw !== undefined) {
        const legacy = (raw as { version?: number }).version === 1;
        const saved = legacy ? legacySnapshotSchema.parse(raw) : manifestSchema.parse(raw);
        // Restored entries remain hidden until the browser authenticates this account.
        this.cache.accountId = saved.accountId;
        this.cache.syncCursors = 'syncCursors' in saved ? saved.syncCursors : {};
        this.cache.restored = true;
        for (const kind of kinds) for (const item of saved[kind]) {
          const value = 'value' in item ? item.value : undefined;
          const createdAt = value !== undefined ? this.creationTime(kind, value, item.expiresAt) : (item as Metadata).createdAt;
          // A legacy sliding deadline must never renew the original message's age.
          const expiresAt = legacy && (kind === 'messages' || kind === 'recalls')
            ? createdAt + this.config.runtime.messageCacheTtlMs
            : Math.min(item.expiresAt, createdAt + this.config.runtime.messageCacheTtlMs);
          const meta = { key: item.key, createdAt, expiresAt };
          if (expiresAt <= Date.now()) { this.garbage.add(messageRecordName(kind, item.key)); continue; }
          this.records.get(kind)!.set(item.key, meta);
          if (legacy) this.changes.set(messageRecordName(kind, item.key), { kind,
            entry: { key: item.key, value, expiresAt } });
        }
        // Recall tombstones take precedence over both hot and disk message bodies.
        for (const key of this.records.get('recalls')!.keys()) {
          this.deleteRecord('messages', key);
          this.deleteRecord('sentTargets', key);
        }
        this.logger.info({ messages: this.records.get('messages')!.size,
          recalls: this.records.get('recalls')!.size }, 'restored message index; waiting for account verification');
      }
    } catch (error) {
      this.logger.warn({ error }, 'message cache index cannot be restored; starting with empty memory cache');
    }
    for (const kind of kinds) {
      const collection = this.cache[kind] as RetainedCache<unknown>;
      const archive: CacheArchive<unknown> = {
        get: key => this.readRecord(kind, key),
        expiresAt: key => this.records.get(kind)!.get(key)?.expiresAt,
        set: entry => this.stageRecord(kind, entry),
        delete: key => this.deleteRecord(kind, key),
        clear: () => { for (const key of this.records.get(kind)!.keys()) this.deleteRecord(kind, key); },
        size: () => { this.prune(); return this.records.get(kind)!.size; }
      };
      collection.attachArchive(archive, this.config.runtime.messageCacheTtlMs);
      // Keep startup bounded: bodies are read individually only when requested.
      collection.restore([]);
    }
    await this.sweepOrphans();
    this.timer = setInterval(() => {
      void this.flush().catch(error => this.logger.error({ error }, 'message cache persistence failed'));
    }, this.config.runtime.messageCacheFlushIntervalMs);
    this.timer.unref();
  }

  flush(): Promise<void> {
    if (!this.config.runtime.messageCachePersist) return Promise.resolve();
    if (this.pending) { this.saveAgain = true; return this.pending; }
    const operation = Promise.resolve().then(async () => {
      do {
        this.saveAgain = false;
        await this.saveSnapshot();
      } while (this.saveAgain);
    }).finally(() => { this.pending = undefined; });
    this.pending = operation;
    return operation;
  }

  private async saveSnapshot(): Promise<void> {
    if (!this.cache.accountId || this.cache.restored) return;
    this.prune();
    const accountId = this.cache.accountId;
    const changes = [...this.changes.entries()];
    const manifest = { version: 2, accountId, syncCursors: this.cache.syncCursors,
      ...Object.fromEntries(kinds.map(kind => [kind, [...this.records.get(kind)!.values()]])) };
    const json = JSON.stringify(manifest);
    // Commit bodies first, then the manifest; delete obsolete bodies only after that checkpoint.
    for (const [name, change] of changes) {
      await writeCacheJson(resolve(this.recordsDir, name), JSON.stringify({ version: 1, accountId,
        kind: change.kind, entry: change.entry }));
    }
    if (json !== this.lastJson || changes.length) {
      await writeCacheJson(this.path, json);
      this.lastJson = json;
    }
    for (const [name, change] of changes) if (this.changes.get(name) === change) this.changes.delete(name);
    const retained = new Set(kinds.flatMap(kind => [...this.records.get(kind)!.keys()].map(key => messageRecordName(kind, key))));
    for (const name of [...this.garbage]) {
      if (this.changes.has(name) || retained.has(name)) continue;
      await rm(resolve(this.recordsDir, name), { force: true });
      this.garbage.delete(name);
    }
  }

  private creationTime(kind: Kind, value: unknown, expiresAt: number): number {
    if (kind === 'messages') return message.parse(value).timestamp;
    if (kind === 'recalls') return valueSchemas.recalls.parse(value).notice.timestamp;
    return Math.min(Date.now(), expiresAt - this.config.runtime.messageCacheTtlMs);
  }

  private stageRecord(kind: Kind, entry: CacheEntry<unknown>): void {
    const value = valueSchemas[kind].parse(entry.value);
    if ((kind === 'messages' && (value as z.infer<typeof message>).messageId !== entry.key) ||
      (kind === 'recalls' && (value as z.infer<typeof valueSchemas.recalls>).notice.messageId !== entry.key)) {
      throw new Error('Cache identity mismatch');
    }
    const previous = this.records.get(kind)!.get(entry.key);
    const createdAt = kind === 'messages' || kind === 'recalls' ? this.creationTime(kind, value, entry.expiresAt)
      : previous?.createdAt ?? Date.now();
    const expiresAt = Math.min(entry.expiresAt, createdAt + this.config.runtime.messageCacheTtlMs);
    if (expiresAt <= Date.now()) { this.deleteRecord(kind, entry.key); return; }
    // Snapshot mutable values so a later mutation cannot silently change a pending checkpoint.
    const copied: unknown = JSON.parse(JSON.stringify(value));
    if (Buffer.byteLength(JSON.stringify(copied)) > MAX_RECORD_BYTES) throw new Error('Message cache record exceeds size limit');
    this.records.get(kind)!.set(entry.key, { key: entry.key, createdAt, expiresAt });
    const name = messageRecordName(kind, entry.key);
    this.garbage.delete(name);
    this.changes.set(name, { kind, entry: { key: entry.key, value: copied, expiresAt } });
  }

  private readRecord(kind: Kind, key: string): CacheEntry<unknown> | undefined {
    const meta = this.records.get(kind)!.get(key);
    if (!meta || meta.expiresAt <= Date.now()) { if (meta) this.deleteRecord(kind, key); return undefined; }
    const pending = this.changes.get(messageRecordName(kind, key));
    if (pending) return { ...pending.entry, expiresAt: meta.expiresAt };
    try {
      const path = resolve(this.recordsDir, messageRecordName(kind, key));
      const info = lstatSync(path);
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error('Invalid message cache record file');
      const saved = recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      const value = valueSchemas[kind].parse(saved.entry.value);
      if (saved.accountId !== this.cache.accountId || saved.kind !== kind || saved.entry.key !== key ||
        (kind === 'messages' && (value as z.infer<typeof message>).messageId !== key) ||
        (kind === 'recalls' && (value as z.infer<typeof valueSchemas.recalls>).notice.messageId !== key) ||
        (kind === 'sentTargets' && (value as z.infer<typeof valueSchemas.sentTargets>).senderId !== this.cache.accountId)) {
        throw new Error('Cache identity mismatch');
      }
      const createdAt = kind === 'messages' || kind === 'recalls'
        ? this.creationTime(kind, value, saved.entry.expiresAt) : meta.createdAt;
      const expiresAt = Math.min(meta.expiresAt, saved.entry.expiresAt, createdAt + this.config.runtime.messageCacheTtlMs);
      if (expiresAt <= Date.now()) { this.deleteRecord(kind, key); return undefined; }
      return { key, value, expiresAt };
    } catch (error) {
      this.logger.warn({ error, kind, key }, 'message cache record cannot be read');
      this.deleteRecord(kind, key);
      return undefined;
    }
  }

  private deleteRecord(kind: Kind, key: string): void {
    this.records.get(kind)!.delete(key);
    const name = messageRecordName(kind, key);
    this.changes.delete(name);
    this.garbage.add(name);
  }

  private prune(): void {
    const now = Date.now();
    for (const kind of kinds) for (const entry of this.records.get(kind)!.values()) {
      if (entry.expiresAt <= now) this.deleteRecord(kind, entry.key);
    }
  }

  private async sweepOrphans(): Promise<void> {
    await mkdir(this.recordsDir, { recursive: true, mode: 0o700 });
    const dir = await lstat(this.recordsDir);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Message records path must be a real directory');
    const retained = new Set(kinds.flatMap(kind => [...this.records.get(kind)!.keys()].map(key => messageRecordName(kind, key))));
    for (const file of await readdir(this.recordsDir, { withFileTypes: true })) {
      if (file.isDirectory()) continue;
      if (/^[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/.test(file.name) ||
        (/^[0-9a-f]{64}\.json$/.test(file.name) && !retained.has(file.name))) {
        await rm(resolve(this.recordsDir, file.name), { force: true });
      }
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.pending?.catch(() => undefined);
    await this.flush();
  }
}
