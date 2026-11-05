import { randomUUID } from 'node:crypto';
import type { LogBatch, LogEntry } from './contracts.js';

/** One bounded, process-local history shared by stdout and authenticated console readers. */
export class LogBuffer {
  readonly streamId = randomUUID();
  private entries: LogEntry[] = [];
  private bytes = 0;
  private sequence = 0;
  constructor(readonly capacity = 1000, private readonly maxBytes = 4 * 1024 * 1024) {}
  append(input: Omit<LogEntry, 'id'>): LogEntry {
    const entry = { ...input, id: ++this.sequence };
    this.entries.push(entry);
    this.bytes += this.size(entry);
    while (this.entries.length > this.capacity || (this.bytes > this.maxBytes && this.entries.length > 1))
      this.bytes -= this.size(this.entries.shift()!);
    return entry;
  }
  recent(limit = 5): LogEntry[] { return this.entries.slice(-limit); }
  read(after?: number, streamId?: string): LogBatch {
    const reset = Boolean(streamId && streamId !== this.streamId) || (after !== undefined && after > this.sequence);
    const cursor = reset ? undefined : after;
    return {
      streamId: this.streamId,
      entries: this.entries.filter(entry => cursor === undefined || entry.id > cursor),
      cursor: this.sequence,
      capacity: this.capacity,
      truncated: cursor !== undefined && cursor < (this.entries[0]?.id ?? 1) - 1,
      reset,
    };
  }
  private size(entry: LogEntry): number {
    return Buffer.byteLength(entry.message + (entry.details ?? '') + entry.scope) + 100;
  }
}
