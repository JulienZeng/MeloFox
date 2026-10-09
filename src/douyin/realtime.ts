import type { NetworkEvent } from '../browser/network.js';
import type { AppLogger } from '../logger/index.js';
import {
  decodeNetworkResponseBodies,
  extractRealtimeMessageCandidatesFromDecoded,
  extractRealtimeMessageDetailsFromDecoded,
  type RealtimeMessageCandidate
} from './protobuf.js';
import { mergeRealtimeMessageDetail, shouldWaitForMessageDetail, toDouyinMessage } from './message-adapter.js';
import type { DouyinMessage, DouyinRecall } from './types.js';
import { isRecallMessage, toDouyinRecall } from './recall.js';

interface DecodedMessages {
  candidates: RealtimeMessageCandidate[];
  details: RealtimeMessageCandidate[];
}

interface PendingMessage {
  candidate: RealtimeMessageCandidate;
  state: 'waiting' | 'queued' | 'running';
  timer?: NodeJS.Timeout;
  controller?: AbortController;
  recalled?: boolean;
}

export interface RealtimeProcessorOptions {
  logger: AppLogger;
  emit: (message: DouyinMessage) => Promise<void>;
  emitRecall?: (notice: DouyinRecall) => Promise<void>;
  enrich: (candidate: RealtimeMessageCandidate, signal: AbortSignal) => Promise<RealtimeMessageCandidate>;
  decode?: (event: NetworkEvent) => Promise<DecodedMessages>;
  queueLimit?: number;
  mediaConcurrency?: number;
  mediaDetailWaitMs?: number;
  mediaTimeoutMs?: number;
  seenLimit?: number;
  seenTtlMs?: number;
  detailLimit?: number;
}

export function isRealtimeNetworkEvent(event: NetworkEvent): boolean {
  if (event.contentType === 'text/plain' || !(event.payloadBase64 || event.payloadPreview)) return false;
  if (event.type === 'ws_frame_received') return new URL(event.url).hostname === 'frontier-im.douyin.com';
  if (event.type !== 'response_body' || (event.status !== undefined && event.status !== 200)) return false;
  const url = new URL(event.url);
  return url.hostname === 'imapi.douyin.com' && /\/message\/(get_by_conversation|get_user_message|get_message_by_server_id)$/.test(url.pathname);
}

async function decodeEvent(event: NetworkEvent): Promise<DecodedMessages> {
  const decoded = await decodeNetworkResponseBodies([event]);
  if (event.type === 'ws_frame_received' && !decoded.some(item => item.candidates.length)) {
    throw new Error('Realtime frame could not be decoded as protobuf');
  }
  return {
    candidates: extractRealtimeMessageCandidatesFromDecoded(decoded),
    details: extractRealtimeMessageDetailsFromDecoded(decoded)
  };
}

export class RealtimeMessageProcessor {
  private readonly events: NetworkEvent[] = [];
  private readonly pending = new Map<string, PendingMessage>();
  private readonly mediaQueue: PendingMessage[] = [];
  private readonly seen = new Map<string, number>();
  private readonly recalls = new Map<string, { time: number; emitted: boolean }>();
  private readonly details = new Map<string, { candidate: RealtimeMessageCandidate; time: number }>();
  private readonly controllers = new Set<AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly idleWaiters = new Set<() => void>();
  private drainTask?: Promise<void>;
  private started = false;
  private stopped = false;
  private activeMedia = 0;
  private readonly queueLimit: number;
  private readonly concurrency: number;
  private readonly detailWaitMs: number;
  private readonly mediaTimeoutMs: number;
  private readonly seenLimit: number;
  private readonly seenTtlMs: number;
  private readonly detailLimit: number;
  private readonly decode: (event: NetworkEvent) => Promise<DecodedMessages>;
  private counters = { acceptedEvents: 0, processedEvents: 0, emittedMessages: 0, emittedNotices: 0, duplicates: 0, parseFailures: 0, deliveryFailures: 0, mediaFailures: 0, overflows: 0 };

  constructor(private readonly options: RealtimeProcessorOptions) {
    this.queueLimit = options.queueLimit ?? 10000;
    this.concurrency = options.mediaConcurrency ?? 2;
    this.detailWaitMs = options.mediaDetailWaitMs ?? 5000;
    this.mediaTimeoutMs = options.mediaTimeoutMs ?? 120000;
    this.seenLimit = options.seenLimit ?? 100000;
    this.seenTtlMs = options.seenTtlMs ?? 24 * 60 * 60 * 1000;
    this.detailLimit = options.detailLimit ?? 5000;
    this.decode = options.decode ?? decodeEvent;
    for (const value of [this.queueLimit, this.concurrency, this.detailWaitMs, this.mediaTimeoutMs, this.seenLimit, this.seenTtlMs, this.detailLimit]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Realtime processor limits must be positive integers');
    }
  }

