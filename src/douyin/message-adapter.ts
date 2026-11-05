import { locationSegment } from './card-compat.js';
import type { Page } from 'playwright';
import { parse, parseNumberAndBigInt, stringify } from 'lossless-json';
import type { AppLogger } from '../logger/index.js';
import type { MediaRegistry } from '../media/registry.js';
import { atSegment, imageSegment, recordSegment, replySegment, textSegment, videoSegment } from '../onebot/message-segment.js';
import type { OneBotMessageSegment } from '../onebot/types.js';
import type { RealtimeMessageCandidate } from './protobuf.js';
import type { DouyinMessage } from './types.js';
import { extractDouyinVideoKey, extractDouyinVideoSkey, resolveDouyinVideoUrl } from './video-url.js';
import { enrichRealtimeFile, parseDouyinFile } from './file.js';
import type { DouyinFileResource } from './file-url.js';
import { parseDouyinShare, shareDisplayText, shareMessageSegment } from './share.js';
import { parseDouyinSticker, stickerSegment, stickerText, validateStickerImage } from './sticker.js';
import { isVoiceMessageType, voiceSegment, voiceUrl } from './voice.js';

export function shouldWaitForMessageDetail(candidate: RealtimeMessageCandidate): boolean {
  // Mobile quoted text may have an empty WS body; HTTP supplies text and mentions.
  if (candidate.messageType === 7) return !candidate.content?.trim();
  if (candidate.messageType === 5) return !parseDouyinSticker(candidate.content, 5)?.url;
  if (candidate.messageType === 17) return !voiceUrl(candidate.content);
  if (candidate.messageType === 150) {
    try { parseDouyinFile(candidate.content); return false; } catch { return true; }
  }
  if ([8, 22, 25, 26, 58, 77, 136, 502].includes(candidate.messageType ?? 0)) return !candidate.content?.trim();

  if (candidate.messageType !== 27 && candidate.messageType !== 30) {
    return false;
  }

  const parsedContent = parseJson(candidate.content);
  if (candidate.messageType === 30 && extractDouyinVideoKey(parsedContent)) return false;
  return collectUrls(parsedContent ?? candidate.raw).length === 0;
}

export function mergeRealtimeMessageDetail(
  candidate: RealtimeMessageCandidate,
  detail: RealtimeMessageCandidate | undefined
): RealtimeMessageCandidate {
  if (!detail) {
    return candidate;
  }

  return {
    ...candidate,
    conversationId: candidate.conversationId ?? detail.conversationId,
    conversationShortId: candidate.conversationShortId ?? detail.conversationShortId,
    sender: candidate.sender ?? detail.sender,
    messageType: candidate.messageType ?? detail.messageType,
    content: mergeMessageContent(candidate.content, detail.content),
    text: candidate.text || detail.text,
    reference: candidate.reference ?? detail.reference,
    raw: {
      ...(isRecord(candidate.raw) ? candidate.raw : { realtime: candidate.raw }),
      detail: detail.raw
    }
  };
}

export async function enrichRealtimeVideoUrl(
  page: Page,
  mediaRegistry: MediaRegistry,
  logger: AppLogger,
  candidate: RealtimeMessageCandidate,
  signal: AbortSignal
): Promise<RealtimeMessageCandidate> {
  if (candidate.messageType !== 30) {
    return candidate;
  }

  const parsedContent = parseJson(candidate.content);
  const existingVideoUrl = candidate.mediaUrl ?? collectUrls(parsedContent ?? candidate.raw).find(isVideoUrl);
  if (existingVideoUrl) {
    return {
      ...candidate,
      mediaUrl: existingVideoUrl
    };
  }

  const videoKey = extractDouyinVideoKey(parsedContent);
  if (!videoKey) {
    logger.warn({ messageId: candidate.serverMessageId }, '视频消息缺少必要的资源标识');
    return candidate;
  }

  const videoSkey = extractDouyinVideoSkey(parsedContent);
  logger.debug?.(
    { messageId: candidate.serverMessageId },
    '正在解析视频资源'
  );

  signal.throwIfAborted();
  const resolved = await resolveDouyinVideoUrl(page, videoKey);
  signal.throwIfAborted();
  if (!resolved) {
    throw new Error('Douyin video resolver returned no playable URL');
  }

  const cachedUrl = await mediaRegistry.cacheRemote(resolved, 'video/mp4', '.mp4', { douyinDecryptKeyHex: videoSkey, signal });
  return {
    ...candidate,
    mediaUrl: cachedUrl
  };
}

