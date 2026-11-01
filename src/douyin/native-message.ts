import { validateGroupCard } from './group-card.js';
import { interactiveEmojiSegment, validateInteractiveEmoji } from './interactive-emoji.js';
import { isLosslessNumber, parse, parseNumberAndBigInt, stringify } from 'lossless-json';
import { parseDouyinShare, shareDisplayText } from './share.js';
import { parseDouyinSticker, stickerText } from './sticker.js';
import { locationSegment } from './card-compat.js';
import type { DouyinMessage } from './types.js';

export type DouyinShareSendInput = { sourceMessageId: string } | { resolveUrl: string } | StructuredShareInput;

export interface StructuredShareInput {
  kind: 'web' | 'aweme' | 'photos' | 'user';
  url: string;
  title: string;
  description?: string;
  image?: string;
  userId?: string;
  authorName?: string;
  secUid?: string;
  imageCount?: number;
};

export interface NativeMessageContent {
  messageType: 5 | 8 | 22 | 25 | 26 | 58 | 77 | 136 | 502;
  forwardSendId?: string;
  content: string;
  text: string;
}

// Only structured fields or a current-account cached message can become native content.
// Protocol reference: DouYin_Spider/dy_apis/douyin_im_media.py at fc8b9c2.
export function buildShareContent(input: StructuredShareInput): NativeMessageContent {
  const url = httpUrl(input.url, 'share url');
  const title = boundedText(input.title, 'share title', 4096, true);
  const desc = boundedText(input.description ?? '', 'share content', 8192);
  const image = input.image === undefined ? '' : httpUrl(input.image, 'share image');
  if (input.kind === 'web') {
    return nativeContent(26, { title, desc, cover_url: image, link_url: webCardUrl(url) });
  }
  const target = new URL(url);
  if (!['www.douyin.com', 'douyin.com'].includes(target.hostname) || target.port) {
    throw new Error('Native Douyin shares require a douyin.com video, note, or user URL');
  }
  const cover = { uri: image, url_list: image ? [image] : [] };
  if (input.kind === 'user') {
    const match = /^\/user\/(MS4w[A-Za-z0-9_-]{8,252})\/?$/.exec(target.pathname);
    if (!match) throw new Error('User share requires a Douyin secUID profile URL');
    return nativeContent(25, { uid: numericId(input.userId, 'douyin_user_id'), secUID: match[1],
      name: title, avatar: cover, cover_items: [], cover_url: [], desc: desc.replace(/^抖音号：/, '') });
  }
  if (input.kind !== 'aweme' && input.kind !== 'photos') throw new Error('Unsupported Douyin share kind');
  const match = new RegExp(`^/${input.kind === 'photos' ? 'note' : 'video'}/([1-9]\\d{0,19})/?$`).exec(target.pathname);
  if (!match) throw new Error(`Douyin ${input.kind} share requires its matching canonical video/note URL`);
  const uid = input.userId === undefined ? '' : numericId(input.userId, 'douyin_user_id');
  const secUid = input.secUid ?? '';
  if (secUid && !/^MS4w[A-Za-z0-9_-]{8,252}$/.test(secUid)) throw new Error('Invalid douyin_sec_uid');
  if (input.imageCount !== undefined && (!Number.isSafeInteger(input.imageCount) || input.imageCount < 1 || input.imageCount > 10000)) {
    throw new Error('douyin_image_count must be an integer between 1 and 10000');
  }
  return nativeContent(input.kind === 'photos' ? 77 : 8, {
    aweType: input.kind === 'photos' ? 0 : 800, awemeType: input.kind === 'photos' ? 68 : 0,
    content_name: boundedText(input.authorName ?? '', 'douyin_author_name', 256), content_title: title,
    content_thumb: cover, cover_url: cover, cover_width: 0, cover_height: 0,
    itemId: match[1], uid, secUID: secUid, share_id: uid ? `${uid}_${Date.now()}_${match[1]}` : '',
    share_with_timestamp: 0, is_aigc: false, is_hot_spot_video: false, is_live_photo: 0,
    is_slides: false, is_story: false, is_text: 0, share_info: [], anchor_info: {}, poi_track_params: {}, ai_ext: '{}',
    ...(input.kind === 'photos' ? { cover_url_v2: cover, image_count: input.imageCount ?? 1, image_index: 0 } : { create_id: '' })
  });
}

