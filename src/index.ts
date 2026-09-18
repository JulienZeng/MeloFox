import type { Page } from 'playwright';
import { startBrowserRuntime } from './browser/chromium.js';
import { loadConfig } from './config/index.js';
import { DouyinBridge } from './douyin/bridge.js';
import { registerDouyinMessageListener } from './douyin/message-listener.js';
import {
  decodeNetworkResponseBodies,
  extractRealtimeMessageCandidatesFromDecoded,
  extractRealtimeMessageDetailsFromDecoded,
  type RealtimeMessageCandidate
} from './douyin/protobuf.js';
import type { DouyinMessage } from './douyin/types.js';
import { extractDouyinVideoKey, extractDouyinVideoSkey, resolveDouyinVideoUrl } from './douyin/video-url.js';
import { createLogger, type AppLogger } from './logger/index.js';
import { MediaRegistry } from './media/registry.js';
import { OneBotActionRouter } from './onebot/actions.js';
import { toOneBotMessageEvent, heartbeatEvent, lifecycleEvent } from './onebot/events.js';
import { atSegment, imageSegment, recordSegment, replySegment, textSegment, videoSegment } from './onebot/message-segment.js';
import type { OneBotMessageSegment } from './onebot/types.js';
import { startOneBotHttpServer, type HttpServerRuntime } from './onebot/http.js';
import { OneBotWebSocketHub } from './onebot/websocket.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info('starting douyin-onebot');

  const browser = await startBrowserRuntime(config, logger);
  const bridge = new DouyinBridge(browser.page, logger);
  await bridge.start();

  const mediaRegistry = new MediaRegistry(config, logger);
  const actionRouter = new OneBotActionRouter(config, bridge);
  const wsHub = new OneBotWebSocketHub(config, logger, actionRouter);
  await wsHub.start();

  let httpServer: HttpServerRuntime | undefined;
  if (config.onebot.http.enabled) {
    httpServer = await startOneBotHttpServer(config, logger, actionRouter, browser, mediaRegistry);
  }

  registerDouyinMessageListener(bridge, message => {
    wsHub.emit(toOneBotMessageEvent(config, message));
  });

  const mediaDetailWaitMs = 5_000;
  const seenRealtimeMessageIds = new Set<string>();
  const processingRealtimeMessageIds = new Set<string>();
  const pendingRealtimeMessages = new Map<
    string,
    {
      candidate: RealtimeMessageCandidate;
      firstSeenAt: number;
    }
  >();
  const realtimeMessageDetails = new Map<string, RealtimeMessageCandidate>();
  const realtimeVideoUrls = new Map<string, string>();
  const captureRealtimeMessages = async (): Promise<void> => {
    try {
      const decoded = await decodeNetworkResponseBodies(browser.listNetworkEvents());
      const candidates = extractRealtimeMessageCandidatesFromDecoded(decoded);
      const details = extractRealtimeMessageDetailsFromDecoded(decoded);
      for (const detail of details) {
        if (detail.serverMessageId) {
          realtimeMessageDetails.set(detail.serverMessageId, detail);
        }
      }

      for (const candidate of candidates) {
        if (
          !candidate.serverMessageId ||
          seenRealtimeMessageIds.has(candidate.serverMessageId) ||
          processingRealtimeMessageIds.has(candidate.serverMessageId)
        ) {
          continue;
        }

        const detail = realtimeMessageDetails.get(candidate.serverMessageId);
        if (shouldWaitForMediaDetail(candidate, detail)) {
          const pending = pendingRealtimeMessages.get(candidate.serverMessageId);
          if (!pending) {
            pendingRealtimeMessages.set(candidate.serverMessageId, {
              candidate,
              firstSeenAt: Date.now()
            });
            continue;
          }

          pending.candidate = candidate;
          if (Date.now() - pending.firstSeenAt < mediaDetailWaitMs) {
            continue;
          }
        }

        processingRealtimeMessageIds.add(candidate.serverMessageId);
        try {
          const enriched = await enrichRealtimeVideoUrl(
            browser.page,
            mediaRegistry,
            logger,
            mergeRealtimeMessageDetail(candidate, detail),
            realtimeVideoUrls
          );
          const message = toDouyinMessage(enriched);
          if (!message) {
            continue;
          }
          seenRealtimeMessageIds.add(message.messageId);
          pendingRealtimeMessages.delete(message.messageId);
          await bridge.ingestMessage(message);
        } finally {
          processingRealtimeMessageIds.delete(candidate.serverMessageId);
        }
      }

      for (const [messageId, pending] of pendingRealtimeMessages) {
        if (seenRealtimeMessageIds.has(messageId)) {
          pendingRealtimeMessages.delete(messageId);
          continue;
        }
        if (processingRealtimeMessageIds.has(messageId)) {
          continue;
        }

        const detail = realtimeMessageDetails.get(messageId);
        if (!detail && Date.now() - pending.firstSeenAt < mediaDetailWaitMs) {
          continue;
        }

        processingRealtimeMessageIds.add(messageId);
        try {
          const enriched = await enrichRealtimeVideoUrl(
            browser.page,
            mediaRegistry,
            logger,
            mergeRealtimeMessageDetail(pending.candidate, detail),
            realtimeVideoUrls
          );
          const message = toDouyinMessage(enriched);
          if (!message) {
            continue;
          }

          seenRealtimeMessageIds.add(message.messageId);
          pendingRealtimeMessages.delete(messageId);
          await bridge.ingestMessage(message);
        } finally {
          processingRealtimeMessageIds.delete(messageId);
        }
      }
    } catch (error) {
      logger.debug({ error }, 'failed to capture realtime douyin messages');
    }
  };
  const realtimeCaptureTimer = setInterval(() => {
    void captureRealtimeMessages();
  }, 1_000);

  wsHub.emit(lifecycleEvent(config, 'connect'));
  const heartbeatTimer = setInterval(() => {
    wsHub.emit(heartbeatEvent(config, { online: true, good: true }));
  }, config.runtime.heartbeatIntervalMs);

  const stop = async () => {
    logger.info('stopping douyin-onebot');
    clearInterval(realtimeCaptureTimer);
    clearInterval(heartbeatTimer);
    mediaRegistry.stop();
    await httpServer?.stop();
    await wsHub.stop();
    await browser.stop();
  };

  process.once('SIGINT', () => {
    void stop().finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    void stop().finally(() => process.exit(0));
  });
}

