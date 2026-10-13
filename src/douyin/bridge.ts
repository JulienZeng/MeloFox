import { createHash, randomUUID } from 'node:crypto';
import { signVodRequest, crc32Hex, type UploadCredentials } from './upload-signing.js';
import { loadOutgoingFile, uploadOutgoingFile } from './file-upload.js';
import { prepareOutgoingVideo, uploadOutgoingVideo } from './video-upload.js';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Page } from 'playwright';
import type { AppLogger } from '../logger/index.js';
import { RetainedCache } from '../runtime/retained-cache.js';
import { ActionDeadline } from '../runtime/deadline.js';
import { DouyinDirectory, decodeDirectoryResponse, encodeDirectoryPayload } from './directory.js';
import { postImApi } from './im-client.js';
import { enrichRealtimeFile } from './file.js';
import { fetchSmallEmojiCatalog } from './emoji.js';
import { decodeReactionQuery, encodeReactionQuery, type ReactionState } from './reaction.js';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveDouyinFileUrl, type DouyinFileResource } from './file-url.js';
import { enrichRealtimeMedia, toDouyinMessage } from './message-adapter.js';
import type { MediaRegistry } from '../media/registry.js';
import {
  buildEmojiReactionRequest,
  buildImApiRequest,
  buildImageSendRequest,
  buildFileSendRequest,
  buildVideoSendRequest,
  buildRecallRequest,
  buildTextSendRequest,
  decodeSendResponse,
  type DouyinReplyReference,
  type DouyinSendProtocolContext,
  type DouyinUploadedImage
} from './send-protocol.js';
import type {
  DouyinConversation,
  DouyinGroupMember,
  DouyinMessage,
  DouyinRecall,
  DouyinSendTarget,
  DouyinSendMessageInput,
  DouyinSendMessageResult,
  DouyinUser
} from './types.js';

export type DouyinMessageHandler = (message: DouyinMessage) => void | Promise<void>;

export interface DouyinBridgeCache {
  messages: RetainedCache<DouyinMessage>;
  sentClientMessageIds: RetainedCache<string>;
  sentTargets: RetainedCache<{ target: DouyinSendTarget; senderId: string }>;
  recalls: RetainedCache<{ notice: DouyinRecall; emitted: boolean }>;
  accountId?: string;
  restored?: boolean;
  persist?: () => Promise<void>;
}

export function createDouyinBridgeCache(limit = 10000, ttlMs = 7 * 86400000): DouyinBridgeCache {
  return {
    messages: new RetainedCache(limit, ttlMs, message => message.timestamp), sentClientMessageIds: new RetainedCache(limit, ttlMs),
    sentTargets: new RetainedCache(limit, ttlMs), recalls: new RetainedCache(limit, ttlMs, state => state.notice.timestamp)
  };
}

export interface DouyinBridgeOptions {
  enableDomMessageCapture?: boolean;
  actionTimeoutMs?: number;
  maxFileBytes?: number;
  fileSendAllowedDirs?: string[];
  videoSendTimeoutMs?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  isImConnected?: () => boolean;
  isRealtimeHealthy?: () => boolean;
  isSessionHealthy?: () => boolean;
  messageCacheLimit?: number;
  messageCacheTtlMs?: number;
  cache?: DouyinBridgeCache;
}

export class DouyinBridge {
  private messageHandlers = new Set<DouyinMessageHandler>();
  private readonly recallHandlers = new Set<(notice: DouyinRecall) => void | Promise<void>>();
  private readonly recalling = new Map<string, Promise<void>>();
  private readonly ingestingRecalls = new Map<string, Promise<void>>();
  private readonly receivingFiles = new Map<string, Promise<DouyinMessage>>();
  private readonly receivingStickers = new Map<string, Promise<DouyinMessage>>();
  private readonly receivingVideos = new Map<string, Promise<DouyinMessage>>();
  private emojiCatalog?: { accountId: string; tokens: string[]; expiresAt: number };
  private loadingEmojiCatalog?: { accountId: string; promise: Promise<string[]> };
  private readonly messageCache: RetainedCache<DouyinMessage>;
  private readonly sentClientMessageIds: RetainedCache<string>;
  private currentUserId: string | undefined;
  private readonly directory: DouyinDirectory;
  private readonly cache: DouyinBridgeCache;

  constructor(
    private readonly page: Page,
    private readonly logger: AppLogger,
    private readonly options: DouyinBridgeOptions = {}
  ) {
    this.cache = options.cache ?? createDouyinBridgeCache(options.messageCacheLimit, options.messageCacheTtlMs);
    this.messageCache = this.cache.messages;
    this.sentClientMessageIds = this.cache.sentClientMessageIds;
    this.directory = new DouyinDirectory(page, async (command, type, params, path, inboxType, actionDeadline) => {
      const deadline = actionDeadline ?? new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
      return deadline.run(async () => {
        const context = await this.readSendProtocolContext();
        const payload = await encodeDirectoryPayload(type, params);
        const response = await postImApi(this.page, path, buildImApiRequest(command, payload, context, inboxType), deadline.remainingMs());
        return decodeDirectoryResponse(response);
      });
    }, logger, options.actionTimeoutMs);
  }

  async start(): Promise<void> {
    await this.directory.refresh().catch(error => {
      this.logger.warn({ error }, 'douyin account and conversation initialization failed');
    });
    this.synchronizeCacheAccount();
    if (!this.options.enableDomMessageCapture) {
      this.logger.info('douyin bridge started with realtime network capture');
      return;
    }

    await this.page.exposeBinding('__douyinOneBotEmitMessage', async (_source, message: DouyinMessage) => {
      await this.handleMessage(message);
    });

    await this.page.evaluate(() => {
      window.addEventListener('__DOUYIN_ONEBOT_MESSAGE__', event => {
        const customEvent = event as CustomEvent;
        const emitter = (window as unknown as { __douyinOneBotEmitMessage?: (message: unknown) => Promise<void> }).__douyinOneBotEmitMessage;
        void emitter?.(customEvent.detail);
      });
    });

    this.logger.info('douyin bridge started with DOM message capture fallback');
  }