export async function enrichRealtimeMedia(
  page: Page, mediaRegistry: MediaRegistry, logger: AppLogger,
  candidate: RealtimeMessageCandidate, signal: AbortSignal,
  resolveFileUrl?: (resource: DouyinFileResource) => Promise<string>
): Promise<RealtimeMessageCandidate> {
  if (candidate.messageType === 17) {
    const url = voiceUrl(candidate.content);
    if (!url) throw new Error('Voice message has no downloadable audio resource');
    const mediaUrl = await mediaRegistry.cacheRemote(url, 'audio/mpeg', undefined, { validateAudio: true, signal });
    return { ...candidate, mediaUrl };
  }
  if (candidate.messageType === 5) {
    const sticker = parseDouyinSticker(candidate.content, 5);
    if (!sticker?.url) throw new Error('Sticker message has no downloadable resource');
    const mediaUrl = await mediaRegistry.cacheRemote(sticker.url, 'image/webp', undefined, {
      normalizeImage: true, signal,
      validateImage: (bytes, format, validationSignal) => validateStickerImage(page, bytes, format, validationSignal)
    });
    return { ...candidate, mediaUrl };
  }
  if (candidate.messageType === 150) {
    if (!resolveFileUrl) throw new Error('File URL resolver is not available');
    return enrichRealtimeFile(mediaRegistry, candidate, signal, resolveFileUrl);
  }
  if (candidate.messageType !== 27) return enrichRealtimeVideoUrl(page, mediaRegistry, logger, candidate, signal);
  const content = parseJson(candidate.content);
  const url = candidate.mediaUrl ?? pickImageUrls(content, collectUrls(content ?? candidate.raw))[0];
  if (!url) throw new Error('Image message has no downloadable URL');
  const resource = isRecord(content) ? content.resource_url ?? content.image : undefined;
  const key = isRecord(resource) ? stringValue(resource.skey) : undefined;
  const mediaUrl = await mediaRegistry.cacheRemote(url, 'image/png', undefined, {
    normalizeImage: true, douyinImageKeyHex: key, signal
  });
  return { ...candidate, mediaUrl };
}

function mergeMessageContent(content: string | undefined, detail: string | undefined): string | undefined {
  try {
    const original = parse(content ?? '', undefined, parseNumberAndBigInt);
    const additional = parse(detail ?? '', undefined, parseNumberAndBigInt);
    if (!isRecord(original) || !isRecord(additional)) return content || detail;
    return stringify(mergeContentObjects(original, additional)) ?? content ?? detail;
  } catch { return content || detail; }
}

function mergeContentObjects(original: Record<string, unknown>, additional: Record<string, unknown>): Record<string, unknown> {
  const result = { ...original };
  for (const [key, value] of Object.entries(additional)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && !value.length && Array.isArray(result[key])) continue;
    const previous = result[key];
    result[key] = isRecord(previous) && isRecord(value) ? mergeContentObjects(previous, value) : value;
  }
  return result;
}

export function toDouyinMessage(candidate: RealtimeMessageCandidate, stickerAsText = false, allowQueriedMessage = false): DouyinMessage | undefined {
  if ([50001, 50002, 50005, 50011, 70001, 70002].includes(candidate.messageType ?? 0)) return undefined;
  if (!allowQueriedMessage && !candidate.source.includes('frontier-im.douyin.com')) {
    return undefined;
  }

  if (!candidate.serverMessageId) {
    return undefined;
  }

  const timestamp = Number(candidate.createTime);
  const parsedContent = parseJson(candidate.content);
  const share = parseDouyinShare(candidate.content, candidate.messageType);
  const text = candidate.messageType === 5 && stickerAsText ? stickerText(parseDouyinSticker(candidate.content, 5))
    : share ? shareDisplayText(share) : getDisplayText(candidate, parsedContent);

  return {
    messageId: candidate.serverMessageId,
    conversationId: candidate.conversationId ?? '',
    conversationShortId: candidate.conversationShortId,
    conversationType: candidate.conversationType === 2 ? 'group' : 'private',
    senderId: candidate.sender ?? 'unknown',
    messageType: candidate.messageType,
    clientMessageId: candidate.clientMessageId,
    content: candidate.content,
    text,
    segments: buildMessageSegments(candidate, parsedContent, text, stickerAsText),
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    raw: {
      source: candidate.source,
      payload: candidate.raw
    }
  };
}