main().catch(error => {
  // Logger might not exist yet if config parsing failed.
  console.error(error);
  process.exit(1);
});

function shouldWaitForMediaDetail(candidate: RealtimeMessageCandidate, detail: RealtimeMessageCandidate | undefined): boolean {
  if (detail) {
    return false;
  }

  if (candidate.messageType !== 27 && candidate.messageType !== 30) {
    return false;
  }

  const parsedContent = parseJson(candidate.content);
  return collectUrls(parsedContent ?? candidate.raw).length === 0;
}

function mergeRealtimeMessageDetail(
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
    content: candidate.content || detail.content,
    text: candidate.text || detail.text,
    raw: {
      realtime: candidate.raw,
      detail: detail.raw
    }
  };
}

async function enrichRealtimeVideoUrl(
  page: Page,
  mediaRegistry: MediaRegistry,
  logger: AppLogger,
  candidate: RealtimeMessageCandidate,
  videoUrls: Map<string, string>
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
    logger.warn({ messageId: candidate.serverMessageId }, 'douyin video message has no tkey or vid');
    return candidate;
  }

  const cached = videoUrls.get(videoKey);
  if (cached) {
    return {
      ...candidate,
      mediaUrl: cached
    };
  }

  const videoSkey = extractDouyinVideoSkey(parsedContent);
  logger.info(
    { messageId: candidate.serverMessageId, videoKey, hasSkey: Boolean(videoSkey) },
    'resolving douyin video media'
  );

  const resolved = await resolveDouyinVideoUrl(page, videoKey).catch(error => {
    logger.warn({ messageId: candidate.serverMessageId, videoKey, error }, 'failed to resolve douyin video url');
    return undefined;
  });
  if (!resolved) {
    logger.warn({ messageId: candidate.serverMessageId, videoKey }, 'douyin video resolver returned no playable url');
    return candidate;
  }

  const cachedUrl = await mediaRegistry
    .cacheRemote(resolved, 'video/mp4', '.mp4', videoSkey ? { douyinDecryptKeyHex: videoSkey } : undefined)
    .catch(error => {
      logger.warn({ messageId: candidate.serverMessageId, videoKey, error }, 'failed to cache douyin video media');
      return undefined;
    });
  if (!cachedUrl) {
    return candidate;
  }

  videoUrls.set(videoKey, cachedUrl);
  return {
    ...candidate,
    mediaUrl: cachedUrl
  };
}

function toDouyinMessage(candidate: RealtimeMessageCandidate): DouyinMessage | undefined {
  if (!candidate.source.includes('frontier-im.douyin.com')) {
    return undefined;
  }

  if (!candidate.serverMessageId) {
    return undefined;
  }

  const timestamp = Number(candidate.createTime);
  const parsedContent = parseJson(candidate.content);
  const text = getDisplayText(candidate, parsedContent);

  return {
    messageId: candidate.serverMessageId,
    conversationId: candidate.conversationId ?? '',
    conversationShortId: candidate.conversationShortId,
    conversationType: candidate.conversationType === 2 ? 'group' : 'private',
    senderId: candidate.sender ?? 'unknown',
    messageType: candidate.messageType,
    content: candidate.content,
    text,
    segments: buildMessageSegments(candidate, parsedContent, text),
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
  fallbackText: string
): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];
  if (candidate.reference?.messageId) {
    segments.push(replySegment(candidate.reference.messageId));
  }

  if (candidate.messageType === 7) {
    segments.push(...buildTextSegments(parsedContent, fallbackText));
    return segments;
  }

  const urls = [...(candidate.mediaUrl ? [candidate.mediaUrl] : []), ...collectUrls(parsedContent ?? candidate.raw)];
  const mediaKind = inferMediaKind(candidate.messageType, parsedContent, urls);
  if (mediaKind === 'image') {
    const imageUrls = pickImageUrls(parsedContent, urls);
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
    .filter(info => numberValue(info.infoType) === 1 && isRecord(info.info) && stringValue(info.info.uid))
    .map(info => ({
      location: numberValue(info.location) ?? 0,
      length: numberValue(info.length) ?? 0,
      uid: stringValue((info.info as Record<string, unknown>).uid) ?? ''
    }))
    .sort((left, right) => left.location - right.location);

  if (!atInfos.length) {
    return [textSegment(fallbackText)];
  }

  const segments: OneBotMessageSegment[] = [];
  let cursor = 0;
  for (const at of atInfos) {
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
  return typeof value === 'object' && value !== null;
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