  onMessage(handler: DouyinMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  getCachedMessage(messageId: string): DouyinMessage | undefined {
    this.synchronizeCacheAccount();
    if (this.cache.restored) return undefined;
    if (this.cache.recalls.get(messageId)) return undefined;
    const message = this.messageCache.get(messageId);
    if (message && [50001, 50002, 70001, 70002].includes(message.messageType ?? 0)) return undefined;
    const callbackStatus = message ? messageCallbackStatus(message) : undefined;
    return callbackStatus !== undefined && callbackStatus !== 0 ? undefined : message;
  }

  resolveFileUrl(resource: DouyinFileResource): Promise<string> {
    return resolveDouyinFileUrl(this.page, resource);
  }

  receiveCachedFile(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const existing = this.receivingFiles.get(messageId);
    if (existing) return existing;
    const promise = this.downloadCachedFile(messageId, registry).finally(() => this.receivingFiles.delete(messageId));
    this.receivingFiles.set(messageId, promise);
    return promise;
  }

  private async downloadCachedFile(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const cached = this.getCachedMessage(messageId);
    if (!cached || cached.messageType !== 150) throw new Error('File message not found in cache');
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    const candidate = await deadline.run(() => enrichRealtimeFile(registry, {
      source: 'wss://frontier-im.douyin.com/ws/v2', serverMessageId: messageId,
      conversationId: cached.conversationId, conversationShortId: cached.conversationShortId,
      conversationType: cached.conversationType === 'group' ? 2 : 1, sender: cached.senderId,
      messageType: 150, content: cached.content, createTime: String(cached.timestamp), raw: cached.raw
    }, deadline.signal, resource => this.resolveFileUrl(resource)));
    deadline.signal.throwIfAborted();
    if (this.getCachedMessage(messageId) !== cached) throw new Error('File message expired, recalled or changed during download');
    const replies = cached.segments?.filter(segment => segment.type === 'reply') ?? [];
    const message = { ...cached, segments: [...replies, ...toDouyinMessage(candidate)!.segments!] };
    this.messageCache.set(messageId, message);
    await this.cache.persist?.();
    return message;
  }

  receiveCachedSticker(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const existing = this.receivingStickers.get(messageId);
    if (existing) return existing;
    const promise = this.downloadCachedSticker(messageId, registry).finally(() => this.receivingStickers.delete(messageId));
    this.receivingStickers.set(messageId, promise);
    return promise;
  }

  private async downloadCachedSticker(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const cached = this.getCachedMessage(messageId);
    if (!cached || cached.messageType !== 5) throw new Error('Sticker message not found in cache');
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    const candidate = await deadline.run(() => enrichRealtimeMedia(this.page, registry, this.logger, {
      source: 'wss://frontier-im.douyin.com/ws/v2', serverMessageId: messageId,
      conversationId: cached.conversationId, conversationShortId: cached.conversationShortId,
      conversationType: cached.conversationType === 'group' ? 2 : 1, sender: cached.senderId,
      messageType: 5, content: cached.content, createTime: String(cached.timestamp), raw: cached.raw
    }, deadline.signal));
    deadline.signal.throwIfAborted();
    if (this.getCachedMessage(messageId) !== cached) throw new Error('Sticker message expired, recalled or changed during download');
    const replies = cached.segments?.filter(segment => segment.type === 'reply') ?? [];
    const message = { ...cached, segments: [...replies, ...toDouyinMessage(candidate)!.segments!] };
    this.messageCache.set(messageId, message);
    await this.cache.persist?.();
    return message;
  }

  receiveCachedVideo(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const existing = this.receivingVideos.get(messageId);
    if (existing) return existing;
    const promise = this.downloadCachedVideo(messageId, registry).finally(() => this.receivingVideos.delete(messageId));
    this.receivingVideos.set(messageId, promise);
    return promise;
  }

  private async downloadCachedVideo(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const cached = this.getCachedMessage(messageId);
    if (!cached || cached.messageType !== 30) throw new Error('Video message not found in cache');
    const accountId = this.accountId;
    const deadline = new ActionDeadline(this.options.videoSendTimeoutMs ?? 120000);
    const candidate = await deadline.run(() => enrichRealtimeMedia(this.page, registry, this.logger, {
      source: 'wss://frontier-im.douyin.com/ws/v2', serverMessageId: messageId,
      conversationId: cached.conversationId, conversationShortId: cached.conversationShortId,
      conversationType: cached.conversationType === 'group' ? 2 : 1, sender: cached.senderId,
      messageType: 30, content: cached.content, createTime: String(cached.timestamp), raw: cached.raw
    }, deadline.signal));
    deadline.remainingMs();
    if (this.accountId !== accountId || this.getCachedMessage(messageId) !== cached) throw new Error('Video message expired, recalled or changed during download');
    if (!candidate.mediaUrl) throw new Error('Video resource is unavailable');
    const replies = cached.segments?.filter(segment => segment.type === 'reply') ?? [];
    const message = { ...cached, segments: [...replies, { type: 'video', data: { file: candidate.mediaUrl } }] };
    this.messageCache.set(messageId, message);
    await this.cache.persist?.();
    return message;
  }

  getCacheStats(): { messages: number; sendReceipts: number; recalls: number;
    retainedMessages: number; retainedSendReceipts: number; retainedRecalls: number; awaitingAccountVerification: boolean } {
    this.synchronizeCacheAccount();
    return { messages: this.cache.messages.size, sendReceipts: this.cache.sentTargets.size,
      recalls: this.cache.recalls.size, retainedMessages: this.cache.messages.retainedSize,
      retainedSendReceipts: this.cache.sentTargets.retainedSize, retainedRecalls: this.cache.recalls.retainedSize,
      awaitingAccountVerification: Boolean(this.cache.restored) };
  }

  onRecall(handler: (notice: DouyinRecall) => void | Promise<void>): void {
    this.recallHandlers.add(handler);
  }

  ingestRecall(notice: DouyinRecall): Promise<void> {
    const existing = this.ingestingRecalls.get(notice.messageId);
    if (existing) return existing;
    const promise = this.handleRecall(notice).finally(() => this.ingestingRecalls.delete(notice.messageId));
    this.ingestingRecalls.set(notice.messageId, promise);
    return promise;
  }

  private async handleRecall(notice: DouyinRecall): Promise<void> {
    this.synchronizeCacheAccount();
    const previous = this.cache.recalls.get(notice.messageId);
    if (previous?.emitted) return;
    const original = this.messageCache.get(notice.messageId);
    const sent = this.cache.sentTargets.get(notice.messageId);
    const ids = notice.conversationId.split(':');
    const peerUserId = notice.conversationType === 'private' && this.accountId && ids.length === 4 && ids[0] === '0' && ids[1] === '1' && ids.slice(2).includes(this.accountId)
      ? ids.slice(2).find(id => id !== this.accountId) : undefined;
    notice = { ...notice, senderId: original?.senderId ?? sent?.senderId ?? notice.senderId,
      peerUserId: peerUserId ?? sent?.target.userId ?? notice.peerUserId };
    const state = { notice, emitted: false };
    this.cache.recalls.set(notice.messageId, state);
    this.messageCache.delete(notice.messageId);
    this.cache.sentTargets.delete(notice.messageId);
    await this.cache.persist?.();
    if (!notice.senderId || (notice.conversationType === 'private' && !notice.peerUserId)) {
      this.logger.warn({ messageId: notice.messageId }, 'recall author or peer is unknown; suppressing incomplete notice');
      return;
    }
    for (const handler of this.recallHandlers) await handler(notice);
    state.emitted = true;
    this.cache.recalls.set(notice.messageId, state);
    await this.cache.persist?.();
    this.logger.info({ messageId: notice.messageId, operatorId: notice.operatorId, conversationType: notice.conversationType }, 'received douyin recall');
  }

  recallMessage(messageId: string): Promise<void> {
    const existing = this.recalling.get(messageId);
    if (existing) return existing;
    const promise = this.recallOwnMessage(messageId).finally(() => this.recalling.delete(messageId));
    this.recalling.set(messageId, promise);
    return promise;
  }

  private async recallOwnMessage(messageId: string): Promise<void> {
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    await deadline.run(async () => {
      this.synchronizeCacheAccount();
      const original = this.messageCache.get(messageId);
      const sent = this.cache.sentTargets.get(messageId);
      const recalled = this.cache.recalls.get(messageId);
      const senderId = original?.senderId ?? sent?.senderId ?? recalled?.notice.senderId;
      if (!this.accountId) throw new Error('Douyin account is not authenticated');
      if (!senderId) throw new Error(`Cannot recall message outside the realtime/send cache: ${messageId}`);
      if (senderId !== this.accountId) throw new Error('Recalling another user\'s message is not supported');
      if (recalled) { await this.cache.persist?.(); return; }
      const target: DouyinSendTarget | undefined = original ? {
        type: original.conversationType, conversationId: original.conversationId, conversationShortId: original.conversationShortId
      } : sent?.target;
      if (!target?.conversationId || !target.conversationShortId) throw new Error('Recall message lacks a complete conversation');
      const context = await this.readSendProtocolContext();
      const request = buildRecallRequest({ conversationId: target.conversationId, conversationShortId: target.conversationShortId,
        conversationType: target.type === 'group' ? 2 : 1, messageId, context });
      const response = await postImApi(this.page, 'v1/message/recall', request, deadline.remainingMs());
      const decoded = await decodeDirectoryResponse(response);
      deadline.remainingMs();
      if (decoded.cmd !== 702 || decoded.statusCode !== 0) throw new Error(`Douyin message/recall failed: ${decoded.statusCode} ${decoded.errorDesc ?? ''}`);
      // Mark acknowledged recalls, but emit notices only from a real WS push. A push may arrive before this receipt.
      if (!this.cache.recalls.get(messageId)) this.cache.recalls.set(messageId, { emitted: false, notice: {
        messageId, senderId, operatorId: senderId, conversationId: target.conversationId,
        conversationShortId: target.conversationShortId, conversationType: target.type, peerUserId: target.userId,
        timestamp: Date.now(), raw: { source: 'imapi', response: decoded }
      } });
      this.messageCache.delete(messageId);
      this.cache.sentTargets.delete(messageId);
      await this.cache.persist?.();
      this.logger.info({ messageId, conversationId: target.conversationId }, 'recalled own douyin message through imapi');
    });
  }

  async ingestMessage(message: DouyinMessage): Promise<void> {
    await this.handleMessage(message);
  }

  getEmojiList(noCache = false, deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000)): Promise<string[]> {
    const accountId = this.accountId;
    if (!accountId) return Promise.reject(new Error('Douyin account is not authenticated'));
    if (!noCache && this.emojiCatalog?.accountId === accountId && this.emojiCatalog.expiresAt > Date.now()) {
      return Promise.resolve([...this.emojiCatalog.tokens]);
    }
    if (this.loadingEmojiCatalog?.accountId === accountId) return deadline.run(() => this.loadingEmojiCatalog!.promise);
    const promise = deadline.run(async () => {
      const tokens = await fetchSmallEmojiCatalog(this.page, deadline.remainingMs());
      deadline.signal.throwIfAborted();
      if (this.accountId !== accountId) throw new Error('Douyin account changed while loading emoji catalog');
      this.emojiCatalog = { accountId, tokens: [...tokens], expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
      return tokens;
    }).finally(() => { if (this.loadingEmojiCatalog?.promise === promise) this.loadingEmojiCatalog = undefined; });
    this.loadingEmojiCatalog = { accountId, promise };
    return promise;
  }

  async sendMessage(input: DouyinSendMessageInput): Promise<DouyinSendMessageResult> {
    const deadline = new ActionDeadline(input.video ? this.options.videoSendTimeoutMs ?? 120000 : this.options.actionTimeoutMs ?? 15000);
    return deadline.run(async () => {
      if (input.emojiTokens?.length) {
        const catalog = new Set(await this.getEmojiList(false, deadline));
        for (const token of input.emojiTokens) {
          if (!catalog.has(token)) throw new Error(`Unsupported or hidden Douyin emoji: ${token}`);
        }
      }
      if (input.video && (input.text || input.file || input.images?.length || input.mentions?.length || input.replyToMessageId || input.emojiReaction)) {
        throw new Error('Video must be sent without text, image, at, reply, file, or emoji');
      }
      if (input.file && (input.text || input.video || input.images?.length || input.mentions?.length || input.replyToMessageId || input.emojiReaction)) {
        throw new Error('File must be sent without text, image, at, reply, or emoji');
      }
      input = { ...input, target: await this.directory.resolveTarget(input.target) };
      this.synchronizeCacheAccount();
      deadline.remainingMs();
      if (input.video) return this.sendVideoViaImApi(input, deadline);
      if (input.file) return this.sendFileViaImApi(input, deadline);
      if (input.emojiReaction) {
        return this.sendReactionViaImApi(input, deadline);
      }

      if (input.images?.length) {
        return this.sendImagesViaImApi(input, deadline);
      }

      return this.sendViaImApi(input, deadline);
    });
  }

  private async sendImagesViaImApi(input: DouyinSendMessageInput, deadline: ActionDeadline): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId) {
      throw new Error('Direct Douyin image send requires a numeric conversation id from realtime messages or group list');
    }
    if (!input.images?.length) {
      throw new Error('Direct Douyin image send requires at least one image');
    }
    if (input.text || input.mentions?.length || input.replyToMessageId) {
      throw new Error('Direct Douyin image send currently supports image-only messages');
    }

