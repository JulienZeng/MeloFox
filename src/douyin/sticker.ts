import { parse, parseNumberAndBigInt } from 'lossless-json';
import type { Page } from 'playwright';
import type { ImageFormat } from '../media/image.js';
import type { OneBotMessageSegment } from '../onebot/types.js';

export interface DouyinSticker {
  url?: string;
  name?: string;
  id?: string;
  imageId?: string;
  packageId?: string;
  stickerType?: number;
}

export function parseDouyinSticker(content: string | undefined, messageType: number | undefined): DouyinSticker | undefined {
  if (messageType !== 5) return undefined;
  try {
    const value = parse(content ?? '', undefined, parseNumberAndBigInt);
    if (!record(value)) return undefined;
    return {
      // App IDUrlModel wraps its URL in static_url, including the animate_url field.
      url: resourceUrl(value.animate_url) ?? resourceUrl(value.url),
      name: typeof value.display_name === 'string' ? value.display_name.slice(0, 256) : undefined,
      id: typeof value.id === 'string' && value.id.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.id) ? value.id : resourceId(value.id),
      imageId: resourceId(value.image_id), packageId: resourceId(value.package_id),
      stickerType: stickerType(value.sticker_type)
    };
  } catch { return undefined; }
}

export function stickerSegment(sticker: DouyinSticker | undefined, cachedUrl?: string): OneBotMessageSegment {
  if (!cachedUrl) return { type: 'text', data: { text: `[表情暂不可用${sticker?.name ? `: ${sticker.name}` : ''}]` } };
  const data = { file: cachedUrl, url: cachedUrl, sub_type: 1,
    douyin_emoji_id: sticker?.id, douyin_image_id: sticker?.imageId, douyin_package_id: sticker?.packageId,
    douyin_sticker_type: sticker?.stickerType, douyin_display_name: sticker?.name };
  return { type: 'image', data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) };
}

export function stickerText(sticker: DouyinSticker | undefined): string {
  const name = sticker?.name?.trim();
  return name ? `[${name.replace(/^\[|\]$/g, '')}]` : '[表情]';
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resourceId(value: unknown): string | undefined {
  const text = typeof value === 'bigint' || typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)) ? String(value) : '';
  return /^[1-9]\d{0,19}$/.test(text) ? text : undefined;
}

function stickerType(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'bigint') return undefined;
  const type = Number(value);
  return Number.isSafeInteger(type) && type >= 0 ? type : undefined;
}

function resourceUrl(value: unknown): string | undefined {
  if (record(value)) {
    if (Array.isArray(value.url_list)) {
      for (const url of value.url_list) {
        const valid = resourceUrl(url);
        if (valid) return valid;
      }
    }
    return resourceUrl(value.static_url) ?? resourceUrl(value.uri);
  }
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value.replace(/\\u0026/gi, '&'));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export async function validateStickerImage(page: Page, bytes: Buffer, format: ImageFormat, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const validation = page.evaluate(async ({ base64, type }) => {
    interface Decoder {
      completed: Promise<void>;
      tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
      decode(options: { frameIndex: number }): Promise<{ image: { close(): void } }>;
      close(): void;
    }
    const ctor = (globalThis as unknown as { ImageDecoder?: new (options: { data: Uint8Array; type: string; preferAnimation: boolean }) => Decoder }).ImageDecoder;
    if (!ctor) throw new Error('Browser image decoder is unavailable');
    const data = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const decoder = new ctor({ data, type, preferAnimation: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await decoder.completed;
          await decoder.tracks.ready;
          const count = decoder.tracks.selectedTrack?.frameCount;
          if (!count || !Number.isSafeInteger(count)) throw new Error('Sticker contains no decodable frames');
          (await decoder.decode({ frameIndex: 0 })).image.close();
          if (count > 1) (await decoder.decode({ frameIndex: count - 1 })).image.close();
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sticker decoding timed out')), 10000); })
      ]);
    } finally { clearTimeout(timer); decoder.close(); }
  }, { base64: bytes.toString('base64'), type: format.contentType });
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([validation, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason ?? new Error('Sticker validation aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })]);
    signal?.throwIfAborted();
  } finally { if (onAbort) signal?.removeEventListener('abort', onAbort); }
}