  enqueue(event: NetworkEvent): boolean {
    if (this.stopped) return false;
    try { if (!isRealtimeNetworkEvent(event)) return false; }
    catch (error) { this.options.logger.warn({ error }, 'invalid realtime event URL'); return false; }
    if (this.events.length >= this.queueLimit) {
      this.overflow('network event');
      return false;
    }
    this.events.push(event);
    this.counters.acceptedEvents += 1;
    this.drain();
    return true;
  }

  start(): void {
    if (this.stopped) throw new Error('Cannot restart a stopped realtime processor');
    this.started = true;
    this.drain();
  }

  getStats() {
    this.pruneCaches();
    return {
      ...this.counters,
      queuedEvents: this.events.length,
      pendingMessages: this.pending.size,
      queuedMedia: this.mediaQueue.length,
      activeMedia: this.activeMedia,
      seenMessages: this.seen.size,
      recalledMessages: this.recalls.size,
      cachedDetails: this.details.size,
      running: this.started && !this.stopped,
      good: this.started && !this.stopped && this.counters.overflows === 0 && this.counters.deliveryFailures === 0
    };
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.events.length = 0;
    this.mediaQueue.length = 0;
    for (const job of this.pending.values()) clearTimeout(job.timer);
    this.pending.clear();
    for (const controller of this.controllers) controller.abort(new Error('Realtime processor stopped'));
    await Promise.allSettled([...(this.drainTask ? [this.drainTask] : []), ...this.tasks]);
    this.seen.clear();
    this.recalls.clear();
    this.details.clear();
    this.notifyIdle();
  }

  private drain(): void {
    if (!this.started || this.stopped || this.drainTask || !this.events.length) return;
    this.drainTask = this.consume().finally(() => {
      this.drainTask = undefined;
      this.drain();
      this.notifyIdle();
    });
  }

  private async consume(): Promise<void> {
    while (this.events.length && !this.stopped) {
      const event = this.events.shift()!;
      try {
        const decoded = await this.decode(event);
        if (this.stopped) return;
        this.pruneCaches();
        for (const detail of decoded.details) {
          if (!detail.serverMessageId) continue;
          this.details.delete(detail.serverMessageId);
          this.details.set(detail.serverMessageId, { candidate: detail, time: Date.now() });
          while (this.details.size > this.detailLimit) this.details.delete(this.details.keys().next().value!);
          const job = this.pending.get(detail.serverMessageId);
          if (job?.state === 'waiting') {
            job.candidate = mergeRealtimeMessageDetail(job.candidate, detail);
            if (!shouldWaitForMessageDetail(job.candidate)) await this.ready(job);
          }
        }
        // HTTP details enrich a WS notification, never generate a fresh message event.
        if (event.type === 'ws_frame_received') {
          for (const candidate of decoded.candidates) {
            try { await this.accept(candidate); }
            catch (error) {
              this.counters.parseFailures += 1;
              this.options.logger.warn({ error, messageId: candidate.serverMessageId }, 'failed to process one realtime message');
            }
          }
        }
      } catch (error) {
        this.counters.parseFailures += 1;
        this.options.logger.warn({ error, eventType: event.type }, 'failed to decode one realtime event');
      } finally { this.counters.processedEvents += 1; }
    }
  }

  private async accept(candidate: RealtimeMessageCandidate): Promise<void> {
    if (isRecallMessage(candidate)) {
      const notice = toDouyinRecall(candidate);
      if (notice) await this.recall(notice);
      return;
    }
    // Read-index/command updates are transport state, not user messages.
    if (candidate.messageType === 50001) return;
    const id = candidate.serverMessageId;
    if (!id) return;
    if (this.seen.has(id) || this.recalls.has(id)) { this.counters.duplicates += 1; return; }
    const existing = this.pending.get(id);
    if (existing) { this.counters.duplicates += 1; return; }
    const detail = this.details.get(id)?.candidate;
    const merged = mergeRealtimeMessageDetail(candidate, detail);
    if (candidate.messageType !== 27 && candidate.messageType !== 30 && !shouldWaitForMessageDetail(merged)) {
      await this.deliver(merged);
      return;
    }
    if (this.pending.size >= this.queueLimit) { this.overflow('pending message'); return; }
    const job: PendingMessage = { candidate: merged, state: 'waiting' };
    this.pending.set(id, job);
    if (shouldWaitForMessageDetail(job.candidate)) {
      job.timer = setTimeout(() => {
        if (job.candidate.messageType === 7) {
          this.options.logger.warn({ messageId: id }, 'text message detail timed out; reporting a fallback');
        }
        this.track(this.ready(job));
      }, this.detailWaitMs);
    } else await this.ready(job);
  }