    const context = await this.readSendProtocolContext();
    let lastResult: DouyinSendMessageResult | undefined;
    for (const image of input.images) {
      deadline.remainingMs();
      const imageData = await loadImageData(image, deadline.signal);
      const uploaded = await this.uploadImageViaVod(imageData, deadline);
      const request = buildImageSendRequest({
        conversationShortId,
        conversationId: input.target.conversationId,
        inboxType: input.target.inboxType,
        conversationType: input.target.type === 'group' ? 2 : 1,
        image: uploaded,
        context
      });

      const decoded = await this.postImProtobuf('message/send', request.body, deadline);
      if (!decoded.ok) {
        throw new Error(`Douyin image message/send failed: ${decoded.failureReason ?? decoded.status ?? decoded.statusCode ?? 'unknown'}`);
      }

      const messageId = decoded.serverMessageId ?? decoded.clientMessageId ?? request.clientMessageId;
      this.sentClientMessageIds.set(messageId, request.clientMessageId);
      this.rememberSentTarget(messageId, input.target);
      this.logger.info(
        {
          conversationShortId,
          messageId,
          clientMessageId: request.clientMessageId,
          imageSize: uploaded.size,
          imageWidth: uploaded.width,
          imageHeight: uploaded.height
        },
        'sent douyin image message through imapi'
      );

      lastResult = {
        messageId,
        raw: {
          source: 'imapi',
          response: decoded,
          image: uploaded
        }
      };
    }