export function cachedNativeContent(message: DouyinMessage, kind: 'share' | 'sticker'): NativeMessageContent {
  const content = message.content;
  if (!content || Buffer.byteLength(content) > 64 * 1024) throw new Error('Cached native message content is missing or too large');
  if (kind === 'sticker') {
    const sticker = parseDouyinSticker(content, message.messageType);
    if (!sticker?.url || !(sticker.id || sticker.imageId)) throw new Error('Cached message has no reusable native sticker metadata');
    return { messageType: 5, content, text: stickerText(sticker) };
  }
  if (![8, 25, 26, 77].includes(message.messageType ?? -1)) throw new Error('Cached message is not a supported share card');
  const share = parseDouyinShare(content, message.messageType);
  if (!share?.url || (share.kind === 'user' && !share.userId)) throw new Error('Cached share has no valid destination or identity');
  const messageType = { aweme: 8, photos: 77, web: 26, user: 25 }[share.kind] as NativeMessageContent['messageType'];
  if (share.kind === 'web') {
    const value = parse(content, undefined, parseNumberAndBigInt) as Record<string, unknown>;
    value.link_url = webCardUrl(httpUrl(share.url, 'cached share URL'));
    return { messageType, content: stringify(value)!, text: shareDisplayText(share) };
  }
  // Preserve the original JSON byte-for-byte, including int64 literals and experiment fields.
  return { messageType, content, text: shareDisplayText(share) };
}

export function nativeSourceId(value: unknown): string {
  const id = numericId(value, 'douyin_source_message_id');
  if (BigInt(id) > 9223372036854775807n) throw new Error('douyin_source_message_id exceeds int64 range');
  return id;
}

export function numericId(value: unknown, label: string): string {
  if (isLosslessNumber(value)) value = value.toString();
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
    throw new Error(`${label} must be a decimal string; large IDs must not be JavaScript numbers`);
  }
  const id = String(value);
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error(`${label} must be a positive decimal ID`);
  return id;
}

function nativeContent(messageType: NativeMessageContent['messageType'], value: Record<string, unknown>): NativeMessageContent {
  const content = JSON.stringify(value);
  return { messageType, content, text: shareDisplayText(parseDouyinShare(content, messageType)!) };
}

function boundedText(value: unknown, label: string, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (required && !value.trim())) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function httpUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 16384 || !/^https?:\/\//i.test(value) || /[\x00-\x20\x7f]/.test(value)) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials`);
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${label}`); }
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  return url.href;
}

function webCardUrl(value: string): string {
  const url = new URL(value);
  const targets = url.searchParams.getAll('pc_iframe_src');
  if (targets.length > 1) throw new Error('Share URL contains duplicate pc_iframe_src targets');
  if (targets[0]) httpUrl(targets[0], 'pc_iframe_src');
  else url.searchParams.set('pc_iframe_src', value);
  return url.href;
}

export function validateNativeContent(message: NativeMessageContent): void {
  if (![5, 8, 22, 25, 26, 58, 77, 136, 502].includes(message.messageType) || !message.content || Buffer.byteLength(message.content) > 64 * 1024) {
    throw new Error('Invalid native message type or content size');
  }
  let value: unknown;
  try { value = parse(message.content, undefined, parseNumberAndBigInt); } catch { throw new Error('Invalid native message JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native message JSON object');
  if (message.messageType === 502) { if (!locationSegment(message.content)) throw new Error('Invalid location content'); return; }
  if (message.messageType === 136) {
    const card = value as Record<string, unknown>;
    if (Number(card.aweType) !== 13600 || !Array.isArray(card.msg_ids) || !message.forwardSendId || message.forwardSendId.length > 1024) throw new Error('Forward requires verified content and send ID');
    return;
  }
  if (message.messageType === 22) return; // Only exposed through current-account cached music cards.
  if (message.messageType === 58) { validateGroupCard(message.content); return; }
  if (message.messageType === 5 && interactiveEmojiSegment(message.content)) { validateInteractiveEmoji(message.content); return; }
  const validated = cachedNativeContent({ messageType: message.messageType, content: message.content } as DouyinMessage, message.messageType === 5 ? 'sticker' : 'share');
  if (validated.messageType !== message.messageType) throw new Error('Native message type does not match its content');
}
