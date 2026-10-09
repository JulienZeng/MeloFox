export class BoundedCache<T> {
  private readonly items = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('Invalid cache limit or TTL');
    }
  }

  get(key: string): T | undefined {
    this.prune();
    const item = this.items.get(key);
    if (!item) return undefined;
    this.set(key, item.value);
    return item.value;
  }

  set(key: string, value: T): void {
    this.prune();
    this.items.delete(key);
    this.items.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value!);
  }

  get size(): number {
    this.prune();
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, item] of this.items) {
      if (item.expiresAt > now) break;
      this.items.delete(key);
    }
  }
}