    if (!lastResult) {
      throw new Error('No image was sent');
    }
    return lastResult;
  }

  private async sendVideoViaImApi(input: DouyinSendMessageInput, deadline: ActionDeadline): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId || !input.video) throw new Error('Video send requires an existing conversation and one video');
    const accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    const video = await prepareOutgoingVideo(input.video, { maxBytes: this.options.maxFileBytes ?? 128 * 1024 * 1024,
      allowedDirs: this.options.fileSendAllowedDirs ?? [], ffmpegPath: this.options.ffmpegPath ?? 'ffmpeg',
      ffprobePath: this.options.ffprobePath ?? 'ffprobe' }, deadline);
    const config = await this.readImageUploadConfig(deadline.remainingMs());
    const uploaded = await uploadOutgoingVideo(video, config, deadline);
    if (this.accountId !== accountId) throw new Error('Douyin account changed during video upload; message was not sent');
    const context = await this.readSendProtocolContext();
    deadline.remainingMs();
    if (this.accountId !== accountId) throw new Error('Douyin account changed before video send; message was not sent');
    const request = buildVideoSendRequest({ conversationShortId, conversationId: input.target.conversationId,
      conversationType: input.target.type === 'group' ? 2 : 1, inboxType: input.target.inboxType, video: uploaded, context });
    const decoded = await this.postImProtobuf('message/send', request.body, deadline);
    if (!decoded.ok || !decoded.serverMessageId || !/^[1-9]\d*$/.test(decoded.serverMessageId)) {
      throw new Error(`Douyin video message/send failed: ${decoded.failureReason ?? 'no valid server message receipt; do not retry automatically'}`);
    }
    if (this.accountId !== accountId) throw new Error('Douyin account changed after video send; delivery may have succeeded, do not retry automatically');
    const messageId = decoded.serverMessageId;
    this.sentClientMessageIds.set(messageId, request.clientMessageId);
    this.rememberSentTarget(messageId, input.target);
    if (!this.messageCache.get(messageId) && !this.cache.recalls.get(messageId)) {
      this.messageCache.set(messageId, { messageId, clientMessageId: request.clientMessageId, messageType: 30,
        conversationId: input.target.conversationId ?? conversationShortId, conversationShortId, conversationType: input.target.type,
        senderId: accountId, timestamp: Date.now(), content: request.content, text: '[视频]',
        raw: { source: 'imapi', payload: { content: request.content, messageType: 30 } } });
    }
    await this.cache.persist?.().catch(error => this.logger.warn({ messageId, error: error instanceof Error ? error.message : String(error) }, 'video delivered but send cache persistence failed'));
    this.logger.info({ messageId, conversationShortId, videoSize: video.bytes.length, width: uploaded.width, height: uploaded.height }, 'sent douyin video through imapi');
    return { messageId, raw: { source: 'imapi', response: decoded } };
  }

  private async sendFileViaImApi(input: DouyinSendMessageInput, deadline: ActionDeadline): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId || !input.file) throw new Error('File send requires an existing conversation and one file');
    const accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    const file = await loadOutgoingFile(input.file, this.options.maxFileBytes ?? 128 * 1024 * 1024, deadline.signal, this.options.fileSendAllowedDirs);
    const context = await this.readSendProtocolContext();
    const config = await this.readImageUploadConfig(deadline.remainingMs());
    const uploaded = await uploadOutgoingFile(file, config, deadline);
    if (this.accountId !== accountId) throw new Error('Douyin account changed during file upload; message was not sent');
    const request = buildFileSendRequest({ conversationShortId, conversationId: input.target.conversationId,
      conversationType: input.target.type === 'group' ? 2 : 1, inboxType: input.target.inboxType, file: uploaded, context });
    const decoded = await this.postImProtobuf('message/send', request.body, deadline);
    if (!decoded.ok || !decoded.serverMessageId || !/^[1-9]\d*$/.test(decoded.serverMessageId)) {
      throw new Error(`Douyin file message/send failed: ${decoded.failureReason ?? 'no valid server message receipt; do not retry automatically'}`);
    }
    if (this.accountId !== accountId) throw new Error('Douyin account changed after file send; delivery may have succeeded, do not retry automatically');
    const messageId = decoded.serverMessageId;
    this.sentClientMessageIds.set(messageId, request.clientMessageId);
    this.rememberSentTarget(messageId, input.target);
    if (!this.messageCache.get(messageId) && !this.cache.recalls.get(messageId)) {
      this.messageCache.set(messageId, { messageId, clientMessageId: request.clientMessageId, messageType: 150,
        conversationId: input.target.conversationId ?? conversationShortId, conversationShortId, conversationType: input.target.type,
        senderId: accountId, timestamp: Date.now(), content: request.content, text: `[文件: ${uploaded.name}]`,
        raw: { source: 'imapi', payload: { content: request.content, messageType: 150 } } });
    }
    await this.cache.persist?.().catch(error => this.logger.warn({ messageId, error: error instanceof Error ? error.message : String(error) }, 'file delivered but send cache persistence failed'));
    this.logger.info({ messageId, conversationShortId, fileName: uploaded.name, fileSize: uploaded.size }, 'sent douyin file message through imapi');
    return { messageId, raw: { source: 'imapi', response: decoded } };
  }

  private async sendViaImApi(input: DouyinSendMessageInput, deadline: ActionDeadline): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId) {
      throw new Error('Direct Douyin send requires a numeric conversation id from realtime messages or group list');
    }

    if (!input.text) {
      throw new Error('Direct Douyin send requires text content');
    }

    const context = await this.readSendProtocolContext();
    const request = buildTextSendRequest({
      conversationShortId,
      conversationId: input.target.conversationId,
      inboxType: input.target.inboxType,
      conversationType: input.target.type === 'group' ? 2 : 1,
      text: input.text,
      mentions: input.mentions,
      replyReference: this.buildReplyReference(input.replyToMessageId),
      context
    });

    const decoded = await this.postImProtobuf('message/send', request.body, deadline);
    if (!decoded.ok) {
      throw new Error(`Douyin message/send failed: ${decoded.failureReason ?? decoded.status ?? decoded.statusCode ?? 'unknown'}`);
    }

    const messageId = decoded.serverMessageId ?? decoded.clientMessageId ?? request.clientMessageId;
    this.sentClientMessageIds.set(messageId, request.clientMessageId);
    this.rememberSentTarget(messageId, input.target);
    this.logger.info(
      {
        conversationShortId,
        messageId,
        clientMessageId: request.clientMessageId,
        mentions: input.mentions?.length ?? 0
      },
      'sent douyin message through imapi'
    );

    return {
      messageId,
      raw: {
        source: 'imapi',
        response: decoded
      }
    };
  }

  private async postImProtobuf(endpoint: 'message/send' | 'message/set_property', body: Buffer, deadline: ActionDeadline) {
    const response = await postImApi(this.page, `v1/${endpoint}`, body, deadline.remainingMs());
    const decoded = decodeSendResponse(response);
    const expectedCommand = endpoint === 'message/send' ? 100 : 705;
    if (decoded.cmd !== expectedCommand) return { ...decoded, ok: false, failureReason: `Unexpected response command: ${decoded.cmd}` };
    return decoded;
  }

  private async sendReactionViaImApi(input: DouyinSendMessageInput, deadline: ActionDeadline): Promise<DouyinSendMessageResult> {
    if (!input.replyToMessageId) {
      throw new Error('Direct Douyin emoji reaction requires a reply segment with target message id');
    }
    if (!input.emojiReaction) {
      throw new Error('Direct Douyin emoji reaction requires emoji data');
    }
    if (input.text || input.images?.length || input.mentions?.length) {
      throw new Error('Direct Douyin emoji reaction cannot be mixed with text, image, or at segments');
    }

    const target = this.buildReactionTarget(input.replyToMessageId, input.target);
    const accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    const context = await this.readSendProtocolContext();
    const request = buildEmojiReactionRequest({
      conversationId: input.target.conversationId,
      inboxType: input.target.inboxType,
      conversationShortId: target.conversationShortId,
      conversationType: target.conversationType,
      targetMessageId: input.replyToMessageId,
      targetClientMessageId: target.clientMessageId,
      operatorUserId: accountId,
      emoji: input.emojiReaction,
      context
    });

    const decoded = await this.postImProtobuf('message/set_property', request.body, deadline);
    if (!decoded.ok) {
      throw new Error(`Douyin message/set_property failed: ${decoded.failureReason ?? decoded.status ?? decoded.statusCode ?? 'unknown'}`);
    }

    const properties = [{ key: input.emojiReaction.key, value: input.emojiReaction.propertyValue }, ...(input.emojiReaction.additionalProperties ?? [])];
    let verified = false;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = await this.getMessageReactions(input.replyToMessageId, deadline);
        const versionMatches = !decoded.propertyVersion || BigInt(state.version) >= BigInt(decoded.propertyVersion);
        verified = versionMatches && properties.every(property => {
          const items = state.properties[property.key]?.items ?? [];
          if (input.emojiReaction!.operation === 1) return !items.some(item => item.uid === accountId);
          const item = items.find(item => item.uid === accountId && item.idempotentId === accountId);
          return Boolean(item && (property.value === undefined || item.value === property.value));
        });
        if (verified) break;
        if (attempt < 2) await delay(200, undefined, { signal: deadline.signal });
      }
    } catch (error) {
      throw new Error('Reaction acknowledged but verification failed; delivery may have succeeded, do not retry automatically', { cause: error });
    }
    if (!verified || this.accountId !== accountId) throw new Error('Reaction request acknowledged but target properties were not verified; delivery may have succeeded, do not retry automatically');

    this.logger.info(
      {
        conversationShortId: target.conversationShortId,
        messageId: input.replyToMessageId,
        emoji: input.emojiReaction.key,
        operation: input.emojiReaction.operation === 1 ? 'remove' : 'add'
      },
      'sent douyin emoji reaction through imapi'
    );

    return {
      messageId: input.replyToMessageId,
      raw: {
        source: 'imapi',
        response: decoded
      }
    };
  }

  async getMessageReactions(messageId: string, deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000)): Promise<ReactionState> {
    return deadline.run(async () => {
      const cached = this.getCachedMessage(messageId);
      if (!cached?.conversationShortId) throw new Error('Reaction target is not available in the message cache');
      const accountId = this.accountId;
      if (!accountId) throw new Error('Douyin account is not authenticated');
      const context = await this.readSendProtocolContext();
      const payload = await encodeReactionQuery({ messageId, conversationId: cached.conversationId,
        conversationShortId: cached.conversationShortId, conversationType: cached.conversationType === 'group' ? 2 : 1 });
      const raw = await postImApi(this.page, 'v1/message/get_message_by_server_id', buildImApiRequest(211, payload, context), deadline.remainingMs());
      const state = await decodeReactionQuery(raw);
      if (state.messageId !== messageId || state.conversationId !== cached.conversationId ||
        state.conversationShortId !== cached.conversationShortId || state.conversationType !== (cached.conversationType === 'group' ? 2 : 1)) {
        throw new Error('Reaction query returned a different target');
      }
      if (this.accountId !== accountId || this.getCachedMessage(messageId) !== cached) throw new Error('Reaction target expired, recalled or changed during query');
      return state;
    });
  }

  private async uploadImageViaVod(imageData: LoadedImageData, deadline: ActionDeadline): Promise<DouyinUploadedImage> {
    const bytes = Buffer.from(imageData.base64, 'base64');
    const uploadConfig = await this.readImageUploadConfig(deadline.remainingMs());
    deadline.remainingMs();
    const credentials = normalizeUploadCredentials(uploadConfig);
    const applyUrl = new URL('https://vod.bytedanceapi.com/');
    applyUrl.searchParams.set('Action', 'ApplyUploadInner');
    applyUrl.searchParams.set('Version', '2020-11-19');
    applyUrl.searchParams.set('SpaceName', credentials.spaceName);
    applyUrl.searchParams.set('FileType', 'image');
    applyUrl.searchParams.set('IsInner', '1');
    applyUrl.searchParams.set('NeedFallback', 'true');
    applyUrl.searchParams.set('FileSize', String(bytes.byteLength));
    applyUrl.searchParams.set('s', randomId(10));

    deadline.remainingMs();
    const applyResponse = await fetch(applyUrl, {
      signal: deadline.signal,
      method: 'GET',
      headers: signVodRequest('GET', applyUrl, Buffer.alloc(0), credentials)
    });
    const applyBody = await readJsonResponse(applyResponse, 'ApplyUploadInner');
    const applyResult = recordValue(applyBody.Result ?? applyBody.result, 'ApplyUploadInner.Result');
    const uploadAddress = recordValue(applyResult.UploadAddress ?? applyResult.uploadAddress, 'UploadAddress');
    const storeInfos = arrayValue(uploadAddress.StoreInfos);
    const storeInfo = recordValue(storeInfos[0], 'StoreInfos[0]');
    const uploadHosts = arrayValue(uploadAddress.UploadHosts);
    const uploadHost = stringValue(uploadHosts[0]);
    const storeUri = requireStringValue(storeInfo.StoreUri, 'StoreUri');
    const auth = requireStringValue(storeInfo.Auth, 'Auth');
    const sessionKey = requireStringValue(uploadAddress.SessionKey, 'SessionKey');

    const uploadUrl = `https://${uploadHost}/upload/v1/${storeUri}`;
    const crc32 = crc32Hex(bytes);
    deadline.remainingMs();
    const uploadResponse = await fetch(uploadUrl, {
      signal: deadline.signal,
      method: 'POST',
      headers: {
        authorization: auth,
        'content-crc32': crc32,
        'content-type': 'application/octet-stream'
      },
      body: bytes
    });
    await readJsonResponse(uploadResponse, 'TOS image upload');

    const commitUrl = new URL('https://vod.bytedanceapi.com/');
    commitUrl.searchParams.set('Action', 'CommitUploadInner');
    commitUrl.searchParams.set('Version', '2020-11-19');
    commitUrl.searchParams.set('SpaceName', credentials.spaceName);
    const commitPayload = Buffer.from(
      JSON.stringify({
        SessionKey: sessionKey,
        Functions: [
          {
            name: 'Encryption',
            input: {
              Config: {
                copies: 'cipher_v2'
              },
              PolicyParams: {
                'policy-set': 'check,thumb,medium,large'
              }
            }
          }
        ]
      }),
      'utf8'
    );
    deadline.remainingMs();
    const commitResponse = await fetch(commitUrl, {
      signal: deadline.signal,
      method: 'POST',
      headers: {
        ...signVodRequest('POST', commitUrl, commitPayload, credentials),
        'content-type': 'text/plain;charset=UTF-8'
      },
      body: commitPayload
    });
    const commitBody = await readJsonResponse(commitResponse, 'CommitUploadInner');
    const commitResult = recordValue(commitBody.Result ?? commitBody.result, 'CommitUploadInner.Result');
    const firstResult = recordValue(arrayValue(commitResult.Results ?? commitResult.results)[0], 'Results[0]');
    const encryption = recordValue(firstResult.Encryption ?? firstResult.encryption, 'Encryption');
    const extra = recordValue(encryption.Extra ?? encryption.extra, 'Encryption.Extra');
    const oid = requireStringValue(encryption.Uri ?? encryption.uri, 'Encryption.Uri');
    await this.buildImagePrivacyUrl(oid, deadline.remainingMs()).catch(error => {
      this.logger.warn({ error: error instanceof Error ? error.message : String(error), oid }, 'douyin image privacy url build failed');
    });
    deadline.remainingMs();

    return {
      oid,
      skey: requireStringValue(encryption.SecretKey ?? encryption.secretKey, 'Encryption.SecretKey'),
      size: numberFromUnknown(extra.img_size) ?? bytes.byteLength,
      md5: requireStringValue(encryption.SourceMd5 ?? encryption.sourceMd5, 'Encryption.SourceMd5'),
      width: numberFromUnknown(extra.img_width) ?? 0,
      height: numberFromUnknown(extra.img_height) ?? 0
    };
  }

  private async readImageUploadConfig(timeoutMs: number): Promise<unknown> {
    return this.page.evaluate(async timeout => {
      const params = new URLSearchParams({
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        update_version_code: '170400',
        pc_client_type: '1',
        pc_libra_divert: 'Mac',
        support_h265: '1',
        support_dash: '0',
        cpu_core_num: String(navigator.hardwareConcurrency || 8),
        version_code: '170400',
        version_name: '17.4.0',
        cookie_enabled: String(navigator.cookieEnabled),
        screen_width: String(window.screen.width),
        screen_height: String(window.screen.height),
        browser_language: navigator.language,
        browser_platform: navigator.platform,
        browser_name: 'Chrome',
        browser_version: '153.0.0.0',
        browser_online: String(navigator.onLine),
        engine_name: 'Blink',
        engine_version: '153.0.0.0',
        os_name: 'Mac OS',
        os_version: '10.15.7'
      });
      const response = await fetch(`https://www.douyin.com/aweme/v1/web/im/upload/config/v2?${params}`, {
        signal: AbortSignal.timeout(timeout),
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error(`upload config failed: ${response.status}`);
      }
      return response.json();
    }, timeoutMs);
  }

  private async buildImagePrivacyUrl(uri: string, timeoutMs: number): Promise<void> {
    await this.page.evaluate(async ({ imageUri, timeout }) => {
      const params = new URLSearchParams({
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        pc_client_type: '1',
        pc_libra_divert: 'Mac',
        update_version_code: '170400',
        support_h265: '1',
        support_dash: '0',
        version_code: '170400',
        version_name: '17.4.0',
        cookie_enabled: String(navigator.cookieEnabled),
        screen_width: String(window.screen.width),
        screen_height: String(window.screen.height),
        browser_language: navigator.language,
        browser_platform: navigator.platform,
        browser_name: 'Chrome',
        browser_version: '153.0.0.0',
        browser_online: String(navigator.onLine),
        engine_name: 'Blink',
        engine_version: '153.0.0.0',
        os_name: 'Mac OS',
        os_version: '10.15.7'
      });
      const response = await fetch(`https://www-hj.douyin.com/aweme/v1/web/privacy/batch_build_image/?${params}`, {
        signal: AbortSignal.timeout(timeout),
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json; charset=UTF-8'
        },
        body: JSON.stringify({
          convert_params: [
            {
              uri: imageUri,
              format: 'tplv-x-get:large.image',
              tpl: '%s://%v/%v~%v'
            }
          ]
        })
      });
      if (!response.ok) {
        throw new Error(`privacy image build failed: ${response.status}`);
      }
      const body = await response.json() as { status_code?: number };
      if (body.status_code !== 0) {
        throw new Error(`privacy image build returned status ${body.status_code ?? 'unknown'}`);
      }
    }, { imageUri: uri, timeout: timeoutMs });
  }

  private async sendViaDom(input: DouyinSendMessageInput): Promise<DouyinSendMessageResult> {
    const targetConversation = input.target.conversationShortId ?? input.target.conversationId ?? input.target.userId ?? '';
    if (targetConversation) {
      const selected = await this.selectConversation(targetConversation);
      if (!selected) {
        const conversations = await this.getConversations().catch(() => []);
        const visibleTargets = conversations.map(conversation => conversation.shortId ?? conversation.id).filter(Boolean);
        throw new Error(
          `Unable to select Douyin conversation: ${targetConversation}. Visible conversation ids: ${visibleTargets.join(', ') || '(none)'}`
        );
      }
    }

    const editor = this.page.locator('[contenteditable="true"][class*="messageEditorinputArea"]').first();
    await editor.waitFor({
      state: 'visible',
      timeout: 10_000
    });
    if (input.text) {
      await editor.fill(input.text);
      await editor.press('Enter');
    }

    for (const image of input.images ?? []) {
      const imageData = await loadImageData(image);
      await editor.focus();
      await editor.evaluate(
        (element, data) => {
          const bytes = Uint8Array.from(atob(data.base64), char => char.charCodeAt(0));
          const file = new File([bytes], data.name, { type: data.mimeType });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const event = new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true
          });
          element.dispatchEvent(event);
        },
        imageData
      );
      await this.page.waitForTimeout(1000);
      const confirmed = await this.page
        .getByText('发送', { exact: true })
        .last()
        .click({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (!confirmed) {
        await editor.press('Enter');
      }
      await this.page.waitForTimeout(1000);
    }

    const messageId = `dom_send_${Date.now()}`;
    return {
      messageId,
      raw: {
        source: 'dom'
      }
    };
  }

  private async selectConversation(target: string): Promise<boolean> {
    const targetValue = normalizeConversationText(target);
    const activeConversation = await this.readActiveConversation();
    if (!targetValue || normalizeConversationText(activeConversation) === targetValue) {
      return true;
    }

    const clickedByLocator = await this.page
      .locator('[class*="conversationConversationItemtitle"]')
      .filter({ hasText: target })
      .first()
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    const clicked = clickedByLocator || await this.page.evaluate(rawTarget => {
      function textOf(element: Element | null): string {
        return ((element as HTMLElement | null)?.innerText ?? element?.textContent ?? '').trim();
      }

      function firstContentLine(value: string): string {
        return (
          value
            .split('\n')
            .map(line => line.trim())
            .find(Boolean) ?? ''
        );
      }

      function normalize(value: string): string {
        return firstContentLine(value).replace(/\(\d+\)$/, '').trim().toLowerCase();
      }

      function clickableAncestor(element: Element): HTMLElement | undefined {
        let current: Element | null = element;
        while (current && current !== document.body) {
          const className = current.getAttribute('class') ?? '';
          if (/conversation/i.test(className) && current instanceof HTMLElement) {
            return current;
          }
          current = current.parentElement;
        }
        return element instanceof HTMLElement ? element : undefined;
      }

      const normalizedTarget = normalize(rawTarget);
      const titleElements = Array.from(document.querySelectorAll('[class*="conversationConversationItemtitle"]'));
      const titleElement =
        titleElements.find(element => normalize(textOf(element)) === normalizedTarget) ??
        titleElements.find(element => normalize(textOf(element)).includes(normalizedTarget));
      const clickable = titleElement ? clickableAncestor(titleElement) : undefined;
      clickable?.click();
      return Boolean(clickable);
    }, target);

    if (!clicked) {
      return false;
    }

    await this.page
      .waitForFunction(
        expected => {
          const reader = (window as unknown as { __DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__?: () => string }).__DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__;
          const active = typeof reader === 'function' ? reader() : '';
          const normalize = (value: string) => value.split('\n')[0]?.replace(/\(\d+\)$/, '').trim().toLowerCase() ?? '';
          return normalize(active) === normalize(expected);
        },
        target,
        { timeout: 5_000 }
      )
      .catch(() => undefined);

    const selectedConversation = await this.readActiveConversation();
    if (normalizeConversationText(selectedConversation) === targetValue) {
      return true;
    }

    const editorVisible = await this.page
      .locator('[contenteditable="true"][class*="messageEditorinputArea"]')
      .first()
      .isVisible()
      .catch(() => false);
    this.logger.debug(
      { target, activeConversation: selectedConversation, editorVisible },
      'douyin active conversation check did not match after selecting visible target'
    );
    return editorVisible;
  }

  private async readActiveConversation(): Promise<string> {
    return this.page
      .evaluate(() => {
        const reader = (window as unknown as { __DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__?: () => string }).__DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__;
        return typeof reader === 'function' ? reader() : '';
      })
      .catch(() => '');
  }

  private async validateSendResult(result: unknown): Promise<DouyinSendMessageResult> {
    if (!isSendResult(result)) {
      throw new Error('Douyin send hook returned an invalid result');
    }

    return result;
  }

  private async readSendProtocolContext(): Promise<DouyinSendProtocolContext> {
    return this.page.evaluate(() => {
      function allStorageValues(): string[] {
        const values: string[] = [];
        for (const storage of [window.localStorage, window.sessionStorage]) {
          for (let index = 0; index < storage.length; index += 1) {
            values.push(storage.getItem(storage.key(index) ?? '') ?? '');
          }
        }
        return values;
      }

      function storageValues(): string[] {
        const values: string[] = [];
        for (const storage of [window.localStorage, window.sessionStorage]) {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index) ?? '';
            const value = storage.getItem(key) ?? '';
            if (/identity|security|token|device|webid|fp/i.test(`${key}\n${value}`)) {
              values.push(value);
            }
          }
        }
        return values;
      }

      function pickToken(): string | undefined {
        for (const value of storageValues()) {
          try {
            const parsed = JSON.parse(value) as unknown;
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              typeof (parsed as { token?: unknown }).token === 'string'
            ) {
              return JSON.stringify({ token: (parsed as { token: string }).token });
            }
          } catch {
            // Some storage entries are plain strings; skip JSON parsing failures.
          }

          const token = value.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
          if (token) {
            return JSON.stringify({ token });
          }
        }
        return undefined;
      }

      function cookieValue(name: string): string | undefined {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`))?.[1];
      }

      function pickUserId(): string | undefined {
        const cookieUserId = cookieValue('uid_tt') ?? cookieValue('uid_tt_ss');
        if (cookieUserId && /^\d+$/.test(cookieUserId)) {
          return cookieUserId;
        }

        for (const value of allStorageValues()) {
          const matches = value.match(/(?:"user_id"|"uid"|"webcast_uid")\s*:\s*"?(\d{6,})"?/g) ?? [];
          for (const match of matches) {
            const id = match.match(/(\d{6,})/)?.[1];
            if (id) {
              return id;
            }
          }
        }
        return undefined;
      }

      const browserName = navigator.userAgent.includes('Chrome') ? 'Mozilla' : navigator.appCodeName || 'Mozilla';
      return {
        userAgent: navigator.userAgent,
        language: navigator.language,
        platform: navigator.platform,
        cookieEnabled: navigator.cookieEnabled,
        browserName,
        browserVersion: navigator.userAgent.replace(/^Mozilla\//, ''),
        online: navigator.onLine,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        timezoneName: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        deviceId: cookieValue('webid') ?? cookieValue('ttwid') ?? '0',
        userId: pickUserId(),
        identitySecurityToken: pickToken()
      };
    });
  }

  private buildReplyReference(messageId: string | undefined): DouyinReplyReference | undefined {
    if (!messageId) {
      return undefined;
    }
    if (this.cache.restored) throw new Error('Restored message cache account is not authenticated');
    if (!/^\d+$/.test(messageId)) {
      throw new Error(`Direct Douyin reply requires a numeric message id: ${messageId}`);
    }
    if (this.cache.recalls.get(messageId)) throw new Error(`Cannot reply to recalled message: ${messageId}`);

    const cached = this.messageCache.get(messageId);
    if (!cached) {
      throw new Error(`Cannot reply to message outside the realtime cache: ${messageId}`);
    }

    const callbackStatus = messageCallbackStatus(cached);
    if (callbackStatus !== undefined && callbackStatus !== 0) {
      throw new Error(`Cannot reply to rejected message: ${messageId}`);
    }

    const payload = isRecord(cached.raw) && isRecord(cached.raw.payload) ? cached.raw.payload : {};
    const content = typeof payload.content === 'string' && payload.content ? payload.content : cached.content;
    if (!parseJsonObject(content)) throw new Error(`Cannot reply without the original protocol content: ${messageId}`);
    const originalContent = content!;
    return {
      messageId,
      content: cached.text ?? '',
      originalContent,
      messageType: cached.messageType ?? numberValue(payload.messageType) ?? 7,
      senderId: cached.senderId,
      secSender: stringValue(payload.secSender),
      nickname: cached.senderName ?? '',
      indexInConversation: stringValue(payload.indexInConversation)
    };
  }

  private buildReactionTarget(
    messageId: string,
    fallbackTarget: DouyinSendMessageInput['target']
  ): { conversationShortId: string; conversationType: 1 | 2; clientMessageId: string } {
    if (!/^\d+$/.test(messageId)) {
      throw new Error(`Direct Douyin emoji reaction requires a numeric message id: ${messageId}`);
    }
    if (this.cache.recalls.get(messageId)) throw new Error(`Cannot react to recalled message: ${messageId}`);

    const cached = this.getCachedMessage(messageId);
    if (!cached) {
      throw new Error(`Cannot react to message outside the realtime cache: ${messageId}`);
    }
    if (cached.conversationType !== fallbackTarget.type || (fallbackTarget.conversationId && fallbackTarget.conversationId !== cached.conversationId) ||
      (fallbackTarget.conversationShortId && fallbackTarget.conversationShortId !== cached.conversationShortId)) {
      throw new Error('Reaction target belongs to a different conversation');
    }

    const payload = isRecord(cached.raw) && isRecord(cached.raw.payload) ? cached.raw.payload : {};
    const conversationShortId =
      cached.conversationShortId ??
      stringValue(payload.conversationShortId) ??
      fallbackTarget.conversationShortId ??
      fallbackTarget.conversationId ??
      fallbackTarget.userId;
    if (!conversationShortId || !/^\d+$/.test(conversationShortId)) {
      throw new Error(`Direct Douyin emoji reaction requires a numeric conversation id for message: ${messageId}`);
    }

    const clientMessageId =
      cached.clientMessageId ??
      stringValue(payload.clientMessageId) ??
      extractEntityValue(payload.ext, 's:client_message_id') ??
      this.sentClientMessageIds.get(messageId);
    if (!clientMessageId) {
      throw new Error(`Direct Douyin emoji reaction requires cached client_message_id for message: ${messageId}`);
    }

    return {
      conversationShortId,
      conversationType: cached.conversationType === 'group' ? 2 : 1,
      clientMessageId
    };
  }

  async getConversations(): Promise<DouyinConversation[]> {
    return this.directory.getConversations();
  }

  async getGroupMembers(groupId: string, noCache = false): Promise<DouyinGroupMember[]> {
    return this.directory.getGroupMembers(groupId, noCache);
  }

  async getGroupInfo(groupId: string): Promise<DouyinConversation> {
    return this.directory.getGroupInfo(groupId);
  }

  async setGroupName(groupId: string, name: string): Promise<void> {
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    await deadline.run(() => this.directory.setGroupName(groupId, name, deadline));
  }

  async getFriends(): Promise<DouyinUser[]> {
    return this.directory.getFriends();
  }

  async getLoginInfo(): Promise<DouyinUser> {
    return this.directory.getLoginInfo();
  }

  async getUser(userId: string, noCache = false): Promise<DouyinUser> {
    return this.directory.getUser(userId, noCache);
  }

  get accountId(): string | undefined {
    return this.directory.accountId;
  }

  async refreshSession(): Promise<{ loggedIn: boolean; accountId?: string }> {
    await this.directory.checkSession();
    this.synchronizeCacheAccount();
    return { loggedIn: this.directory.loggedIn, accountId: this.directory.accountId };
  }

  getStatus(): { online: boolean; good: boolean } {
    const online = !this.page.isClosed() && this.directory.loggedIn && Boolean(this.options.isImConnected?.()) && (this.options.isSessionHealthy?.() ?? true);
    return { online, good: online && (this.options.isRealtimeHealthy?.() ?? true) };
  }

  private async handleMessage(message: DouyinMessage): Promise<void> {
    this.synchronizeCacheAccount();
    if (this.cache.restored) return;
    if (this.cache.recalls.get(message.messageId)) return;
    if (!message.senderName) {
      message = { ...message, senderName: this.directory.getCachedUser(message.senderId)?.name };
    }
    this.messageCache.set(message.messageId, message);
    const isOwnEcho = Boolean(message.clientMessageId && this.sentClientMessageIds.get(message.messageId) === message.clientMessageId);
    if (message.clientMessageId) {
      this.sentClientMessageIds.set(message.messageId, message.clientMessageId);
    }
    if (isOwnEcho) {
      this.currentUserId = message.senderId;
    }
    const callbackStatus = messageCallbackStatus(message);
    if (callbackStatus !== undefined && callbackStatus !== 0) {
      this.logger.warn({ messageId: message.messageId, callbackStatus }, 'received rejected message echo; not publishing as a chat message');
      return;
    }
    this.logger.info(
      {
        messageId: message.messageId,
        conversationType: message.conversationType,
        conversationId: message.conversationId,
        senderId: message.senderId
      },
      'received douyin message'
    );

    for (const handler of this.messageHandlers) {
      await handler(message);
    }
  }

  private rememberSentTarget(messageId: string, target: DouyinSendTarget): void {
    if (this.accountId) this.cache.sentTargets.set(messageId, { target: { ...target }, senderId: this.accountId });
  }

  private synchronizeCacheAccount(): void {
    const accountId = this.accountId;
    if (!accountId) return;
    this.cache.restored = false;
    if (this.cache.accountId === accountId) return;
    if (this.cache.accountId !== undefined) {
      this.messageCache.clear();
      this.sentClientMessageIds.clear();
      this.cache.sentTargets.clear();
      this.cache.recalls.clear();
    }
    this.cache.accountId = accountId;
  }
}

function isSendResult(value: unknown): value is DouyinSendMessageResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DouyinSendMessageResult).messageId === 'string'
  );
}

function normalizeConversationText(value: string): string {
  return (
    value
      .split('\n')
      .map(line => line.trim())
      .find(Boolean)
      ?.replace(/\(\d+\)$/, '')
      .trim()
      .toLowerCase() ?? ''
  );
}

function messageCallbackStatus(message: DouyinMessage): number | undefined {
  const payload = isRecord(message.raw) && isRecord(message.raw.payload) ? message.raw.payload : {};
  const value = extractEntityValue(payload.ext, 'im_callback_status_code');
  return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractEntityValue(value: unknown, key: string): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (stringValue(item.key) === key) {
      return stringValue(item.value);
    }
  }
  return undefined;
}

function pickNumericConversationId(input: DouyinSendMessageInput): string | undefined {
  const candidates = [
    input.target.conversationShortId,
    input.target.conversationId,
    input.target.userId
  ];
  return candidates.find((value): value is string => typeof value === 'string' && /^\d+$/.test(value));
}

interface LoadedImageData {
  base64: string;
  mimeType: string;
  name: string;
}

export async function loadImageData(file: string, signal?: AbortSignal): Promise<LoadedImageData> {
  signal?.throwIfAborted();
  if (/^base64:\/\//i.test(file)) {
    const base64 = file.replace(/^base64:\/\//i, '');
    const buffer = Buffer.from(base64, 'base64');
    return {
      base64,
      mimeType: detectImageMime(buffer) ?? 'image/png',
      name: `onebot-image${extensionFromMime(detectImageMime(buffer) ?? 'image/png')}`
    };
  }

  const dataUriMatch = file.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataUriMatch) {
    return {
      base64: dataUriMatch[2],
      mimeType: dataUriMatch[1] || 'image/png',
      name: `onebot-image${extensionFromMime(dataUriMatch[1] || 'image/png')}`
    };
  }

  if (/^https?:\/\//i.test(file)) {
    const response = await fetch(file, { signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch outgoing image: ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? 'image/png';
    return {
      base64: Buffer.from(await response.arrayBuffer()).toString('base64'),
      mimeType: contentType.split(';')[0] || 'image/png',
      name: `onebot-image${extensionFromMime(contentType)}`
    };
  }

  const path = file.startsWith('file://') ? new URL(file) : file;
  const buffer = await readFile(path, { signal });
  return {
    base64: buffer.toString('base64'),
    mimeType: mimeFromPath(typeof path === 'string' ? path : path.pathname),
    name: basename(typeof path === 'string' ? path : path.pathname) || 'onebot-image.png'
  };
}

function normalizeUploadCredentials(value: unknown): UploadCredentials {
  const root = recordValue(value, 'upload config');
  const config =
    optionalRecord(root.public_image_config) ??
    optionalRecord(root.public_image_config_v2) ??
    optionalRecord(root.inner_image_config);
  if (!config) {
    throw new Error('Douyin image upload config did not contain public_image_config_v2');
  }

  return {
    accessKeyId: requireStringValue(config.access_key_id, 'access_key_id'),
    secretAccessKey: requireStringValue(config.secret_access_key, 'secret_access_key'),
    sessionToken: requireStringValue(config.session_token, 'session_token').split('|')[0] ?? '',
    spaceName: requireStringValue(config.space_name, 'space_name')
  };
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned non-JSON response: ${text.slice(0, 200)}`);
  }
  const record = recordValue(parsed, label);
  const responseMetadata = optionalRecord(record.ResponseMetadata ?? record.responseMetadata);
  const error = optionalRecord(responseMetadata?.Error ?? responseMetadata?.error);
  if (error) {
    throw new Error(`${label} returned error: ${JSON.stringify(error).slice(0, 400)}`);
  }
  return record;
}

function randomId(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

function detectImageMime(buffer: Buffer): string | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

function mimeFromPath(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  return 'image/png';
}

function extensionFromMime(mimeType: string): string {
  if (/jpeg/i.test(mimeType)) {
    return '.jpg';
  }
  if (/webp/i.test(mimeType)) {
    return '.webp';
  }
  if (/gif/i.test(mimeType)) {
    return '.gif';
  }
  return '.png';
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  throw new Error(`Expected ${label} to be an object, got ${typeof value}: ${previewValue(value)}`);
}

function previewValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? String(value);
  } catch {
    return String(value).slice(0, 300);
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error('Expected Douyin upload response field to be an array');
}

function requireStringValue(value: unknown, label: string): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  throw new Error(`Expected ${label} to be a string`);
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
