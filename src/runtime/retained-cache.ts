import { BoundedCache, type CacheEntry } from './bounded-cache.js';

export interface CacheArchive<T> {
  get(key: string): CacheEntry<T> | undefined;
  expiresAt(key: string): number | undefined;
  set(entry: CacheEntry<T>): void;
  delete(key: string): void;
  clear(): void;
  size(): number;
}

// Evicting a hot entry never deletes its independent disk record.
export class RetainedCache<T> extends BoundedCache<T> {
  private archive?: CacheArchive<T>;

  constructor(limit: number, private retentionMs: number, private readonly createdAt?: (value: T) => number,
    private readonly clock: () => number = Date.now) {
    super(limit, retentionMs, clock, false);
  }

  attachArchive(archive: CacheArchive<T>, retentionMs: number): void {
    this.retentionMs = retentionMs;
    this.archive = archive;
    for (const entry of this.snapshot()) archive.set({ ...entry,
      expiresAt: Math.min(entry.expiresAt, (this.createdAt?.(entry.value) ?? this.clock()) + retentionMs) });
  }

  override get(key: string): T | undefined {
    const value = super.get(key);
    if (value !== undefined) return value;
    const entry = this.archive?.get(key);
    if (!entry) return undefined;
    super.setEntry(entry);
    return entry.value;
  }

  override set(key: string, value: T): void {
    const existing = this.archive?.expiresAt(key) ?? super.getExpiry(key);
    const expiresAt = Math.min((this.createdAt?.(value) ?? this.clock()) + this.retentionMs,
      existing ?? Infinity, this.clock() + this.retentionMs);
    if (expiresAt <= this.clock()) { this.delete(key); return; }
    const entry = { key, value, expiresAt };
    this.archive?.set(entry);
    super.setEntry(entry);
  }

  override delete(key: string): void {
    super.delete(key);
    this.archive?.delete(key);
  }

  override clear(): void {
    super.clear();
    this.archive?.clear();
  }

  override restore(entries: CacheEntry<T>[]): void {
    super.clear();
    for (const entry of entries) {
      const expiresAt = Math.min(entry.expiresAt, (this.createdAt?.(entry.value) ?? this.clock()) + this.retentionMs);
      if (expiresAt > this.clock()) super.setEntry({ ...entry, expiresAt });
    }
  }

  get retainedSize(): number { return this.archive?.size() ?? this.size; }
}
