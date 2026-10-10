export interface CacheEntry<T> {
  key: string;
  value: T;
  expiresAt: number;
}

export class BoundedCache<T> {
  private readonly items = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly sliding = true
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('Invalid cache limit or TTL');
    }
  }

  get(key: string): T | undefined {
    this.prune();
    const item = this.items.get(key);
    if (!item) return undefined;
    if (this.sliding) this.set(key, item.value);
    else { this.items.delete(key); this.items.set(key, item); }
    return item.value;
  }

  set(key: string, value: T): void {
    this.setEntry({ key, value, expiresAt: this.now() + this.ttlMs });
  }

  setEntry(entry: CacheEntry<T>): void {
    this.prune();
    if (entry.expiresAt <= this.now()) return;
    this.items.delete(entry.key);
    this.items.set(entry.key, { value: entry.value, expiresAt: entry.expiresAt });
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value!);
  }

  get size(): number {
    this.prune();
    return this.items.size;
  }

  getExpiry(key: string): number | undefined {
    const expiresAt = this.items.get(key)?.expiresAt;
    return expiresAt !== undefined && expiresAt > this.now() ? expiresAt : undefined;
  }

  clear(): void {
    this.items.clear();
  }

  delete(key: string): void {
    this.items.delete(key);
  }

  snapshot(): CacheEntry<T>[] {
    this.prune();
    return [...this.items].map(([key, item]) => ({ key, ...item }));
  }

  restore(entries: CacheEntry<T>[]): void {
    this.clear();
    const now = this.now();
    for (const entry of entries) {
      if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) continue;
      this.items.delete(entry.key);
      this.items.set(entry.key, { value: entry.value, expiresAt: Math.min(entry.expiresAt, now + this.ttlMs) });
      while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value!);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, item] of this.items) {
      if (item.expiresAt <= now) this.items.delete(key);
    }
  }
}