function buildMessageSegments(
  candidate: RealtimeMessageCandidate,
  parsedContent: unknown,
  fallbackText: string,
  stickerAsText: boolean
): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];
  if (candidate.reference?.messageId) {
    segments.push(replySegment(candidate.reference.messageId));
  }

  if (candidate.messageType === 136) { segments.push({ type: 'forward', data: { id: candidate.serverMessageId } }); return segments; }
  if (candidate.messageType === 22) { segments.push({ type: 'music', data: { type: 'douyin', douyin_source_message_id: candidate.serverMessageId } }); return segments; }
  if (candidate.messageType === 502) { segments.push(locationSegment(candidate.content) ?? textSegment('[位置不可用]')); return segments; }
  if (candidate.messageType === 7) {
    segments.push(...buildTextSegments(parsedContent, fallbackText));
    return segments;
  }

  if (isVoiceMessageType(candidate.messageType)) {
    segments.push(voiceSegment(candidate.messageType!, candidate.mediaUnavailable ? undefined : candidate.mediaUrl));
    return segments;
  }

  if (candidate.messageType === 5) {
    segments.push(stickerAsText ? textSegment(fallbackText)
      : stickerSegment(parseDouyinSticker(candidate.content, 5), candidate.mediaUnavailable ? undefined : candidate.mediaUrl));
    return segments;
  }

  if (candidate.messageType === 150) {
    try {
      const file = parseDouyinFile(candidate.content);
      segments.push(candidate.mediaUrl && !candidate.mediaUnavailable
        ? { type: 'file', data: { file_id: candidate.serverMessageId, name: file.name, file_name: file.name,
          file: candidate.mediaUrl, url: candidate.mediaUrl, file_size: file.size, md5: file.md5 } }
        : textSegment(`[文件暂不可用: ${file.name}]`));
    } catch { segments.push(textSegment('[文件暂不可用: 元数据无效]')); }
    return segments;
  }

  if (candidate.messageType === 27 && candidate.mediaUnavailable) {
    segments.push(textSegment('[图片暂不可用]'));
    return segments;
  }

  const share = parseDouyinShare(candidate.content, candidate.messageType);
  if (share) {
    segments.push(shareMessageSegment(share));
    return segments;
  }

  const urls = [...(candidate.mediaUrl ? [candidate.mediaUrl] : []), ...collectUrls(parsedContent ?? candidate.raw)];
  const mediaKind = inferMediaKind(candidate.messageType, parsedContent, urls);
  if (mediaKind === 'image') {
    const imageUrls = candidate.mediaUrl ? [candidate.mediaUrl] : pickImageUrls(parsedContent, urls);
    segments.push(...(imageUrls.length ? imageUrls.map(url => imageSegment(url)) : [textSegment(fallbackText)]));
    return segments;
  }
  if (mediaKind === 'record') {
    const audioUrls = urls.filter(isAudioUrl);
    segments.push(...(audioUrls.length ? [recordSegment(audioUrls[0])] : [textSegment(fallbackText)]));
    return segments;
  }
  if (mediaKind === 'video') {
    const videoUrls = candidate.mediaUrl ? [candidate.mediaUrl] : urls.filter(isVideoUrl);
    segments.push(...(videoUrls.length ? [videoSegment(videoUrls[0])] : [textSegment(fallbackText)]));
    return segments;
  }

  segments.push(textSegment(fallbackText));
  return segments;
}

function pickImageUrls(parsedContent: unknown, urls: string[]): string[] {
  const preferredUrl =
    firstUrlAtPath(parsedContent, ['resource_url', 'origin_url_list']) ??
    firstUrlAtPath(parsedContent, ['resource_url', 'large_url_list']) ??
    firstUrlAtPath(parsedContent, ['resource_url', 'medium_url_list']) ??
    firstUrlAtPath(parsedContent, ['resource_url', 'thumb_url_list']) ??
    firstUrlAtPath(parsedContent, ['image', 'origin_url_list']) ??
    firstUrlAtPath(parsedContent, ['image', 'large_url_list']) ??
    firstUrlAtPath(parsedContent, ['image', 'medium_url_list']) ??
    firstUrlAtPath(parsedContent, ['image', 'thumb_url_list']);

  if (preferredUrl) {
    return [preferredUrl];
  }

  const imageUrls = urls.filter(isImageUrl);
  return imageUrls.length ? [imageUrls[0]] : urls.slice(0, 1);
}

