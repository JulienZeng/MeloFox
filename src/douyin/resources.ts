import { parse, parseNumberAndBigInt } from 'lossless-json';
import type { Page } from 'playwright';
import { z } from 'zod';
import { numericId, buildShareContent, type DouyinShareSendInput, type NativeMessageContent } from './native-message.js';
import type { ActionDeadline } from '../runtime/deadline.js';

const id = z.union([z.string(), z.bigint(), z.number().safe().int()]).transform(String).refine(value => /^[1-9]\d{0,19}$/.test(value));
const dimension = z.number().int().min(0).max(16384);
const httpUrl = z.string().url().max(16384).refine(value => {
  const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
});
const resource = z.object({ uri: z.string().min(1).max(2048), url_list: z.array(httpUrl).min(1).max(20),
  width: dimension.optional(), height: dimension.optional() });

/** JSON stays textual across the browser boundary so int64 identifiers are never rounded. */
export async function fetchDouyinResource(page: Page, path: string, params: Record<string, string>, deadline: ActionDeadline,
  method: 'GET' | 'POST' = 'GET', body?: string): Promise<any> {
  const text = await page.evaluate(async ({ path, params, timeout, method, body }) => {
    const query = new URLSearchParams({ aid: '6383', device_platform: 'webapp', channel: 'channel_pc_web',
      pc_client_type: '1', version_code: '170400', update_version_code: '170400', ...params });
    const response = await fetch(`https://www.douyin.com${path}?${query}`, { method, credentials: 'include',
      redirect: 'error', signal: AbortSignal.timeout(timeout), body,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' } }) });
    if (!response.ok) throw new Error(`Douyin resource HTTP ${response.status}`);
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 4 * 1024 * 1024) throw new Error('Douyin resource response too large');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
  }, { path, params, timeout: deadline.remainingMs(), method, body });
  deadline.remainingMs();
  const value = parse(text, (_key, item) => typeof item === 'bigint' && item >= BigInt(Number.MIN_SAFE_INTEGER) && item <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(item) : item, parseNumberAndBigInt);
  if (!value || typeof value !== 'object' || (value as any).status_code !== 0) throw new Error('Douyin resource query was rejected');
  return value;
}

export function parseStickerCatalog(value: unknown, search: boolean): { items: NativeMessageContent[]; cursor: string; hasMore: boolean; rejected: number } {
  const root = z.object({ status_code: z.literal(0), emoticon_data: z.object({
    stickers: z.array(z.unknown()).max(200).optional(), sticker_list: z.array(z.unknown()).max(200).optional(),
    cursor: z.union([z.string(), z.bigint(), z.number().safe().int()]).optional(), has_more: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional()
  }) }).parse(value);
  const list = search ? root.emoticon_data.sticker_list : root.emoticon_data.stickers;
  if (!list) throw new Error('Sticker catalog is missing its item list');
  const items: NativeMessageContent[] = []; let rejected = 0;
  for (const raw of list) {
    try {
      const item = z.object({ id: id.optional(), single_hey_can_id: id.optional(), origin_package_id: z.union([id, z.literal(0)]).optional(),
        animate_type: z.string().regex(/^(gif|webp|png|jpeg|jpg)$/i), display_name: z.string().max(256).optional(),
        sticker_type: z.number().int().optional(),
        width: dimension.optional(), height: dimension.optional(), origin: resource.optional(), animate_url: resource.optional() }).parse(raw);
      const url = search ? item.origin : item.animate_url;
      const imageId = search ? item.id : item.single_hey_can_id;
      if ([15, 16].includes(item.sticker_type ?? -1)) throw new Error('Clone stickers require their own protocol');
      if (!url || !imageId) throw new Error('Unsupported sticker metadata');
      const content = JSON.stringify({ display_name: item.display_name ?? '', height: (search ? url.height : item.height) ?? 0,
        width: (search ? url.width : item.width) ?? 0, image_id: imageId, image_type: item.animate_type,
        package_id: search ? item.origin_package_id ?? 0 : 0, show_notice: false, resource_type: 0,
        updateConversationTime: true, createdAt: 0, is_card: false, msgHint: '', aweType: search ? 510 : 501,
        url: { height: 0, width: 0, data_size: 0, uri: url.uri, url_list: url.url_list } });
      items.push({ messageType: 5, content, text: item.display_name ? `[${item.display_name}]` : '[表情]' });
    } catch { rejected++; }
  }
  const cursor = String(root.emoticon_data.cursor ?? '0');
  if (!/^\d{1,19}$/.test(cursor)) throw new Error('Invalid sticker cursor');
  return { items, cursor, hasMore: Boolean(root.emoticon_data.has_more), rejected };
}

export async function resolveDouyinUrl(input: string, deadline: ActionDeadline): Promise<string> {
  let url = new URL(input);
  for (let count = 0; count < 6; count++) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !['v.douyin.com', 'www.douyin.com', 'douyin.com', 'www.iesdouyin.com'].includes(url.hostname)) throw new Error('Expected a Douyin HTTPS share URL');
    const match = /^\/(video|note|user)\/([^/]+)\/?$/.exec(url.pathname) ?? /^\/share\/(video|user)\/([^/]+)\/?$/.exec(url.pathname);
    if (match) return `https://www.douyin.com/${match[1]}/${match[2]}`;
    if (url.hostname !== 'v.douyin.com' && count === 0) throw new Error('Unsupported Douyin share URL');
    const response = await fetch(url, { redirect: 'manual', signal: deadline.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) throw new Error('Douyin short URL did not resolve to a supported share');
    url = new URL(location, url); deadline.remainingMs();
  }
  throw new Error('Too many Douyin short URL redirects');
}

export function awemeShareFromDetail(value: unknown, awemeId: string): Exclude<DouyinShareSendInput, { sourceMessageId: string } | { resolveUrl: string }> {
  const detail = z.object({ aweme_id: id, desc: z.string().max(4096), aweme_type: z.number().optional(),
    author: z.object({ uid: id, sec_uid: z.string(), nickname: z.string().max(256) }),
    images: z.array(z.unknown()).max(10000).optional(), video: z.object({ cover: z.object({ url_list: z.array(httpUrl) }).optional() }).optional()
  }).parse(value);
  if (detail.aweme_id !== awemeId) throw new Error('Share detail ID mismatch');
  const photos = (detail.images?.length ?? 0) > 0;
  const photo = z.object({ url_list: z.array(httpUrl).min(1) }).safeParse(detail.images?.[0]);
  const input = { kind: photos ? 'photos' as const : 'aweme' as const, url: `https://www.douyin.com/${photos ? 'note' : 'video'}/${numericId(awemeId, 'aweme_id')}`,
    title: detail.desc || '[抖音作品]', userId: detail.author.uid, secUid: detail.author.sec_uid, authorName: detail.author.nickname,
    image: detail.video?.cover?.url_list[0] ?? (photo.success ? photo.data.url_list[0] : undefined), ...(photos ? { imageCount: detail.images!.length } : {}) };
  buildShareContent(input); return input;
}
