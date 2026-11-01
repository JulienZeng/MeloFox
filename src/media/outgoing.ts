import { Agent, EnvHttpProxyAgent } from 'undici';

export interface MediaDownloadOptions { cache?: boolean; proxy?: boolean; timeout?: number }

export function mediaDownloadOptions(data: Record<string, unknown>): MediaDownloadOptions {
  const flag = (name: string) => {
    const value = data[name];
    if (value === undefined) return undefined;
    if ([true, 1, '1', 'true', 'yes'].includes(value as never)) return true;
    if ([false, 0, '0', 'false', 'no'].includes(value as never)) return false;
    throw new Error(`${name} must be 0/1, false/true, or no/yes`);
  };
  const timeout = data.timeout === undefined ? undefined : Number(data.timeout);
  if (timeout !== undefined && ((typeof data.timeout !== 'number' && typeof data.timeout !== 'string') ||
    !Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483)) throw new Error('timeout must be a positive number of seconds');
  if (data.type !== undefined && data.type !== '') throw new Error('Unsupported: flash images have no verified Douyin mapping');
  return { cache: flag('cache'), proxy: flag('proxy'), timeout };
}

/** Per bridge/account, bounded byte cache. Signed source URLs and bytes never enter logs. */
export class OutgoingMediaCache {
  private readonly items = new Map<string, { bytes: Buffer; expires: number }>();
  private bytes = 0;
  private generation = 0;
  constructor(private readonly capacity = 64 * 1024 * 1024, private readonly ttlMs = 10 * 60 * 1000) {}
  clear(): void { this.generation++; this.items.clear(); this.bytes = 0; }
  async download(url: URL, options: MediaDownloadOptions, maxBytes: number, parentSignal: AbortSignal): Promise<Buffer> {
    parentSignal.throwIfAborted();
    const key = `${options.proxy !== false}:${url.href}`, cached = this.items.get(key), generation = this.generation;
    if (cached && (cached.expires <= Date.now() || options.cache === false)) { this.items.delete(key); this.bytes -= cached.bytes.length; }
    else if (cached) {
      if (cached.bytes.length > maxBytes) throw new Error('File exceeds maximum size');
      this.items.delete(key); this.items.set(key, cached); return Buffer.from(cached.bytes);
    }
    const bytes = await downloadMedia(url, options, maxBytes, parentSignal);
    parentSignal.throwIfAborted();
    if (options.cache !== false && bytes.length <= this.capacity && generation === this.generation) {
      const previous = this.items.get(key); if (previous) { this.bytes -= previous.bytes.length; this.items.delete(key); }
      while (this.bytes + bytes.length > this.capacity && this.items.size) {
        const first = this.items.keys().next().value!; this.bytes -= this.items.get(first)!.bytes.length; this.items.delete(first);
      }
      this.items.set(key, { bytes: Buffer.from(bytes), expires: Date.now() + this.ttlMs }); this.bytes += bytes.length;
    }
    return bytes;
  }
}

export async function downloadMedia(url: URL, options: MediaDownloadOptions, maxBytes: number, parentSignal: AbortSignal): Promise<Buffer> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid media URL');
  const signal = options.timeout === undefined ? parentSignal : AbortSignal.any([parentSignal, AbortSignal.timeout(Math.ceil(options.timeout * 1000))]);
  signal.throwIfAborted();
  const dispatcher = options.proxy === false ? new Agent() : new EnvHttpProxyAgent();
  let response: Response | undefined;
  try {
    response = await fetch(url, { signal, dispatcher } as RequestInit);
    if (!response.ok || !response.body) throw new Error(`File download failed: HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('File exceeds maximum size');
    const reader = response.body.getReader(), parts: Buffer[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        signal.throwIfAborted(); size += part.value.byteLength;
        if (size > maxBytes) throw new Error('File exceeds maximum size');
        parts.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => undefined); }
    if (!size) throw new Error('Empty files are not supported');
    return Buffer.concat(parts, size);
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    await dispatcher.destroy();
  }
}
