import { buildInteractiveEmoji } from './interactive-emoji.js';
import { buildGroupCard } from './group-card.js';
import { OutgoingMediaCache } from '../media/outgoing.js';
import { groupNotices, modifiedGroupMembers, removedAdminNotices, type DouyinGroupNotice } from './group-notice.js';
import { prepareForward, readForwardRecords } from './forward.js';
import { buildLocationContent } from './card-compat.js';
import { randomUUID } from 'node:crypto';
import { loadImageData, uploadOutgoingImage, validateOutgoingImage, type LoadedImageData } from './image-upload.js';
export { loadImageData } from './image-upload.js';
import { PartialSendError, UncertainSendError } from './types.js';
import { loadOutgoingFile, uploadOutgoingFile } from './file-upload.js';
import { prepareOutgoingVideo, uploadOutgoingVideo } from './video-upload.js';
import type { Page } from 'playwright';
import type { AppLogger } from '../logger/index.js';
import { BoundedCache } from '../runtime/bounded-cache.js';
import { fetchDouyinResource, parseStickerCatalog, resolveDouyinUrl, awemeShareFromDetail } from './resources.js';
import { parseDouyinSticker } from './sticker.js';
import type { StructuredShareInput, NativeMessageContent } from './native-message.js';
import { RetainedCache } from '../runtime/retained-cache.js';
import { ActionDeadline } from '../runtime/deadline.js';
import { IdentitySecurityProvider } from './identity-security.js';
import { buildShareContent, cachedNativeContent, nativeSourceId } from './native-message.js';
import { DouyinDirectory, decodeDirectoryResponse, encodeDirectoryPayload } from './directory.js';
import { postImApi } from './im-client.js';
import { enrichRealtimeFile } from './file.js';
import { fetchSmallEmojiCatalog } from './emoji.js';
import { decodeQueriedMessage, decodeReactionQuery, encodeReactionQuery, type ReactionState } from './reaction.js';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveDouyinFileUrl, type DouyinFileResource } from './file-url.js';
import { enrichRealtimeMedia, mergeRealtimeMessageDetail, toDouyinMessage } from './message-adapter.js';
import type { RealtimeMessageCandidate } from './protobuf.js';
import { cursorId, nextSyncCursor, decodeHistoryResponse, encodeHistoryRequest, historyCandidates } from './history.js';
import { reactionNotices, type DouyinReactionNotice } from './reaction-notice.js';
import type { MediaRegistry } from '../media/registry.js';
import {
  buildEmojiReactionRequest,
  buildImApiRequest,
  buildImageSendRequest,
  buildFileSendRequest,
  buildVideoSendRequest,
  buildNativeSendRequest,
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
  pendingSends: RetainedCache<{ target: DouyinSendTarget; createdAt: number; messageId?: string; rejected?: boolean }>;
  notifications: RetainedCache<boolean>;
  syncCursors?: Record<string, { version: string; cmdIndex: string; readVersion: string }>;
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
    pendingSends: new RetainedCache(limit, ttlMs),
    notifications: new RetainedCache(limit, ttlMs),
    messages: new RetainedCache(limit, ttlMs, message => message.timestamp), sentClientMessageIds: new RetainedCache(limit, ttlMs),
    sentTargets: new RetainedCache(limit, ttlMs), recalls: new RetainedCache(limit, ttlMs, state => state.notice.timestamp)
  };
}

export interface DouyinBridgeOptions {
  requestRestart?: (delayMs: number) => void;
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
  requestRestart(delayMs: number): void {
    if (!this.options.requestRestart) throw new Error('Unsupported: gateway restart controller is unavailable');
    this.options.requestRestart(delayMs);
  }
  reportDeferredActionFailure(action: string, retcode: number): void {
    this.logger.warn({ action, retcode }, 'asynchronous OneBot action failed; no automatic retry');
  }
  private readonly outgoingMedia = new OutgoingMediaCache();
  clearOutgoingMediaCache(): void { this.outgoingMedia.clear(); }

  private readonly stickerCatalog = new BoundedCache<{ accountId: string; message: NativeMessageContent }>(1000, 3600000, Date.now, false);
  private messageHandlers = new Set<DouyinMessageHandler>();
  private readonly recallHandlers = new Set<(notice: DouyinRecall) => void | Promise<void>>();
  private readonly groupNoticeHandlers = new Set<(notice: DouyinGroupNotice) => void | Promise<void>>();
  private readonly groupRequestHandlers = new Set<(request: import('./directory.js').GroupApplyInfo, flag: string) => void | Promise<void>>();
  private readonly reactionHandlers = new Set<(notice: DouyinReactionNotice) => void | Promise<void>>();
  private readonly reactionDeliveries = new Map<string, Promise<void>>();
  private readonly groupNoticeDeliveries = new Map<string, Promise<void>>();
  private readonly pendingGroupRoleNotices = new Map<string, DouyinGroupNotice[]>();
  private readonly uncertainSends = new WeakMap<ActionDeadline, string>();
  private readonly recalling = new Map<string, Promise<void>>();
  private readonly ingestingRecalls = new Map<string, Promise<void>>();
  private readonly receivingFiles = new Map<string, Promise<DouyinMessage>>();
  private readonly receivingStickers = new Map<string, Promise<DouyinMessage>>();
  private readonly receivingVideos = new Map<string, Promise<DouyinMessage>>();
  private readonly receivingVoices = new Map<string, Promise<DouyinMessage>>();
  private readonly receivingImages = new Map<string, Promise<DouyinMessage>>();
  private emojiCatalog?: { accountId: string; tokens: string[]; expiresAt: number };
  private loadingEmojiCatalog?: { accountId: string; promise: Promise<string[]> };
  private readonly messageCache: RetainedCache<DouyinMessage>;
  private readonly sentClientMessageIds: RetainedCache<string>;
  private currentUserId: string | undefined;
  private signedOut = false;
  private readonly directory: DouyinDirectory;
  private readonly identitySecurity: IdentitySecurityProvider;
  private readonly cache: DouyinBridgeCache;