  private async recall(notice: DouyinRecall): Promise<void> {
    const id = notice.messageId;
    if (this.recalls.get(id)?.emitted) { this.counters.duplicates += 1; return; }
    const state = { time: Date.now(), emitted: false };
    this.recalls.delete(id);
    this.recalls.set(id, state);
    while (this.recalls.size > this.seenLimit) this.recalls.delete(this.recalls.keys().next().value!);
    const job = this.pending.get(id);
    if (job) {
      job.recalled = true;
      clearTimeout(job.timer);
      job.controller?.abort(new Error('Message recalled'));
      const index = this.mediaQueue.indexOf(job);
      if (index !== -1) this.mediaQueue.splice(index, 1);
      this.pending.delete(id);
    }
    // Remember cancellation before awaiting notice delivery, including frames arriving before the original push.
    try {
      if (this.options.emitRecall) {
        await this.options.emitRecall(notice);
        this.counters.emittedNotices += 1;
      }
      state.emitted = true;
    } catch (error) {
      this.counters.deliveryFailures += 1;
      this.options.logger.error({ error, messageId: id }, 'failed to deliver recall notice');
    } finally {
      this.notifyIdle();
    }
  }

  private async ready(job: PendingMessage): Promise<void> {
    if (this.stopped || job.recalled || job.state !== 'waiting') return;
    clearTimeout(job.timer);
    if (job.candidate.messageType !== 27 && job.candidate.messageType !== 30) {
      job.state = 'running';
      try { await this.deliver(job.candidate); }
      finally { this.pending.delete(job.candidate.serverMessageId!); this.notifyIdle(); }
      return;
    }
    job.state = 'queued';
    this.mediaQueue.push(job);
    this.pumpMedia();
  }

  private pumpMedia(): void {
    while (!this.stopped && this.activeMedia < this.concurrency && this.mediaQueue.length) {
      const job = this.mediaQueue.shift()!;
      job.state = 'running';
      this.activeMedia += 1;
      this.track(this.processMedia(job).finally(() => {
        this.activeMedia -= 1;
        this.pending.delete(job.candidate.serverMessageId!);
        this.pumpMedia();
        this.notifyIdle();
      }));
    }
  }

  private async processMedia(job: PendingMessage): Promise<void> {
    const controller = new AbortController();
    job.controller = controller;
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('Realtime media processing timed out')), this.mediaTimeoutMs);
    let candidate = job.candidate;
    try {
      candidate = await withAbort(() => this.options.enrich(job.candidate, controller.signal), controller.signal);
    } catch (error) {
      if (this.stopped || job.recalled) return;
      this.counters.mediaFailures += 1;
      if (candidate.messageType === 27) candidate = { ...candidate, mediaUnavailable: true, mediaUrl: undefined };
      this.options.logger.warn({ error, messageId: candidate.serverMessageId }, 'media enrichment failed; reporting original message');
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
    if (!this.stopped && !job.recalled) await this.deliver(candidate);
  }

  private async deliver(candidate: RealtimeMessageCandidate): Promise<void> {
    if (this.stopped || (candidate.serverMessageId && this.recalls.has(candidate.serverMessageId))) return;
    const message = toDouyinMessage(candidate);
    if (!message) return;
    try {
      await this.options.emit(message);
      this.seen.set(message.messageId, Date.now());
      while (this.seen.size > this.seenLimit) this.seen.delete(this.seen.keys().next().value!);
      this.counters.emittedMessages += 1;
    } catch (error) {
      this.counters.deliveryFailures += 1;
      this.options.logger.error({ error, messageId: message.messageId }, 'failed to deliver one realtime message');
    }
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch(error => {
      this.counters.deliveryFailures += 1;
      this.options.logger.error({ error }, 'realtime background task failed');
    }).finally(() => { this.tasks.delete(tracked); this.notifyIdle(); });
    this.tasks.add(tracked);
  }

  private pruneCaches(): void {
    const now = Date.now();
    for (const [id, time] of this.seen) {
      if (now - time < this.seenTtlMs) break;
      this.seen.delete(id);
    }
    for (const [id, state] of this.recalls) {
      if (now - state.time < this.seenTtlMs) break;
      this.recalls.delete(id);
    }
    for (const [id, entry] of this.details) {
      if (now - entry.time < 60000) break;
      this.details.delete(id);
    }
  }

  private overflow(kind: string): void {
    this.counters.overflows += 1;
    this.options.logger.error({ kind, limit: this.queueLimit }, 'realtime queue overflow; message recovery is required');
  }

  private isIdle(): boolean {
    return !this.events.length && !this.drainTask && !this.pending.size && !this.tasks.size && this.activeMedia === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function withAbort<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
