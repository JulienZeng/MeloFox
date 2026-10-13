import { parse, parseNumberAndBigInt } from 'lossless-json';
import type { OneBotMessageSegment } from '../onebot/types.js';

export interface DouyinShare {
  kind: 'web' | 'aweme' | 'user';
  title: string;
  url?: string;
  content?: string;
  image?: string;
  awemeId?: string;
  userId?: string;
}

export function parseDouyinShare(content: string | undefined, messageType: number | undefined): DouyinShare | undefined {
  if ([7, 27, 30, 150].includes(messageType ?? -1)) return undefined;
  let value: unknown;
  try { value = parse(content ?? '', undefined, parseNumberAndBigInt); } catch { return undefined; }
  if (!isRecord(value)) return undefined;
  const aweType = numericId(value.aweType);
  if (messageType === 8 || aweType === '800' || aweType === '803') {
    const awemeId = numericId(value.itemId);
    return { kind: 'aweme', awemeId,
      title: text(value.content_title) ?? text(value.title) ?? text(value.content_name) ?? '[抖音作品]',
      content: text(value.desc), image: coverUrl(value.cover_url) ?? coverUrl(value.content_thumb),
      url: awemeId ? `https://www.douyin.com/video/${awemeId}` : undefined };
  }
  if (messageType === 25 && text(value.name) && Object.hasOwn(value, 'avatar') && Object.hasOwn(value, 'uid')) {
    const secUid = text(value.secUID);
    return { kind: 'user', title: text(value.name)!, userId: numericId(value.uid),
      content: text(value.desc) ? `抖音号：${text(value.desc)}` : undefined,
      image: coverUrl(value.avatar),
      url: secUid && /^MS4w[A-Za-z0-9_-]{8,252}$/.test(secUid) ? `https://www.douyin.com/user/${secUid}` : undefined };
  }
  if (!Object.hasOwn(value, 'link_url') && !Object.hasOwn(value, 'link_url_v2')) return undefined;
  return { kind: 'web', title: text(value.title) ?? '[网页分享]', content: text(value.desc),
    url: httpUrl(value.link_url) ?? httpUrl(value.link_url_v2), image: coverUrl(value.cover_url) };
}

export function shareDisplayText(share: DouyinShare): string {
  return [share.title, share.content, share.url ?? '[分享链接暂不可用]'].filter(Boolean).join('\n');
}

export function shareMessageSegment(share: DouyinShare): OneBotMessageSegment {
  if (!share.url) return { type: 'text', data: { text: shareDisplayText(share) } };
  return { type: 'share', data: {
    url: share.url, title: share.title,
    ...(share.content ? { content: share.content } : {}),
    ...(share.image ? { image: share.image } : {}),
    platform: 'douyin', douyin_share_type: share.kind,
    ...(share.awemeId ? { douyin_aweme_id: share.awemeId } : {}),
    ...(share.userId ? { douyin_user_id: share.userId } : {})
  } };
}

function numericId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'bigint' &&
    !(typeof value === 'number' && Number.isSafeInteger(value))) return undefined;
  const id = String(value);
  return /^[1-9]\d{0,19}$/.test(id) ? id : undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    // Mobile card URL fields can retain a second layer of escaped ampersands.
    const url = new URL(value.replace(/\\u0026/gi, '&'));
    return !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function coverUrl(value: unknown): string | undefined {
  const direct = httpUrl(value);
  if (direct) return direct;
  if (!isRecord(value) || !Array.isArray(value.url_list)) return undefined;
  return value.url_list.map(httpUrl).find((url): url is string => Boolean(url));
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