  constructor(
    private readonly page: Page,
    private readonly logger: AppLogger,
    private readonly options: DouyinBridgeOptions = {}
  ) {
    this.identitySecurity = new IdentitySecurityProvider(page, () => this.accountId);
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
    if (this.accountId && this.directory.initialSyncState && !this.cache.syncCursors?.['1']) {
      this.cache.syncCursors = { ...this.cache.syncCursors, '1': { ...this.directory.initialSyncState } };
      await this.cache.persist?.();
    }
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

  onReaction(handler: (notice: DouyinReactionNotice) => void | Promise<void>): void { this.reactionHandlers.add(handler); }

  onGroupNotice(handler: (notice: DouyinGroupNotice) => void | Promise<void>): void { this.groupNoticeHandlers.add(handler); }

  onGroupRequest(handler: (request: import('./directory.js').GroupApplyInfo, flag: string) => void | Promise<void>): void { this.groupRequestHandlers.add(handler); }

  async pollGroupRequests(): Promise<void> {
    const accountId = this.accountId;
    if (!accountId || !this.groupRequestHandlers.size) return;
    this.synchronizeCacheAccount();
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    await deadline.run(async () => {
      const groups = await this.directory.getConversations();
      for (const group of groups) {
        if (group.type !== 'group' || !group.shortId || (group.ownerId !== accountId && group.selfRole !== 2)) continue;
        try {
          for (const request of await this.directory.getGroupRequests(group.shortId, deadline)) {
            const flag = `dygroup:${accountId}:${group.shortId}:${request.applyId}`;
            if (!/^[1-9]\d{0,18}$/.test(request.applyId) || !/^[1-9]\d{0,18}$/.test(request.userId) || this.cache.notifications.get(flag)) continue;
            if (this.accountId !== accountId) throw new Error('Account changed while delivering group requests');
            for (const handler of this.groupRequestHandlers) await handler(request, flag);
            if (this.accountId !== accountId) throw new Error('Account changed while delivering group requests');
            this.cache.notifications.set(flag, true); await this.cache.persist?.();
          }
        } catch (error) {
          deadline.remainingMs();
          if (this.accountId !== accountId) throw error;
          this.logger.warn({ error, groupId: group.shortId }, 'could not read group join requests');
        }
      }
    });
  }

  async approveGroupRequest(flag: string, approve: boolean): Promise<void> {
    const parts = /^dygroup:([1-9]\d{0,18}):([1-9]\d{0,18}):([1-9]\d{0,18})$/.exec(flag);
    if (!parts || parts[1] !== this.accountId || this.signedOut) throw new Error('Invalid or foreign-account group request flag');
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    await deadline.run(() => this.directory.approveGroupRequest(parts[2], parts[3], approve, deadline));
  }

  async ingestGroupNotice(candidate: RealtimeMessageCandidate): Promise<boolean> {
    if (!this.accountId || this.signedOut) return false;
    this.synchronizeCacheAccount();
    const accountId = this.accountId;
    const previous = candidate.conversationShortId ? this.directory.getGroupMemberSnapshot(candidate.conversationShortId) : [];
    if (candidate.conversationType === 2 && candidate.conversationShortId) this.directory.invalidateGroup(candidate.conversationShortId, candidate.messageType === 50005);
    const notices = groupNotices(candidate, accountId);
    const roleKey = `${accountId}:${candidate.serverMessageId}`, pendingRoles = this.pendingGroupRoleNotices.get(roleKey);
    const modified = new Set(modifiedGroupMembers(candidate));
    if (pendingRoles) notices.push(...pendingRoles);
    else if (previous.some(member => member.role === 'admin' && modified.has(member.userId))) {
      if (this.pendingGroupRoleNotices.size >= 1000) throw new Error('Pending group role notice queue is full');
      const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
      const current = await deadline.run(() => this.directory.getGroupMembers(candidate.conversationShortId!, true, deadline));
      if (this.accountId !== accountId) throw new Error('Account changed while reconciling group roles');
      const removed = removedAdminNotices(candidate, previous, current);
      if (removed.length) this.pendingGroupRoleNotices.set(roleKey, removed);
      notices.push(...removed);
    }
    if (!notices.length) return false;
    for (const notice of notices) {
      const key = `group:${notice.eventId}:${notice.type}:${notice.userId}`;
      if (this.cache.notifications.get(key)) continue;
      const deliveryKey = `${accountId}:${key}`, running = this.groupNoticeDeliveries.get(deliveryKey);
      if (running) { await running; continue; }
      const task = (async () => {
        if (this.accountId !== accountId) throw new Error('Account changed during group notice delivery');
        for (const handler of this.groupNoticeHandlers) await handler(notice);
        if (this.accountId !== accountId) throw new Error('Account changed during group notice delivery');
        if (notice.type === 'group_admin' && notice.subType === 'set') this.directory.rememberGroupAdmin(notice.groupId, notice.userId);
        this.cache.notifications.set(key, true);
        try { await this.cache.persist?.(); }
        catch (error) { this.cache.notifications.delete(key); throw error; }
      })().finally(() => this.groupNoticeDeliveries.delete(deliveryKey));
      this.groupNoticeDeliveries.set(deliveryKey, task);
      await task;
    }
    this.pendingGroupRoleNotices.delete(roleKey);
    return true;
  }

  async ingestReaction(candidate: RealtimeMessageCandidate): Promise<void> {
    const id = candidate.serverMessageId;
    if (!id || !this.accountId || this.signedOut) return;
    this.synchronizeCacheAccount();
    if (this.cache.notifications.get(id)) return;
    const running = this.reactionDeliveries.get(id);
    if (running) return running;
    const notices = reactionNotices(candidate);
    if (!notices.length) return;
    const task = (async () => {
      for (const notice of notices) {
        if (this.cache.recalls.get(notice.messageId)) continue;
        for (const handler of this.reactionHandlers) await handler(notice);
      }
      this.cache.notifications.set(id, true);
      await this.cache.persist?.();
    })().finally(() => this.reactionDeliveries.delete(id));
    this.reactionDeliveries.set(id, task);
    return task;
  }

  getCachedMessage(messageId: string): DouyinMessage | undefined {
    if (this.signedOut) return undefined;
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

  async queryMessage(messageId: string, target: DouyinSendTarget,
    deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000)): Promise<RealtimeMessageCandidate> {
    return deadline.run(async () => {
      const accountId = this.accountId;
      if (!accountId) throw new Error('Douyin account is not authenticated');
      const resolved = await this.directory.resolveTarget(target);
      const context = await this.readSendProtocolContext();
      if (this.accountId !== accountId) throw new Error('Douyin account changed during message query');
      const payload = await encodeReactionQuery({ messageId, conversationId: resolved.conversationId!,
        conversationShortId: resolved.conversationShortId!, conversationType: resolved.type === 'group' ? 2 : 1 });
      const raw = await postImApi(this.page, 'v1/message/get_message_by_server_id',
        buildImApiRequest(211, payload, context, resolved.inboxType), deadline.remainingMs());
      const detail = await decodeQueriedMessage(raw);
      deadline.remainingMs();
      if (this.accountId !== accountId || detail.serverMessageId !== messageId || detail.conversationId !== resolved.conversationId ||
          detail.conversationShortId !== resolved.conversationShortId || detail.conversationType !== (resolved.type === 'group' ? 2 : 1)) {
        throw new Error('Message query returned a different account or conversation');
      }
      return detail;
    });
  }

  async fetchMessage(messageId: string, target: DouyinSendTarget): Promise<DouyinMessage> {
    const detail = await this.queryMessage(messageId, target);
    this.synchronizeCacheAccount();
    if (this.cache.recalls.get(messageId)) throw new Error('Message has been recalled');
    const message = toDouyinMessage(detail, false, true);
    if (!message) throw new Error('Message is unavailable');
    this.messageCache.set(messageId, message);
    await this.cache.persist?.();
    return message;
  }

  async getHistory(target: DouyinSendTarget, cursor = '0', limit = 50, direction = 3, parentDeadline?: ActionDeadline): Promise<{
    messages: DouyinMessage[]; next_cursor: string; has_more: boolean;
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || ![1, 2, 3].includes(direction)) throw new Error('Invalid history limit or direction');
    const deadline = parentDeadline ?? new ActionDeadline(this.options.actionTimeoutMs ?? 15000), accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    return deadline.run(async () => {
      const resolved = await this.directory.resolveTarget(target);
      const body = await this.historyRequest(301, 'HistoryRequest', { conversationId: resolved.conversationId,
        conversationShortId: resolved.conversationShortId, conversationType: resolved.type === 'group' ? 2 : 1,
        anchorIndex: cursorId(cursor), direction, limit }, 'v1/message/get_by_conversation', resolved.inboxType ?? 0, deadline);
      if (this.accountId !== accountId || !body.history) throw new Error('History account changed or response missing');
      const messages: DouyinMessage[] = [];
      for (const candidate of historyCandidates(body.history)) {
        if (candidate.conversationId !== resolved.conversationId || candidate.conversationShortId !== resolved.conversationShortId ||
            candidate.conversationType !== (resolved.type === 'group' ? 2 : 1)) throw new Error('History response conversation mismatch');
        const message = toDouyinMessage({ ...candidate, mediaUnavailable: true }, false, true);
        if (!message || this.cache.recalls.get(message.messageId) || (messageCallbackStatus(message) ?? 0) !== 0) continue;
        const existing = this.getCachedMessage(message.messageId);
        if (!existing) this.messageCache.set(message.messageId, message);
        messages.push(existing ?? message);
      }
      await this.cache.persist?.();
      return { messages, next_cursor: cursorId(body.history.nextCursor ?? '0'), has_more: body.history.hasMore === true };
    });
  }