function firstUrlAtPath(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  if (Array.isArray(current)) {
    return current.find((item): item is string => typeof item === 'string' && /^https?:\/\//i.test(item));
  }

  return typeof current === 'string' && /^https?:\/\//i.test(current) ? current : undefined;
}

function buildTextSegments(parsedContent: unknown, fallbackText: string): OneBotMessageSegment[] {
  if (!isRecord(parsedContent) || typeof parsedContent.text !== 'string' || !Array.isArray(parsedContent.richTextInfos)) {
    return [textSegment(fallbackText)];
  }

  const atInfos = parsedContent.richTextInfos
    .filter(isRecord)
    .filter(info => isRecord(info.info) && ((numberValue(info.infoType) === 1 && stringValue(info.info.uid)) ||
      (numberValue(info.infoType) === 4 && String(info.info.mention_label) === '1')))
    .map(info => ({
      location: numberValue(info.location) ?? 0,
      length: numberValue(info.length) ?? 0,
      uid: numberValue(info.infoType) === 4 ? 'all' : stringValue((info.info as Record<string, unknown>).uid) ?? ''
    }))
    .sort((left, right) => left.location - right.location);

  if (!atInfos.length) {
    return [textSegment(fallbackText)];
  }

  const segments: OneBotMessageSegment[] = [];
  let cursor = 0;
  for (const at of atInfos) {
    if (!Number.isSafeInteger(at.location) || !Number.isSafeInteger(at.length) || at.location < cursor || at.length < 1 ||
        at.location + at.length > parsedContent.text.length) continue;
    if (at.location > cursor) {
      segments.push(textSegment(parsedContent.text.slice(cursor, at.location)));
    }

    const name = parsedContent.text.slice(at.location, at.location + at.length).replace(/^@/, '').trim();
    segments.push(atSegment(at.uid, name || undefined));
    cursor = at.location + at.length;
  }

  if (cursor < parsedContent.text.length) {
    segments.push(textSegment(parsedContent.text.slice(cursor)));
  }

  return segments.length ? segments : [textSegment(fallbackText)];
}

function getDisplayText(candidate: RealtimeMessageCandidate, parsedContent: unknown): string {
  if (candidate.messageType === 5) {
    const name = parseDouyinSticker(candidate.content, 5)?.name;
    return `[表情${name ? `: ${name}` : ''}]`;
  }
  if (candidate.messageType === 7 && candidate.text) {
    return candidate.text;
  }

  if (candidate.messageType === 25) {
    return messageTypeFallbackText(candidate.messageType);
  }

  if (isRecord(parsedContent)) {
    const text =
      stringValue(parsedContent.text) ??
      stringValue(parsedContent.msgHint) ??
      stringValue(parsedContent.title) ??
      stringValue(parsedContent.desc) ??
      stringValue(parsedContent.description);
    if (text) {
      return text;
    }
  }

  return messageTypeFallbackText(candidate.messageType);
}

function inferMediaKind(messageType: number | undefined, parsedContent: unknown, urls: string[]): 'image' | 'record' | 'video' | 'unknown' {
  if (messageType === 25) {
    return 'unknown';
  }
  if (messageType === 27) {
    return 'image';
  }
  if (messageType === 30) {
    return 'video';
  }

  const keys = collectKeys(parsedContent).join(' ').toLowerCase();
  if (keys.includes('video') || urls.some(isVideoUrl)) {
    return 'video';
  }
  if (keys.includes('audio') || keys.includes('voice') || urls.some(isAudioUrl)) {
    return 'record';
  }
  if (keys.includes('image') || keys.includes('pic') || keys.includes('photo') || urls.some(isImageUrl)) {
    return 'image';
  }

  if (messageType !== undefined && urls.length > 0) {
    return 'image';
  }

  return 'unknown';
}

function messageTypeFallbackText(messageType: number | undefined): string {
  if (messageType === 136) return '[聊天记录]';
  if (messageType === 502) return '[位置]';
  if (messageType === 22) return '[音乐]';
  if (isVoiceMessageType(messageType)) return '[语音]';
  if (messageType === 25) {
    return '[分享]';
  }
  if (messageType === 27) {
    return '[图片]';
  }
  if (messageType === 30) {
    return '[视频]';
  }

  return `[douyin messageType=${messageType ?? 'unknown'}]`;
}

function collectUrls(value: unknown, out = new Set<string>()): string[] {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      out.add(value);
      return [...out];
    }

    const parsed = parseJson(value);
    if (parsed !== undefined && parsed !== value) {
      collectUrls(parsed, out);
    }
    return [...out];
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrls(item, out);
    }
    return [...out];
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectUrls(item, out);
    }
  }

  return [...out];
}

function collectKeys(value: unknown, out = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, out);
    }
    return [...out];
  }

  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }

  return [...out];
}

function parseJson(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isImageUrl(value: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|heic|image)(?:[?#].*)?$/i.test(value);
}

function isAudioUrl(value: string): boolean {
  return /\.(?:mp3|m4a|aac|wav|ogg|amr)(?:[?#].*)?$/i.test(value);
}

function isVideoUrl(value: string): boolean {
  return (
    /\.(?:mp4|mov|m4v|webm|avi)(?:[?#].*)?$/i.test(value) ||
    /mime_type=video_/i.test(value) ||
    (/(?:douyinvod\.com|\.v\.smtcdns\.com)\//i.test(value) && /(?:\/video\/|sc=video)/i.test(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}