  async getHistoryFromMessage(target: DouyinSendTarget, messageId: string | undefined, limit: number, newer = false,
    deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000)) {
    return deadline.run(async () => {
      if (!messageId) return this.getHistory(target, '0', limit, 3, deadline);
      // Plugin message_seq is a public message ID, never the native conversation index.
      const detail = await this.queryMessage(messageId, target, deadline);
      const index = cursorId((detail.raw as Record<string, unknown>).indexInConversation);
      const result = await this.getHistory(target, index, limit, newer ? 2 : 1, deadline);
      return { ...result, messages: result.messages.filter(message => message.messageId !== messageId) };
    });
  }

  async getReadState(target: DouyinSendTarget): Promise<Record<string, unknown>> {
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000), accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    return deadline.run(async () => {
      const info = await this.directory.getConversationState(target, deadline);
      const body = await this.historyRequest(2000, 'ReadIndexRequest', { conversationId: info.conversationId,
        conversationShortId: info.conversationShortId, conversationType: info.conversationType },
      'v3/conversation/get_read_index', info.inboxType ?? 0, deadline);
      if (this.accountId !== accountId || !body.read) throw new Error('Read state unavailable or account changed');
      const count = info.badgeCount, read = info.conversationSettingInfo?.readBadgeCount;
      return { conversation_id: info.conversationId, conversation_short_id: info.conversationShortId,
        unread_count: count === undefined || read === undefined ? null : Math.max(0, count - read),
        read_index: info.conversationSettingInfo?.readIndex, read_index_v2: info.conversationSettingInfo?.readIndexV2,
        participants: body.read.indexes ?? [] };
    });
  }

  async markConversationRead(target: DouyinSendTarget): Promise<void> {
    const accountId = this.accountId, deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    if (!accountId) throw new Error('Douyin account is not authenticated');
    return deadline.run(async () => {
      const info = await this.directory.getConversationState(target, deadline);
      const latest = await this.getHistory(target, '0', 1, 3, deadline);
      const message = latest.messages[0];
      if (!message) return;
      const detail = await this.queryMessage(message.messageId, target, deadline);
      const raw = detail.raw as Record<string, unknown>;
      const index = cursorId(raw.indexInConversation), indexV2 = cursorId(raw.indexInConversationV2 ?? '1');
      if (this.accountId !== accountId) throw new Error('Douyin account changed before marking read');
      await this.historyRequest(2002, 'MarkReadRequest', { conversationId: info.conversationId,
        conversationShortId: info.conversationShortId, conversationType: info.conversationType,
        readMessageIndex: index, readMessageIndexV2: indexV2, readBadgeCount: info.badgeCount }, 'v3/conversation/mark_read', info.inboxType ?? 1, deadline);
    });
  }

  async recoverMessages(deliver: (candidate: RealtimeMessageCandidate) => Promise<void>): Promise<boolean> {
    const accountId = this.accountId;
    if (!accountId || this.cache.restored || !Object.keys(this.cache.syncCursors ?? {}).length) return false;
    for (const [inbox, start] of Object.entries(this.cache.syncCursors ?? {})) {
      let cursor = { ...start };
      for (let page = 0; page < 100; page++) {
        const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
        const body = await this.historyRequest(2048, 'SyncMessagesRequest', { ...cursor, source: 'reconnect' },
          'v1/message/get_user_message', Number(inbox), deadline);
        if (this.accountId !== accountId || !body.sync) throw new Error('Recovery account changed or response missing');
        const sync = body.sync;
        const next = { version: nextSyncCursor(cursor.version, sync.messages?.nextVersion, sync.messages?.hasMore, sync.messages?.conversations?.length ?? 0),
          cmdIndex: nextSyncCursor(cursor.cmdIndex, sync.commands?.nextIndex, sync.commands?.hasMore, sync.commands?.messages?.length ?? 0),
          readVersion: nextSyncCursor(cursor.readVersion, sync.readInfo?.nextVersion, sync.readInfo?.hasMore, sync.readInfo?.entries?.length ?? 0) };
        const hasMore = Boolean(sync.messages?.hasMore || sync.commands?.hasMore || sync.readInfo?.hasMore);
        if (Object.keys(cursor).some(key => BigInt(next[key as keyof typeof next]) < BigInt(cursor[key as keyof typeof cursor])) ||
            (hasMore && JSON.stringify(next) === JSON.stringify(cursor))) throw new Error('Recovery cursor did not advance');
        const candidates = [...historyCandidates(sync.commands ?? {}),
          ...(sync.messages?.conversations ?? []).flatMap((entry: any) => historyCandidates({ messages: [...(entry.messages ?? []), ...(entry.extMessages ?? [])] }))];
        for (const candidate of candidates) {
          if (candidate.serverMessageId && this.cache.notifications.get(`message:${candidate.serverMessageId}`)) continue;
          await deliver(candidate);
          if (this.accountId !== accountId) throw new Error('Account changed during recovery');
        }
        // Save only after every message/command in the page reached durable downstream queues.
        this.cache.syncCursors![inbox] = next;
        await this.cache.persist?.();
        cursor = next;
        if (!hasMore) break;
        if (page === 99) throw new Error('Recovery page limit reached; remaining messages will resume on the next pass');
      }
    }
    return true;
  }

  private async historyRequest(command: number, type: string, params: Record<string, unknown>, path: string,
    inbox: number, deadline: ActionDeadline): Promise<Record<string, any>> {
    const accountId = this.accountId;
    const context = await this.readSendProtocolContext();
    const payload = await encodeHistoryRequest(type, params);
    if (!accountId || this.accountId !== accountId) throw new Error('Douyin account changed during query');
    const raw = await postImApi(this.page, path, buildImApiRequest(command, payload, context, inbox, command === 2002 ? 604 : command), deadline.remainingMs());
    deadline.remainingMs();
    if (this.accountId !== accountId) throw new Error('Douyin account changed during query');
    return decodeHistoryResponse(raw, command);
  }

  async updateCachedMessageDetail(detail: RealtimeMessageCandidate): Promise<void> {
    if (!detail.serverMessageId) return;
    const cached = this.getCachedMessage(detail.serverMessageId);
    if (!cached || (detail.conversationId && detail.conversationId !== cached.conversationId) ||
        (detail.sender && detail.sender !== cached.senderId) || (detail.messageType && detail.messageType !== cached.messageType)) return;
    const merged = mergeRealtimeMessageDetail(this.cachedCandidate(cached), detail);
    const updated = toDouyinMessage(merged, false, true);
    if (!updated) return;
    const oldMedia = cached.segments?.filter(segment => ['image', 'video', 'record', 'file'].includes(segment.type));
    const segments = oldMedia?.length ? [...(updated.segments?.filter(segment => segment.type === 'reply') ?? []), ...oldMedia] : updated.segments;
    this.messageCache.set(cached.messageId, { ...cached, content: merged.content, text: updated.text, segments, raw: merged.raw });
    await this.cache.persist?.();
  }

  private cachedCandidate(cached: DouyinMessage): RealtimeMessageCandidate {
    return { source: 'imapi', serverMessageId: cached.messageId, clientMessageId: cached.clientMessageId,
      conversationId: cached.conversationId, conversationShortId: cached.conversationShortId,
      conversationType: cached.conversationType === 'group' ? 2 : 1, sender: cached.senderId,
      messageType: cached.messageType, content: cached.content, createTime: String(cached.timestamp), raw: cached.raw };
  }

  receiveCachedImage(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const existing = this.receivingImages.get(messageId);
    if (existing) return existing;
    const promise = this.downloadCachedImage(messageId, registry).finally(() => this.receivingImages.delete(messageId));
    this.receivingImages.set(messageId, promise);
    return promise;
  }

  private async downloadCachedImage(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const cached = this.getCachedMessage(messageId), accountId = this.accountId;
    if (!cached || cached.messageType !== 27) throw new Error('Image message not found in cache');
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    return deadline.run(async () => {
      let candidate = this.cachedCandidate(cached);
      try { candidate = await enrichRealtimeMedia(this.page, registry, this.logger, candidate, deadline.signal); }
      catch {
        deadline.remainingMs();
        const detail = await this.queryMessage(messageId, { type: cached.conversationType, conversationId: cached.conversationId }, deadline);
        candidate = await enrichRealtimeMedia(this.page, registry, this.logger, mergeRealtimeMessageDetail(candidate, detail), deadline.signal);
      }
      deadline.remainingMs();
      if (this.accountId !== accountId || this.getCachedMessage(messageId) !== cached) throw new Error('Image message expired, recalled or changed during download');
      const replies = cached.segments?.filter(segment => segment.type === 'reply') ?? [];
      const message = { ...cached, content: candidate.content, segments: [...replies, { type: 'image', data: { file: candidate.mediaUrl! } }] };
      this.messageCache.set(messageId, message);
      await this.cache.persist?.();
      return message;
    });
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

  receiveCachedVoice(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const existing = this.receivingVoices.get(messageId);
    if (existing) return existing;
    const promise = this.downloadCachedVoice(messageId, registry).finally(() => this.receivingVoices.delete(messageId));
    this.receivingVoices.set(messageId, promise);
    return promise;
  }

  private async downloadCachedVoice(messageId: string, registry: MediaRegistry): Promise<DouyinMessage> {
    const cached = this.getCachedMessage(messageId);
    if (!cached || cached.messageType !== 17) throw new Error('Voice message not found in cache');
    const accountId = this.accountId;
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    const candidate = await deadline.run(async () => {
      const initial = this.cachedCandidate(cached);
      try { return await enrichRealtimeMedia(this.page, registry, this.logger, initial, deadline.signal); }
      catch {
        deadline.remainingMs();
        const detail = await this.queryMessage(messageId, { type: cached.conversationType, conversationId: cached.conversationId }, deadline);
        return enrichRealtimeMedia(this.page, registry, this.logger, mergeRealtimeMessageDetail(initial, detail), deadline.signal);
      }
    });
    deadline.remainingMs();
    if (this.accountId !== accountId || this.getCachedMessage(messageId) !== cached) throw new Error('Voice message expired, recalled or changed during download');
    const replies = cached.segments?.filter(segment => segment.type === 'reply') ?? [];
    const segments = toDouyinMessage(candidate, false, true)!.segments!;
    const message = { ...cached, content: candidate.content, segments: [
      ...(replies.length ? replies : segments.filter(segment => segment.type === 'reply')),
      ...segments.filter(segment => segment.type !== 'reply')
    ] };
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

  async getStickerList(input: { keyword?: string; cursor?: string; target?: DouyinSendTarget } = {}): Promise<Record<string, unknown>> {
    const accountId = this.accountId, deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    if (!accountId) throw new Error('Douyin account is not authenticated');
    const cursor = cursorId(input.cursor ?? '0');
    if (input.keyword !== undefined && (!input.keyword.trim() || input.keyword.length >= 20)) throw new Error('Sticker search keyword must contain 1–19 characters');
    return deadline.run(async () => {
      const search = input.keyword !== undefined;
      const target = search ? await this.directory.resolveTarget(input.target ?? { type: 'private' }) : undefined;
      if (search && !target?.conversationId) throw new Error('Sticker search requires an existing conversation');
      const params: Record<string, string> = search ? { keyword: input.keyword!, cursor, keyword_id: '', source: 'im', query_index: '0',
        target_uid: '0', conv_id: target!.conversationId! } : { cursor, count: '50', groupId: '1' };
      const value = await fetchDouyinResource(this.page, search ? '/aweme/v1/web/im/resource/emoticon/search/' :
        '/aweme/v1/web/im/resources/emoticon/trending', params, deadline);
      if (this.accountId !== accountId) throw new Error('Account changed during sticker lookup');
      const result = parseStickerCatalog(value, search);
      const stickers = result.items.map(message => {
        const catalogId = randomUUID(), sticker = parseDouyinSticker(message.content, 5)!;
        this.stickerCatalog.set(catalogId, { accountId, message });
        return { name: sticker.name ?? '', url: sticker.url, image_id: sticker.imageId,
          segment: { type: 'sticker', data: { douyin_catalog_id: catalogId } } };
      });
      return { stickers, next_cursor: result.cursor, has_more: result.hasMore, unsupported_items: result.rejected };
    });
  }

  async resolveShare(url: string, target: DouyinSendTarget, deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000)): Promise<StructuredShareInput> {
    const accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    return deadline.run(async () => {
      const resolved = await this.directory.resolveTarget(target);
      if (!resolved.conversationShortId) throw new Error('Share lookup requires an existing conversation');
      const canonical = await resolveDouyinUrl(url, deadline);
      const match = /^https:\/\/www\.douyin\.com\/(?:video|note)\/([1-9]\d{0,19})$/.exec(canonical);
      if (!match) throw new Error('Automatic share details currently require a video or photo post; user cards require explicit user metadata');
      const data = await fetchDouyinResource(this.page, '/aweme/v1/web/multi/aweme/detail/', {
        aweme_ids: `[${match[1]}]`, origin_type: 'chat', request_source: '3', conversation_short_id: resolved.conversationShortId
      }, deadline, 'POST');
      if (this.accountId !== accountId) throw new Error('Account changed during share lookup');
      const detail = Array.isArray(data.aweme_details) ? data.aweme_details.find((item: any) => String(item.aweme_id) === match[1]) : undefined;
      if (!detail) throw new Error('Share detail unavailable, private, or removed');
      return awemeShareFromDetail(detail, match[1]);
    });
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

  async sendMessage(input: DouyinSendMessageInput, parentDeadline?: ActionDeadline): Promise<DouyinSendMessageResult> {
    if (this.signedOut) throw new Error('Douyin account is signed out');
    const timeout = input.video ? this.options.videoSendTimeoutMs ?? 120000 : this.options.actionTimeoutMs ?? 15000;
    const deadline = new ActionDeadline(Math.min(timeout, parentDeadline?.remainingMs() ?? timeout));
    const messageIds: string[] = [];
    return deadline.run(async () => {
      if (input.share || input.sticker || input.location || input.contact || input.music || input.forward || input.interactive) {
        if (([input.share, input.sticker, input.location, input.contact, input.music, input.forward, input.interactive].filter(Boolean).length > 1) || input.text || input.images?.length || input.file || input.video ||
            input.mentions?.length || input.emojiTokens?.length || input.emojiReaction) {
          throw new Error('Native card or sticker must be sent as a single segment');
        }
        if (input.share && 'kind' in input.share) buildShareContent(input.share);
      }
      if (input.emojiTokens?.length) {
        const catalog = new Set(await this.getEmojiList(false, deadline));
        for (const token of input.emojiTokens) {
          if (!catalog.has(token)) throw new Error(`Unsupported or hidden Douyin emoji: ${token}`);
        }
      }
      if (input.video && (input.text || input.file || input.images?.length || input.mentions?.length || input.emojiReaction)) {
        throw new Error('Video must be sent without text, image, at, reply, file, or emoji');
      }
      if (input.file && (input.text || input.video || input.images?.length || input.mentions?.length || input.emojiReaction)) {
        throw new Error('File must be sent without text, image, at, reply, or emoji');
      }
      const startingAccount = this.accountId;
      input = { ...input, target: await this.directory.resolveTarget(input.target) };
      this.synchronizeCacheAccount();
      deadline.remainingMs();
      if (startingAccount && this.accountId !== startingAccount) throw new Error('Douyin account changed while resolving message target; message was not sent');
      if (input.share || input.sticker || input.location || input.contact || input.music || input.forward || input.interactive) {
        return this.sendNativeViaImApi(input, deadline);
      }
      if (input.video) return this.sendVideoViaImApi(input, deadline);
      if (input.file) return this.sendFileViaImApi(input, deadline);
      if (input.emojiReaction) {
        return this.sendReactionViaImApi(input, deadline);
      }

      if (input.images?.length) {
        return this.sendImagesViaImApi(input, deadline, messageIds);
      }

      return this.sendViaImApi(input, deadline);
    }).catch(error => {
      const clientId = this.uncertainSends.get(deadline);
      if (clientId) error = new UncertainSendError(clientId, error);
      if (messageIds.length) throw new PartialSendError([...messageIds], error);
      throw error;
    });
  }

  async getForwardMessages(messageId: string, parentDeadline?: ActionDeadline, registry?: MediaRegistry): Promise<DouyinMessage[]> {
    const deadline = parentDeadline ?? new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    return deadline.run(async () => {
      const accountId = this.accountId, card = this.getCachedMessage(nativeSourceId(messageId));
      if (!accountId || card?.messageType !== 136) throw new Error('Forward card is not available in this account cache; fetch its message first');
      const budget = { bytes: 4 * 1024 * 1024, records: 100, chunks: 10 };
      const visited = new Set<string>();
      const read = async (current: DouyinMessage, depth: number): Promise<DouyinMessage[]> => {
        deadline.remainingMs();
        if (this.accountId !== accountId || this.getCachedMessage(messageId) !== card) throw new Error('Forward card expired, recalled or account changed');
        if (visited.has(current.messageId)) throw new Error('Forward cycle detected');
        visited.add(current.messageId);
        const messages = await readForwardRecords(this.page, current, deadline, accountId, budget);
        for (let i = 0; i < messages.length; i++) {
          deadline.remainingMs();
          if (this.accountId !== accountId || this.getCachedMessage(messageId) !== card) throw new Error('Forward card expired, recalled or account changed');
          const message = messages[i];
          if (message.messageType === 136) {
            try {
              if (depth >= 1) throw new Error('Forward nesting limit reached');
              message.forwardMessages = await read(message, depth + 1);
            } catch { deadline.remainingMs(); message.forwardUnavailable = true; }
          } else if (registry && [5, 17, 27, 30, 150].includes(message.messageType ?? 0)) {
            try {
              const candidate = await enrichRealtimeMedia(this.page, registry, this.logger, this.cachedCandidate(message), deadline.signal,
                resource => this.resolveFileUrl(resource));
              const hydrated = toDouyinMessage(candidate, false, true);
              if (hydrated) messages[i] = { ...hydrated, senderName: message.senderName };
            } catch { deadline.remainingMs(); /* Keep the explicit unavailable media placeholder. */ }
          }
        }
        return messages;
      };
      const messages = await read(card, 0);
      if (this.accountId !== accountId || this.getCachedMessage(messageId) !== card) throw new Error('Forward card expired, recalled or account changed');
      return messages;
    });
  }

  private async sendNativeViaImApi(input: DouyinSendMessageInput, deadline: ActionDeadline): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId) throw new Error('Native message send requires an existing conversation');
    const accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    const sourceId = input.sticker?.sourceMessageId ??
      (input.share && 'sourceMessageId' in input.share ? input.share.sourceMessageId : undefined);
    const source = sourceId === undefined ? undefined : this.getCachedMessage(nativeSourceId(sourceId));
    if (sourceId !== undefined && !source) throw new Error('Native source message expired, recalled, or not found in this account cache');
    const catalog = input.sticker?.catalogId ? this.stickerCatalog.get(input.sticker.catalogId) : undefined;
    if (input.sticker?.catalogId && (!catalog || catalog.accountId !== accountId)) throw new Error('Sticker catalog entry expired or belongs to another account; query the catalog again');
    const share = input.share && 'resolveUrl' in input.share ? await this.resolveShare(input.share.resolveUrl, input.target, deadline) : input.share;
    let message = source ? cachedNativeContent(source, input.sticker ? 'sticker' : 'share') : catalog?.message ??
      (share && 'kind' in share ? buildShareContent(share) : undefined);
    if (input.location) message = buildLocationContent(input.location);
    if (input.interactive) {
      const catalog = await fetchDouyinResource(this.page, '/aweme/v1/web/im/strategy/config', { aid: '1128', app_id: '1128', scenes: '["interactive_resources"]' }, deadline);
      message = buildInteractiveEmoji(catalog, input.interactive);
    }
    if (input.contact && 'groupId' in input.contact) {
      const groupId = input.contact.groupId;
      if (!(await this.directory.getConversations()).some(group => group.type === 'group' && group.shortId === groupId)) throw new Error('Group contact requires an existing group');
      const group = await this.directory.getGroupInfo(groupId, deadline);
      if (!group.ownerId) throw new Error('Group owner is unavailable');
      await this.directory.getGroupMembers(groupId);
      message = buildGroupCard(group, await this.getUser(group.ownerId), await this.getUser(accountId));
    }
    if (input.contact && 'userId' in input.contact) {
      const user = await this.getUser(input.contact.userId);
      if (!user.secUid || !user.name) throw new Error('Contact requires a known user with name and secUID; fetch profile details first');
      message = buildShareContent({ kind: 'user', url: `https://www.douyin.com/user/${user.secUid}`, userId: user.id, title: user.name, image: user.avatar });
    }
    const sources: DouyinMessage[] = [];
    if (input.music || input.forward) {
      const ids = input.music ? [input.music.sourceMessageId] : 'messageIds' in input.forward! ? input.forward.messageIds : [input.forward!.sourceMessageId];
      for (const id of ids) { const item = this.getCachedMessage(nativeSourceId(id)); if (!item) throw new Error('Source message expired, recalled, or not found in this account cache'); sources.push(item); }
      if (input.music) {
        const music = sources[0];
        if (music.messageType !== 22 || !music.content) throw new Error('Source is not a native Douyin music card');
        message = { messageType: 22, content: music.content, text: '[音乐]' };
      } else message = await prepareForward(this.page, 'sourceMessageId' in input.forward! ? sources[0] : sources, deadline);
    }
    if (!message) throw new Error('Native message content is unavailable');
    const context = await this.readSendProtocolContext(deadline);
    deadline.remainingMs();
    if (this.accountId !== accountId) throw new Error('Douyin account changed before native message send; message was not sent');
    if (sources.some(m => this.getCachedMessage(m.messageId) !== m)) throw new Error('Forward or music source expired, recalled or changed before send');
    if (source && this.getCachedMessage(source.messageId) !== source) throw new Error('Native source expired, recalled or changed before send');
    const request = buildNativeSendRequest({ conversationShortId, conversationId: input.target.conversationId,
      conversationType: input.target.type === 'group' ? 2 : 1, inboxType: input.target.inboxType, message, context, replyReference: this.buildReplyReference(input.replyToMessageId) });
    const decoded = await this.postImProtobuf('message/send', request.body, deadline, request.clientMessageId, input.target);
    if (!decoded.ok || !decoded.serverMessageId || !/^[1-9]\d{0,18}$/.test(decoded.serverMessageId) ||
        BigInt(decoded.serverMessageId) > 9223372036854775807n) {
      throw new Error(`Douyin native message/send failed: ${decoded.failureReason ?? 'no valid server message receipt; do not retry automatically'}`);
    }
    if (this.accountId !== accountId) throw new Error('Douyin account changed after native message send; delivery may have succeeded, do not retry automatically');
    const messageId = decoded.serverMessageId;
    this.sentClientMessageIds.set(messageId, request.clientMessageId);
    this.rememberSentTarget(messageId, input.target);
    await this.cacheOutgoingMessage(input, messageId, request, message.messageType, accountId);
    this.logger.info({ messageId, conversationShortId, messageType: message.messageType }, 'sent douyin native message through imapi');
    return { messageId, raw: { source: 'imapi', response: decoded } };
  }

  private async sendImagesViaImApi(input: DouyinSendMessageInput, deadline: ActionDeadline, messageIds: string[]): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId) {
      throw new Error('Direct Douyin image send requires a numeric conversation id from realtime messages or group list');
    }
    if (!input.images?.length) {
      throw new Error('Direct Douyin image send requires at least one image');
    }
    if (input.text || input.mentions?.length) {
      throw new Error('Direct Douyin image send currently supports image-only messages');
    }

    const accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    let lastResult: DouyinSendMessageResult | undefined;
    for (const [index, image] of input.images.entries()) {
      deadline.remainingMs();
      const imageData = await loadImageData(image, deadline.signal, this.options.maxFileBytes, this.options.fileSendAllowedDirs, input.imageOptions?.[index], this.outgoingMedia);
      const uploaded = await this.uploadImageViaVod(imageData, deadline);
      const context = await this.readSendProtocolContext(deadline);
      deadline.remainingMs();
      if (this.accountId !== accountId) throw new Error('Douyin account changed before image send; message was not sent');
      const request = buildImageSendRequest({
        conversationShortId,
        conversationId: input.target.conversationId,
        inboxType: input.target.inboxType,
        conversationType: input.target.type === 'group' ? 2 : 1,
        image: uploaded,
        replyReference: this.buildReplyReference(input.replyToMessageId),
        context
      });

      const decoded = await this.postImProtobuf('message/send', request.body, deadline, request.clientMessageId, input.target);
      if (!decoded.ok || !decoded.serverMessageId || !/^[1-9]\d{0,18}$/.test(decoded.serverMessageId) || BigInt(decoded.serverMessageId) > 9223372036854775807n) {
        throw new Error(`Douyin image message/send failed: ${decoded.failureReason ?? decoded.status ?? decoded.statusCode ?? 'unknown'}`);
      }

      if (this.accountId !== accountId) throw new Error('Douyin account changed after image send; delivery may have succeeded, do not retry automatically');
      const messageId = decoded.serverMessageId;
      this.sentClientMessageIds.set(messageId, request.clientMessageId);
      this.rememberSentTarget(messageId, input.target);
      messageIds.push(messageId);
      await this.cacheOutgoingMessage(input, messageId, request, 27, accountId);
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
    return { ...lastResult, messageIds: [...messageIds] };
  }

  private async sendVideoViaImApi(input: DouyinSendMessageInput, deadline: ActionDeadline): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId || !input.video) throw new Error('Video send requires an existing conversation and one video');
    const accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    const video = await prepareOutgoingVideo(input.video, { downloadCache: this.outgoingMedia, maxBytes: this.options.maxFileBytes ?? 128 * 1024 * 1024,
      allowedDirs: this.options.fileSendAllowedDirs ?? [], ffmpegPath: this.options.ffmpegPath ?? 'ffmpeg',
      ffprobePath: this.options.ffprobePath ?? 'ffprobe' }, deadline);
    const config = await this.readImageUploadConfig(deadline.remainingMs());
    const uploaded = await uploadOutgoingVideo(video, config, deadline);
    if (this.accountId !== accountId) throw new Error('Douyin account changed during video upload; message was not sent');
    const context = await this.readSendProtocolContext(deadline);
    deadline.remainingMs();
    if (this.accountId !== accountId) throw new Error('Douyin account changed before video send; message was not sent');
    const request = buildVideoSendRequest({ conversationShortId, conversationId: input.target.conversationId,
      conversationType: input.target.type === 'group' ? 2 : 1, inboxType: input.target.inboxType, video: uploaded, context, replyReference: this.buildReplyReference(input.replyToMessageId) });
    const decoded = await this.postImProtobuf('message/send', request.body, deadline, request.clientMessageId, input.target);
    if (!decoded.ok || !decoded.serverMessageId || !/^[1-9]\d*$/.test(decoded.serverMessageId)) {
      throw new Error(`Douyin video message/send failed: ${decoded.failureReason ?? 'no valid server message receipt; do not retry automatically'}`);
    }
    if (this.accountId !== accountId) throw new Error('Douyin account changed after video send; delivery may have succeeded, do not retry automatically');
    const messageId = decoded.serverMessageId;
    this.sentClientMessageIds.set(messageId, request.clientMessageId);
    this.rememberSentTarget(messageId, input.target);
    await this.cacheOutgoingMessage(input, messageId, request, 30, accountId);
    this.logger.info({ messageId, conversationShortId, videoSize: video.bytes.length, width: uploaded.width, height: uploaded.height }, 'sent douyin video through imapi');
    return { messageId, raw: { source: 'imapi', response: decoded } };
  }

  private async sendFileViaImApi(input: DouyinSendMessageInput, deadline: ActionDeadline): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId || !input.file) throw new Error('File send requires an existing conversation and one file');
    const accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    const file = await loadOutgoingFile(input.file, this.options.maxFileBytes ?? 128 * 1024 * 1024, deadline.signal, this.options.fileSendAllowedDirs);
    const config = await this.readImageUploadConfig(deadline.remainingMs());
    const uploaded = await uploadOutgoingFile(file, config, deadline);
    if (this.accountId !== accountId) throw new Error('Douyin account changed during file upload; message was not sent');
    const context = await this.readSendProtocolContext(deadline);
    deadline.remainingMs();
    if (this.accountId !== accountId) throw new Error('Douyin account changed before file send; message was not sent');
    const request = buildFileSendRequest({ conversationShortId, conversationId: input.target.conversationId,
      conversationType: input.target.type === 'group' ? 2 : 1, inboxType: input.target.inboxType, file: uploaded, context, replyReference: this.buildReplyReference(input.replyToMessageId) });
    const decoded = await this.postImProtobuf('message/send', request.body, deadline, request.clientMessageId, input.target);
    if (!decoded.ok || !decoded.serverMessageId || !/^[1-9]\d*$/.test(decoded.serverMessageId)) {
      throw new Error(`Douyin file message/send failed: ${decoded.failureReason ?? 'no valid server message receipt; do not retry automatically'}`);
    }
    if (this.accountId !== accountId) throw new Error('Douyin account changed after file send; delivery may have succeeded, do not retry automatically');
    const messageId = decoded.serverMessageId;
    this.sentClientMessageIds.set(messageId, request.clientMessageId);
    this.rememberSentTarget(messageId, input.target);
    await this.cacheOutgoingMessage(input, messageId, request, 150, accountId);
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

    const accountId = this.accountId;
    if (!accountId) throw new Error('Douyin account is not authenticated');
    const context = await this.readSendProtocolContext(deadline);
    deadline.remainingMs();
    if (this.accountId !== accountId) throw new Error('Douyin account changed before text send; message was not sent');
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

    const decoded = await this.postImProtobuf('message/send', request.body, deadline, request.clientMessageId, input.target);
    if (!decoded.ok || !decoded.serverMessageId || !/^[1-9]\d{0,18}$/.test(decoded.serverMessageId) || BigInt(decoded.serverMessageId) > 9223372036854775807n) {
      throw new Error(`Douyin message/send failed: ${decoded.failureReason ?? decoded.status ?? decoded.statusCode ?? 'unknown'}`);
    }

    if (this.accountId !== accountId) throw new Error('Douyin account changed after text send; delivery may have succeeded, do not retry automatically');
    const messageId = decoded.serverMessageId;
    this.sentClientMessageIds.set(messageId, request.clientMessageId);
    this.rememberSentTarget(messageId, input.target);
    await this.cacheOutgoingMessage(input, messageId, request, 7, accountId);
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

  private async cacheOutgoingMessage(input: DouyinSendMessageInput, messageId: string,
    request: { clientMessageId: string; content: string }, messageType: number, accountId: string): Promise<void> {
    if (!this.messageCache.get(messageId) && !this.cache.recalls.get(messageId)) {
      const reply = input.replyToMessageId ? [{ type: 'reply', data: { id: input.replyToMessageId } }] : [];
      const message = toDouyinMessage({ source: 'imapi', serverMessageId: messageId, clientMessageId: request.clientMessageId,
        conversationId: input.target.conversationId, conversationShortId: input.target.conversationShortId,
        conversationType: input.target.type === 'group' ? 2 : 1, sender: accountId, messageType,
        content: request.content, createTime: String(Date.now()), raw: { content: request.content, messageType } }, false, true);
      if (message) this.messageCache.set(messageId, { ...message, segments: [...reply, ...(message.segments ?? [])] });
    }
    await this.cache.persist?.().catch(error => this.logger.warn({ messageId, error: error instanceof Error ? error.message : String(error) }, 'message delivered but send cache persistence failed'));
  }

  private async postImProtobuf(endpoint: 'message/send' | 'message/set_property', body: Buffer, deadline: ActionDeadline,
    clientId?: string, target?: DouyinSendTarget) {
    const accountId = this.accountId;
    if (endpoint === 'message/send' && clientId && target) {
      this.cache.pendingSends.set(clientId, { target, createdAt: Date.now() });
      await this.cache.persist?.();
      deadline.remainingMs();
      if (this.accountId !== accountId) throw new Error('Account changed before sending');
      this.uncertainSends.set(deadline, clientId);
    }
    const response = await postImApi(this.page, `v1/${endpoint}`, body, deadline.remainingMs());
    const decoded = decodeSendResponse(response);
    const expectedCommand = endpoint === 'message/send' ? 100 : 705;
    const rejected = (decoded.statusCode !== undefined && decoded.statusCode !== 0) ||
      (decoded.messageStatus !== undefined && decoded.messageStatus !== 0) ||
      (decoded.checkCode !== undefined && decoded.checkCode !== '0') ||
      (decoded.callbackStatusCode !== undefined && decoded.callbackStatusCode !== 0);
    if (clientId && decoded.cmd === expectedCommand && (decoded.ok || rejected)) {
      this.uncertainSends.delete(deadline);
      const pending = this.cache.pendingSends.get(clientId);
      if (pending) this.cache.pendingSends.set(clientId, { ...pending, ...(decoded.ok ? { messageId: decoded.serverMessageId } : { rejected: true }) });
      await this.cache.persist?.().catch(() => undefined);
    }
    if (decoded.cmd !== expectedCommand) return { ...decoded, ok: false, failureReason: `Unexpected response command: ${decoded.cmd}` };
    return decoded;
  }

  async getSendResult(clientId: string): Promise<Record<string, unknown>> {
    this.synchronizeCacheAccount();
    const pending = this.cache.pendingSends.get(clientId);
    if (!pending || this.cache.restored || !this.accountId) throw new Error('Pending send not found in this account');
    if (pending.messageId) return { delivery_status: 'sent', message_id: pending.messageId, client_message_id: clientId };
    if (pending.rejected) return { delivery_status: 'rejected', client_message_id: clientId };
    const accountId = this.accountId;
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    return deadline.run(async () => {
      let cursor = '0';
      for (let page = 0; page < 10; page++) {
        deadline.remainingMs();
        const result = await this.getHistory(pending.target, cursor, 100, page === 0 ? 3 : 1, deadline);
        if (this.accountId !== accountId) throw new Error('Account changed during send reconciliation');
        const found = result.messages.find(message => message.clientMessageId === clientId && message.senderId === accountId);
        if (found) {
          this.sentClientMessageIds.set(found.messageId, clientId);
          this.rememberSentTarget(found.messageId, pending.target);
          this.cache.pendingSends.set(clientId, { ...pending, messageId: found.messageId });
          await this.cache.persist?.();
          return { delivery_status: 'sent', message_id: found.messageId, client_message_id: clientId };
        }
        if (!result.has_more || result.next_cursor === cursor) break;
        cursor = result.next_cursor;
      }
      return { delivery_status: 'unknown', client_message_id: clientId };
    });
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
    await validateOutgoingImage(this.page, imageData, deadline.signal);
    const config = await this.readImageUploadConfig(deadline.remainingMs());
    return uploadOutgoingImage(imageData, config, deadline);
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

  private async readSendProtocolContext(deadline?: ActionDeadline): Promise<DouyinSendProtocolContext> {
    const context = await this.page.evaluate(() => {
      function allStorageValues(): string[] {
        const values: string[] = [];
        for (const storage of [window.localStorage, window.sessionStorage]) {
          for (let index = 0; index < storage.length; index += 1) {
            values.push(storage.getItem(storage.key(index) ?? '') ?? '');
          }
        }
        return values;
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
        userId: pickUserId()
      };
    });
    return deadline ? { ...context, ...await this.identitySecurity.get(deadline) } : context;
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

  async manageGroup(groupId: string, operation: import('./group-management.js').GroupOperation): Promise<void> {
    if (!this.accountId || this.signedOut) throw new Error('Douyin account is not authenticated');
    const deadline = new ActionDeadline(this.options.actionTimeoutMs ?? 15000);
    await deadline.run(() => this.directory.manageGroup(groupId, operation, deadline));
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
    return this.signedOut ? undefined : this.directory.accountId;
  }

  get loggedIn(): boolean {
    return !this.signedOut && this.directory.loggedIn;
  }

  async invalidateLogin(): Promise<void> {
    this.signedOut = true;
    this.outgoingMedia.clear();
    this.pendingGroupRoleNotices.clear();
    this.cache.notifications.clear();
    this.cache.pendingSends.clear();
    this.cache.syncCursors = {};
    this.cache.messages.clear(); this.cache.sentClientMessageIds.clear(); this.cache.sentTargets.clear(); this.cache.recalls.clear();
    await this.cache.persist?.();
  }

  async refreshSession(): Promise<{ loggedIn: boolean; accountId?: string }> {
    await this.directory.checkSession();
    this.synchronizeCacheAccount();
    return { loggedIn: this.directory.loggedIn, accountId: this.directory.accountId };
  }

  getStatus(): { online: boolean; good: boolean } {
    const online = !this.signedOut && !this.page.isClosed() && this.directory.loggedIn && Boolean(this.options.isImConnected?.()) && (this.options.isSessionHealthy?.() ?? true);
    return { online, good: online && (this.options.isRealtimeHealthy?.() ?? true) };
  }

  private async handleMessage(message: DouyinMessage): Promise<void> {
    if (this.signedOut) return;
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
    if (this.cache.notifications.get(`message:${message.messageId}`)) return;
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
    if (this.messageHandlers.size) this.cache.notifications.set(`message:${message.messageId}`, true);
  }

  private rememberSentTarget(messageId: string, target: DouyinSendTarget): void {
    if (this.accountId) this.cache.sentTargets.set(messageId, { target: { ...target }, senderId: this.accountId });
  }

  private synchronizeCacheAccount(): void {
    const accountId = this.accountId;
    if (!accountId) return;
    this.cache.restored = false;
    if (this.cache.accountId === accountId) return;
    this.outgoingMedia.clear();
    this.pendingGroupRoleNotices.clear();
    if (this.cache.accountId !== undefined) {
      this.cache.notifications.clear();
      this.cache.pendingSends.clear();
      this.cache.syncCursors = {};
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
