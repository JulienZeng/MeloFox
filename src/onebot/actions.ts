import { scopedLogger, type AppLogger } from '../logger/index.js';
import { mediaDownloadOptions, type MediaDownloadOptions } from '../media/outgoing.js';
import { DeferredActions } from './deferred-actions.js';
import type { AppConfig } from '../config/index.js';
import { locationInput, unpackCardEnvelope } from '../douyin/card-compat.js';
import { isLosslessNumber } from 'lossless-json';
import { listDouyinGroupMembers, listDouyinGroups } from '../douyin/conversation.js';
import type { DouyinBridge } from '../douyin/bridge.js';
import type { MediaRegistry } from '../media/registry.js';
import { toOneBotMessageEvent } from './events.js';
import { parseCqMessage } from './cq.js';
import { outgoingEmojiToken, qqFaceNames } from '../douyin/emoji.js';
import { buildShareContent, nativeSourceId, numericId, type DouyinShareSendInput } from '../douyin/native-message.js';
import { MessageUnavailableError, PartialSendError, UncertainSendError } from '../douyin/types.js';
import { ActionDeadline } from '../runtime/deadline.js';
import { getVersionInfo } from '../runtime/version.js';
import type { DouyinSendTarget, DouyinEmojiReaction, DouyinMessage, DouyinGroupMember } from '../douyin/types.js';
import type { OneBotActionRequest, OneBotActionResponse, OneBotMessageSegment, OneBotStatus } from './types.js';

interface OutgoingMessage {
  text: string;
  emojiTokens: string[];
  images: string[];
  imageOptions?: MediaDownloadOptions[];
  file?: { file: string; name?: string };
  video?: { file: string; download?: MediaDownloadOptions };
  share?: DouyinShareSendInput;
  location?: import('../douyin/card-compat.js').LocationInput;
  contact?: { userId: string } | { groupId: string };
  music?: { sourceMessageId: string };
  interactive?: 'dice' | 'rps';
  forward?: { messageIds: string[] } | { sourceMessageId: string };
  sticker?: { sourceMessageId?: string; catalogId?: string };
  mentions: Array<{
    userId: string;
    name?: string;
    location: number;
    length: number;
  }>;
  replyToMessageId?: string;
  emojiReaction?: DouyinEmojiReaction;
}

const supportedActions = new Set([
  '.handle_quick_operation', 'send_msg', 'send_private_msg', 'send_group_msg',
  'send_group_forward_msg', 'send_private_forward_msg', 'get_forward_msg', 'get_msg',
  'get_douyin_send_result', 'get_record', 'get_group_msg_history', 'get_friend_msg_history',
  'get_private_msg_history', 'get_douyin_history', 'search_douyin_messages', 'get_douyin_read_state',
  'mark_douyin_read', 'get_douyin_sticker_list', 'resolve_douyin_share', 'get_douyin_reactions',
  'set_msg_emoji_like', 'set_douyin_reaction', 'get_douyin_emoji_list', 'delete_msg',
  'set_group_add_request', 'set_group_kick', 'set_group_leave', 'set_group_card',
  'set_group_admin', 'set_group_ban', 'set_group_whole_ban', 'set_group_name',
  'get_login_info', 'get_friend_list', 'get_stranger_info', 'get_group_list',
  'get_group_info', 'get_group_member_list', 'get_group_member_info', 'get_status',
  'can_send_image', 'can_send_record', 'get_image', 'get_group_file_url',
  'get_private_file_url', 'clean_cache', 'get_version_info', 'set_restart'
]);

export function supportsOneBotAction(action: string): boolean {
  return supportedActions.has(action.replace(/_(async|rate_limited)$/, ''));
}

export class OneBotActionRouter {
  private static readonly deferred = new WeakMap<DouyinBridge, DeferredActions>();
  static stopForBridge(bridge: DouyinBridge): void { this.deferred.get(bridge)?.stop(); }
  constructor(
    private readonly config: AppConfig,
    private readonly bridge: DouyinBridge,
    private readonly mediaRegistry?: MediaRegistry,
    private readonly logger?: AppLogger
  ) {
    this.logger = logger && scopedLogger(logger, 'OneBot API');
  }

  async handle(request: OneBotActionRequest): Promise<OneBotActionResponse> {
    const started = Date.now();
    try {
      if (!request || typeof request.action !== 'string' || !request.action ||
        (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params) || isLosslessNumber(request.params)))) {
        throw new Error('Invalid OneBot action request');
      }
      if (!supportsOneBotAction(request.action)) throw unsupported(`Unsupported OneBot action: ${request.action}`);
      const suffix = /_(async|rate_limited)$/.exec(request.action);
      if (suffix) {
        const action = request.action.slice(0, -suffix[0].length);
        if (!action || /_(async|rate_limited)$/.test(action)) throw new Error('Invalid asynchronous action name');
        let queue = OneBotActionRouter.deferred.get(this.bridge);
        if (!queue) { queue = new DeferredActions(this.config.onebot.rateLimitIntervalMs); OneBotActionRouter.deferred.set(this.bridge, queue); }
        const account = this.bridge.accountId;
        // Transport-owned request objects are retained only until this bounded job runs.
        queue.enqueue(async () => {
          if (account !== this.bridge.accountId) { this.bridge.reportDeferredActionFailure(action, 10003); return; }
          const result = await this.handle({ ...request, action });
          if (result.status === 'failed') this.bridge.reportDeferredActionFailure(action, result.retcode);
        }, suffix[1] === 'rate_limited');
        return { status: 'async', retcode: 1, data: null, echo: request.echo };
      }
      const data = await this.dispatch(request);
      this.logger?.debug?.({ action: request.action, durationMs: Date.now() - started }, 'OneBot 接口执行完成');
      if (request.action === 'set_restart') return { status: 'async', retcode: 1, data: null, echo: request.echo };
      return ok(data, request.echo);
    } catch (error) {
      if (error instanceof MessageUnavailableError) {
        this.logger?.warn({ action: request?.action, messageId: error.messageId, reason: error.message }, 'OneBot 消息查询未完成');
      } else this.logger?.warn({ action: request?.action, durationMs: Date.now() - started, error }, 'OneBot 接口执行失败');
      const message = error instanceof Error ? error.message : String(error);
      let cause = error, unknown: UncertainSendError | undefined;
      for (let depth = 0; depth < 8 && cause instanceof Error; depth++, cause = cause.cause) {
        if (cause instanceof UncertainSendError) { unknown = cause; break; }
      }
      return { ...failed(message, request?.echo), ...(error instanceof PartialSendError || unknown ? { data: {
        ...(error instanceof PartialSendError ? { message_ids: error.messageIds, partial: true } : {}),
        ...(unknown ? { client_message_id: unknown.clientMessageId, delivery_status: 'unknown' } : {})
      } } : {}) };
    }
  }

  private async dispatch(request: OneBotActionRequest): Promise<unknown> {
    switch (request.action) {
      case '.handle_quick_operation':
        return this.quickOperation(request.params ?? {});
      case 'send_msg':
        return this.sendMsg(request.params ?? {});
      case 'send_private_msg':
        return this.sendPrivateMsg(request.params ?? {});
      case 'send_group_msg':
        return this.sendGroupMsg(request.params ?? {});
      case 'send_group_forward_msg':
      case 'send_private_forward_msg': {
        const p = request.params ?? {};
        if (!Array.isArray(p.messages) || !p.messages.length || !p.messages.every(v => isMessageSegment(v) && v.type === 'node')) throw new Error('Forward messages must be node segments referring to existing message IDs');
        const result = await this.sendOutgoing(request.action === 'send_group_forward_msg' ? { type: 'group', conversationShortId: requireNumericId(p, 'group_id') } : { type: 'private', userId: requireNumericId(p, 'user_id') }, { ...p, message: p.messages });
        return { ...result, forward_id: result.message_id };
      }
      case 'get_forward_msg': {
        const p = request.params ?? {};
        const messages = await this.bridge.getForwardMessages(nativeSourceId(p.id ?? p.message_id), undefined, this.mediaRegistry);
        return { message: messages.map(m => this.forwardNode(m)), messages: messages.map(m => this.forwardMessageEvent(m)) };
      }
      case 'get_msg':
        return this.getMsg(request.params ?? {});
      case 'get_douyin_send_result':
        return this.bridge.getSendResult(requireString(request.params, 'client_message_id'));
      case 'get_record':
        if (!this.mediaRegistry) throw new Error('Media registry is unavailable');
        return this.mediaRegistry.getRecord(requireString(request.params, 'file'), requireString(request.params, 'out_format'));
      case 'get_group_msg_history':
      case 'get_friend_msg_history':
      case 'get_private_msg_history':
        return this.compatibleHistory(request.action, request.params ?? {});
      case 'get_douyin_history':
      case 'search_douyin_messages': {
        const params = request.params ?? {};
        const result = await this.bridge.getHistory({ type: params.group_id ? 'group' : 'private',
          userId: params.user_id ? requireString(params, 'user_id') : undefined,
          conversationId: params.conversation_id ? requireString(params, 'conversation_id') : undefined,
          conversationShortId: params.group_id ? requireString(params, 'group_id') : undefined },
        String(params.cursor ?? '0'), Number(params.count ?? 50), Number(params.direction ?? 3));
        const query = request.action === 'search_douyin_messages' ? requireString(params, 'keyword') : undefined;
        return { ...result, messages: result.messages.filter(message => !query || message.text?.includes(query))
          .map(message => toOneBotMessageEvent(this.config, message)) };
      }
      case 'get_douyin_read_state':
      case 'mark_douyin_read': {
        const params = request.params ?? {}, target = { type: params.group_id ? 'group' as const : 'private' as const,
          userId: params.user_id ? requireString(params, 'user_id') : undefined,
          conversationId: params.conversation_id ? requireString(params, 'conversation_id') : undefined,
          conversationShortId: params.group_id ? requireString(params, 'group_id') : undefined };
        if (request.action === 'get_douyin_read_state') return this.bridge.getReadState(target);
        await this.bridge.markConversationRead(target); return null;
      }
      case 'get_douyin_sticker_list': {
        const p = request.params ?? {};
        return this.bridge.getStickerList({ keyword: p.keyword === undefined ? undefined : requireString(p, 'keyword'),
          cursor: String(p.cursor ?? '0'), target: { type: p.group_id ? 'group' : 'private',
            userId: p.user_id ? requireString(p, 'user_id') : undefined, conversationId: p.conversation_id ? requireString(p, 'conversation_id') : undefined,
            conversationShortId: p.group_id ? requireString(p, 'group_id') : undefined } });
      }
      case 'resolve_douyin_share': {
        const p = request.params ?? {};
        const share = await this.bridge.resolveShare(requireString(p, 'url'), { type: p.group_id ? 'group' : 'private',
          userId: p.user_id ? requireString(p, 'user_id') : undefined, conversationId: p.conversation_id ? requireString(p, 'conversation_id') : undefined,
          conversationShortId: p.group_id ? requireString(p, 'group_id') : undefined });
        return { type: 'share', data: { url: share.url, title: share.title, image: share.image, douyin_share_type: share.kind,
          douyin_user_id: share.userId, douyin_sec_uid: share.secUid, douyin_author_name: share.authorName, douyin_image_count: share.imageCount } };
      }
      case 'get_douyin_reactions':
        return this.bridge.getMessageReactions(requireString(request.params, 'message_id'));
      case 'set_msg_emoji_like': {
        const messageId = requireNumericId(request.params, 'message_id');
        const emojiCode = request.params?.emoji_id;
        if (typeof emojiCode !== 'string' || !/^\[[^\[\]\x00-\x1f\x7f]{1,64}\]$/.test(emojiCode)) {
          throw new Error('emoji_id must be a Douyin emoji code such as [OK] or [捂脸], not a QQ numeric ID');
        }
        const set = request.params?.set;
        if (set !== undefined && typeof set !== 'boolean' && set !== 'true' && set !== 'false') {
          throw new Error('set must be a boolean or the string "true" / "false"');
        }
        await this.setReaction(messageId, resolveEmojiReaction({ type: 'emoji', data: { name: emojiCode } }),
          set !== false && set !== 'false');
        return { result: true };
      }
      case 'set_douyin_reaction': {
        const messageId = requireString(request.params, 'message_id');
        const isAdd = request.params?.is_add;
        if (isAdd !== undefined && typeof isAdd !== 'boolean') throw new Error('is_add must be a boolean');
        const emoji = resolveEmojiReaction({ type: 'emoji', data: { name: requireString(request.params, 'name') } });
        return this.setReaction(messageId, emoji, isAdd !== false);
      }
      case 'get_douyin_emoji_list':
        return (await this.bridge.getEmojiList(request.params?.no_cache === true)).map(text => {
          const faceId = Object.entries(qqFaceNames).find(([, name]) => `[${name}]` === text)?.[0];
          return { name: text.slice(1, -1), text, ...(faceId ? { face_id: faceId } : {}) };
        });
      case 'delete_msg':
        await this.bridge.recallMessage(requireString(request.params, 'message_id'));
        return null;
      case 'set_group_add_request': {
        const p = request.params ?? {};
        if ((p.sub_type ?? p.type) !== 'add') throw unsupported('Only join applications to existing managed groups are supported');
        if (p.approve !== undefined && typeof p.approve !== 'boolean') throw new Error('approve must be a boolean');
        if (p.reason !== undefined && p.reason !== '') throw unsupported('Douyin approval has no verified rejection-reason field');
        await this.bridge.approveGroupRequest(requireString(p, 'flag'), p.approve !== false);
        return null;
      }
      case 'set_group_kick':
      case 'set_group_leave':
      case 'set_group_card':
      case 'set_group_admin':
      case 'set_group_ban':
      case 'set_group_whole_ban': {
        const p = request.params ?? {}, groupId = requireNumericId(p, 'group_id');
        const flag = (key: string, fallback: boolean) => {
          if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
          return p[key] === undefined ? fallback : p[key] as boolean;
        };
        const user = () => requireNumericId(p, 'user_id');
        switch (request.action) {
          case 'set_group_kick': await this.bridge.manageGroup(groupId, { kind: 'kick', userId: user(), rejectAddRequest: flag('reject_add_request', false) }); break;
          case 'set_group_leave': await this.bridge.manageGroup(groupId, { kind: 'leave', dismiss: flag('is_dismiss', false) }); break;
          case 'set_group_card':
            if (p.card !== undefined && typeof p.card !== 'string') throw new Error('card must be a string');
            await this.bridge.manageGroup(groupId, { kind: 'card', userId: user(), card: p.card as string ?? '' }); break;
          case 'set_group_admin': await this.bridge.manageGroup(groupId, { kind: 'admin', userId: user(), enable: flag('enable', true) }); break;
          case 'set_group_ban': {
            const duration = p.duration === undefined ? 1800 : Number(p.duration);
            if ((p.duration !== undefined && !['string', 'number'].includes(typeof p.duration)) || (typeof p.duration === 'string' && !/^\d+$/.test(p.duration)) || !Number.isSafeInteger(duration) || duration < 0 || duration > 2592000) throw new Error('duration must be an integer from 0 to 2592000 seconds');
            await this.bridge.manageGroup(groupId, { kind: 'ban', userId: user(), duration }); break;
          }
          case 'set_group_whole_ban': await this.bridge.manageGroup(groupId, { kind: 'whole_ban', enable: flag('enable', true) }); break;
        }
        return null;
      }
      case 'set_group_name': {
        const groupId = requireString(request.params, 'group_id');
        const name = request.params?.group_name;
        if (typeof name !== 'string' || !name.trim()) throw new Error('group_name must be a non-empty string');
        await this.bridge.setGroupName(groupId, name);
        return null;
      }
      case 'get_login_info': {
        const user = await this.bridge.getLoginInfo();
        this.config.app.selfId = user.id;
        return {
          user_id: user.id,
          nickname: user.name ?? ''
        };
      }
      case 'get_friend_list':
        return (await this.bridge.getFriends()).map(item => ({
          user_id: item.id,
          nickname: item.name ?? item.id,
          remark: item.name ?? ''
        }));
      case 'get_stranger_info': {
        const user = await this.bridge.getUser(requireString(request.params, 'user_id'), booleanParam(request.params, 'no_cache'));
        return {
          user_id: user.id,
          nickname: user.name ?? user.id,
          sex: 'unknown',
          age: 0
        };
      }
      case 'get_group_list':
        return (await listDouyinGroups(this.bridge)).map(item => ({
          group_id: item.shortId ?? item.id,
          group_name: item.name ?? item.shortId ?? item.id,
          member_count: item.memberCount ?? 0,
          max_member_count: item.maxMemberCount ?? 0
        }));
      case 'get_group_info': {
        booleanParam(request.params, 'no_cache'); // This endpoint always reads fresh upstream group metadata.
        const group = await this.bridge.getGroupInfo(requireString(request.params, 'group_id'));
        return {
          group_id: group.shortId ?? group.id,
          group_name: group.name ?? '',
          member_count: group.memberCount ?? 0,
          max_member_count: group.maxMemberCount ?? 0
        };
      }
      case 'get_group_member_list':
        return (await listDouyinGroupMembers(this.bridge, requireString(request.params, 'group_id'))).map(groupMemberInfo);
      case 'get_group_member_info': {
        const groupId = requireString(request.params, 'group_id');
        const userId = requireString(request.params, 'user_id');
        const members = await this.bridge.getGroupMembers(groupId, booleanParam(request.params, 'no_cache'));
        const member = members.find(item => item.userId === userId);
        if (!member) {
          throw new Error(`Group member not found: ${groupId}/${userId}`);
        }
        return groupMemberInfo(member);
      }
      case 'get_status':
        return this.bridge.getStatus() satisfies OneBotStatus;
      case 'can_send_image':
        return { yes: true };
      case 'can_send_record':
        return { yes: false };
      case 'get_image':
        if (!this.mediaRegistry) throw new Error('Media cache is not available');
        return this.mediaRegistry.getImage(requireString(request.params, 'file'));
      case 'get_group_file_url':
      case 'get_private_file_url': {
        if (!this.mediaRegistry) throw new Error('Media cache is not available');
        const id = requireString(request.params, 'file_id');
        const cached = this.bridge.getCachedMessage(id);
        if (!cached || cached.messageType !== 150) throw new Error('File message not found in cache');
        if (request.action === 'get_group_file_url') {
          if (cached.conversationType !== 'group' || (cached.conversationShortId ?? cached.conversationId) !== requireString(request.params, 'group_id')) {
            throw new Error('File does not belong to the requested group');
          }
        } else if (cached.conversationType !== 'private') throw new Error('Not a private file');
        const message = await this.getMsg({ message_id: id }) as { message: OneBotMessageSegment[] };
        const file = message.message.find(segment => segment.type === 'file');
        if (!file || typeof file.data.url !== 'string') throw new Error('File is not available');
        return this.mediaRegistry.getFile(file.data.url);
      }
      case 'clean_cache':
        if (!this.mediaRegistry) throw new Error('Media cache is not available');
        await this.mediaRegistry.cleanCache();
        this.bridge.clearOutgoingMediaCache();
        return null;
      case 'get_version_info':
        return getVersionInfo();
      case 'set_restart':
        {
          const value = request.params?.delay ?? 0, delay = Number(value);
          if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !/^\d+$/.test(value)) || !Number.isSafeInteger(delay) || delay < 0 || delay > 2147483647) throw new Error('delay must be an integer from 0 to 2147483647 milliseconds');
          this.bridge.requestRestart(delay); return null;
        }
      default:
        throw unsupported(`Unsupported OneBot action: ${request.action}`);
    }
  }

  private forwardNode(message: DouyinMessage): Record<string, unknown> {
    const content = toOneBotMessageEvent(this.config, message).message as OneBotMessageSegment[];
    return { type: 'node', data: { user_id: message.senderId, nickname: message.senderName ?? '',
      content: content.map(segment => segment.type === 'forward' && message.forwardMessages
        ? { ...segment, data: { ...segment.data, content: message.forwardMessages.map(child => this.forwardNode(child)) } } : segment) } };
  }

  private forwardMessageEvent(message: DouyinMessage): Record<string, unknown> {
    const event = toOneBotMessageEvent(this.config, message);
    const segments = (event.message as OneBotMessageSegment[]).map(segment => segment.type === 'forward' ?
      { ...segment, data: { ...segment.data, ...(message.forwardMessages ? { content: message.forwardMessages.map(child => this.forwardMessageEvent(child)) } : {}),
        ...(message.forwardUnavailable ? { douyin_unavailable: true } : {}) } } : segment);
    return { ...event, message: segments, content: segments };
  }

  private async compatibleHistory(action: string, params: Record<string, unknown>): Promise<unknown> {
    const group = action === 'get_group_msg_history';
    const target: DouyinSendTarget = group ? { type: 'group', conversationShortId: requireNumericId(params, 'group_id') }
      : { type: 'private', userId: requireNumericId(params, 'user_id') };
    if (params.count !== undefined && !['string', 'number'].includes(typeof params.count)) throw new Error('count must be numeric');
    const count = Number(params.count ?? 20);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('count must be between 1 and 100');
    for (const key of ['reverse_order', 'reverseOrder', 'disable_get_url', 'parse_mult_msg', 'quick_reply']) {
      if (params[key] !== undefined && typeof params[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
    }
    if (params.quick_reply === true) throw unsupported('History quick_reply mode is not available; use normal history messages');
    const anchor = params.message_seq === undefined || String(params.message_seq) === '0' || params.message_seq === ''
      ? undefined : requireNumericId(params, 'message_seq');
    const newer = params.reverse_order === true || params.reverseOrder === true;
    const deadline = new ActionDeadline(this.config.runtime.actionTimeoutMs), account = this.bridge.accountId;
    return deadline.run(async () => {
      const result = await this.bridge.getHistoryFromMessage(target, anchor, count, newer, deadline);
      const messages = [...result.messages].sort((a, b) => a.timestamp - b.timestamp ||
        (BigInt(a.messageId) < BigInt(b.messageId) ? -1 : BigInt(a.messageId) > BigInt(b.messageId) ? 1 : 0));
      const output = []; let expanded = 0;
      for (const message of messages) {
        deadline.remainingMs();
        let event = toOneBotMessageEvent(this.config, message);
        if (params.disable_get_url !== true && this.mediaRegistry) {
          try { event = await this.getMsg({ message_id: message.messageId }) as typeof event; }
          catch { deadline.remainingMs(); /* Keep the explicit unavailable-media segment from history. */ }
        }
        if (message.messageType === 136 && params.parse_mult_msg !== false) {
          try {
            if (expanded >= 100) throw new Error('History forward expansion limit reached; use get_forward_msg');
            const children = await this.bridge.getForwardMessages(message.messageId, deadline, params.disable_get_url === true ? undefined : this.mediaRegistry);
            const total = (items: DouyinMessage[]): number => items.reduce((sum, item) => sum + 1 + total(item.forwardMessages ?? []), 0);
            const size = total(children);
            if (expanded + size > 100) throw new Error('History forward expansion limit reached; use get_forward_msg');
            expanded += size;
            event = { ...event, message: (event.message as OneBotMessageSegment[]).map(segment => segment.type === 'forward' ?
              { ...segment, data: { ...segment.data, content: children.map(child => this.forwardMessageEvent(child)) } } : segment) };
          } catch { deadline.remainingMs(); event = { ...event, douyin_forward_unavailable: true }; }
        }
        output.push({ ...event, message_seq: message.messageId, real_id: message.messageId });
      }
      if (this.bridge.accountId !== account) throw new Error('Account changed during history query');
      return { messages: output, has_more: result.has_more, next_cursor: result.next_cursor,
        next_message_seq: (newer ? messages.at(-1) : messages[0])?.messageId ?? null };
    });
  }

  private async setReaction(messageId: string, emoji: DouyinEmojiReaction, isAdd: boolean): Promise<{ message_id: string }> {
    const cached = this.bridge.getCachedMessage(messageId);
    if (!cached) throw new Error('Reaction target is not available in cache');
    const result = await this.bridge.sendMessage({ text: '', replyToMessageId: messageId,
      target: { type: cached.conversationType, conversationId: cached.conversationId, conversationShortId: cached.conversationShortId },
      emojiReaction: { ...emoji, operation: isAdd ? 0 : 1 } });
    return { message_id: result.messageId, ...(result.messageIds ? { message_ids: result.messageIds } : {}) };
  }

  private async quickOperation(params: Record<string, unknown>): Promise<null> {
    const context = params.context as Record<string, unknown>, operation = params.operation as Record<string, unknown>;
    if (!context || typeof context !== 'object' || Array.isArray(context) || !operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('Quick operation requires context and operation objects');
    }
    if (Object.keys(operation).length === 0) return null;
    if (context.self_id !== undefined && String(context.self_id) !== this.config.app.selfId) throw new Error('Quick operation account mismatch');
    if (context.post_type === 'request' && context.request_type === 'group') {
      if (Object.keys(operation).some(key => !['approve', 'reason'].includes(key))) throw unsupported('Unsupported group request quick operation');
      if (typeof operation.approve !== 'boolean') throw new Error('approve must be a boolean');
      await this.dispatch({ action: 'set_group_add_request', params: { flag: context.flag, sub_type: context.sub_type, ...operation } });
      return null;
    }
    if (context.post_type !== 'message' || !['private', 'group'].includes(String(context.message_type))) throw unsupported('Quick operation requires a message or supported request event');
    for (const key of Object.keys(operation)) if (!['reply', 'auto_escape', 'at_sender', 'delete', 'kick', 'ban', 'ban_duration'].includes(key)) throw unsupported(`Unsupported quick operation: ${key}`);
    for (const key of ['auto_escape', 'at_sender', 'delete', 'kick', 'ban']) if (operation[key] !== undefined && typeof operation[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
    const banDuration = operation.ban_duration ?? 1800;
    if (typeof banDuration !== 'number' || !Number.isSafeInteger(banDuration) || banDuration < 0 || banDuration > 2592000) throw new Error('Invalid ban_duration');
    if (operation.kick || operation.ban) {
      const cached = this.bridge.getCachedMessage(requireString(context, 'message_id'));
      if (context.message_type !== 'group' || !cached || cached.conversationType !== 'group' ||
        cached.conversationShortId !== String(context.group_id) || cached.senderId !== String(context.user_id)) throw new Error('Group quick operation requires the original cached message context');
    }
    let reply: Record<string, unknown> | undefined;
    if (operation.reply !== undefined) {
      reply = { ...context, message: operation.reply, auto_escape: operation.auto_escape ?? false };
      requireOutgoingMessages(reply);
      if (context.message_type === 'group' && operation.at_sender !== false) {
        const message = typeof operation.reply === 'string'
          ? operation.auto_escape ? [{ type: 'text', data: { text: operation.reply } }] : parseCqMessage(operation.reply)
          : isMessageSegment(operation.reply) ? [operation.reply] : operation.reply as OneBotMessageSegment[];
        reply.message = [{ type: 'at', data: { qq: requireString(context, 'user_id') } }, ...message];
        requireOutgoingMessages(reply);
      }
    }
    if (operation.delete === true) {
      const cached = this.bridge.getCachedMessage(requireString(context, 'message_id'));
      if (!cached || cached.senderId !== this.config.app.selfId) throw unsupported('Only the current account’s own messages can be recalled');
    }
    if (reply) await this.sendMsg(reply);
    if (operation.delete === true) await this.bridge.recallMessage(requireString(context, 'message_id'));
    if (operation.ban === true) await this.bridge.manageGroup(requireNumericId(context, 'group_id'), { kind: 'ban', userId: requireNumericId(context, 'user_id'), duration: banDuration });
    if (operation.kick === true) await this.bridge.manageGroup(requireNumericId(context, 'group_id'), { kind: 'kick', userId: requireNumericId(context, 'user_id'), rejectAddRequest: false });
    return null;
  }

  private async sendMsg(params: Record<string, unknown>): Promise<{ message_id: string }> {
    const messageType = String(params.message_type ?? '');
    if (messageType === 'group') return this.sendGroupMsg(params);
    if (messageType === 'private') return this.sendPrivateMsg(params);
    if (messageType) throw new Error(`Unsupported outgoing message_type: ${messageType}`);
    return params.group_id !== undefined ? this.sendGroupMsg(params) : this.sendPrivateMsg(params);
  }

  private async sendPrivateMsg(params: Record<string, unknown>): Promise<{ message_id: string }> {
    return this.sendOutgoing({ type: 'private', userId: requireString(params, 'user_id') }, params);
  }

  private async sendGroupMsg(params: Record<string, unknown>): Promise<{ message_id: string }> {
    return this.sendOutgoing({ type: 'group', conversationShortId: requireString(params, 'group_id') }, params);
  }

  private async sendOutgoing(target: DouyinSendTarget, params: Record<string, unknown>): Promise<{ message_id: string; message_ids?: string[] }> {
    const messages = requireOutgoingMessages(params);
    if (target.type !== 'group' && messages.some(message => message.mentions.some(mention => mention.userId === 'all'))) throw new Error('@all requires a group conversation');
    if (messages.some(message => message.file) && !this.config.runtime.fileSendEnabled) {
      throw new Error('Unsupported: ordinary file sending is experimental and disabled; native IM delivery has not passed verification');
    }
    const ids: string[] = [];
    const accountId = this.bridge.accountId;
    const deadline = new ActionDeadline(messages.some(message => message.video) ? this.config.runtime.videoSendTimeoutMs : this.config.runtime.actionTimeoutMs);
    for (const message of messages) {
      try {
        const media = this.mediaRegistry;
        const input = media ? await deadline.run(async () => ({ ...message,
          images: await Promise.all(message.images.map(file => media.resolveOutgoingMedia(file, 'image', deadline.signal))),
          video: message.video ? { ...message.video, file: await media.resolveOutgoingMedia(message.video.file, 'video', deadline.signal) } : undefined
        })) : message;
        deadline.remainingMs();
        if (this.bridge.accountId !== accountId) throw new Error('Account changed before sending; remaining messages were not sent');
        const result = await this.bridge.sendMessage({ ...input, target, operatorUserId: this.config.app.selfId }, deadline);
        ids.push(...(result.messageIds ?? [result.messageId]));
      } catch (error) {
        if (error instanceof PartialSendError) ids.push(...error.messageIds);
        if (ids.length) throw new PartialSendError(ids, error);
        throw error;
      }
    }
    return { message_id: ids.at(-1)!, ...(ids.length > 1 ? { message_ids: ids } : {}) };
  }

  private async getMsg(params: Record<string, unknown>): Promise<unknown> {
    const messageId = requireString(params, 'message_id');
    let cached = this.bridge.getCachedMessage(messageId);
    if (!cached) {
      const target: DouyinSendTarget | undefined = (params.user_id || params.group_id || params.conversation_id) ? { type: params.group_id ? 'group' : 'private',
        userId: params.user_id ? requireString(params, 'user_id') : undefined,
        conversationId: params.conversation_id ? requireString(params, 'conversation_id') : params.group_id ? requireString(params, 'group_id') : undefined }
        : this.bridge.getMessageTarget?.(messageId);
      if (target) cached = await this.bridge.fetchMessage(messageId, target);
    }
    if (!cached) {
      throw new MessageUnavailableError(messageId, '当前账号没有可用缓存或引用会话信息，请提供 user_id、group_id 或 conversation_id');
    }

    if ((cached.messageType === 150 || cached.messageType === 27) && this.mediaRegistry) {
      const segment = cached.segments?.find(segment => segment.type === (cached!.messageType === 150 ? 'file' : 'image'));
      const file = segment?.data.file ?? segment?.data.url;
      if (typeof file !== 'string' || !await this.mediaRegistry.resolveCachedUrl(file)) {
        cached = cached.messageType === 150 ? await this.bridge.receiveCachedFile(messageId, this.mediaRegistry) :
          await this.bridge.receiveCachedImage(messageId, this.mediaRegistry);
      }
    }

    if (cached.messageType === 17 && this.mediaRegistry) {
      const file = cached.segments?.find(segment => segment.type === 'record')?.data.file;
      if (typeof file !== 'string' || !await this.mediaRegistry.resolveCachedUrl(file)) {
        cached = await this.bridge.receiveCachedVoice(messageId, this.mediaRegistry);
      }
    }

    if (cached.messageType === 30 && this.mediaRegistry) {
      const video = cached.segments?.find(segment => segment.type === 'video');
      const file = video?.data.file ?? video?.data.url;
      if (typeof file !== 'string' || !await this.mediaRegistry.resolveCachedUrl(file)) {
        cached = await this.bridge.receiveCachedVideo(messageId, this.mediaRegistry);
      }
    }

    if (cached.messageType === 5 && this.mediaRegistry && !this.config.runtime.stickerAsText) {
      const image = cached.segments?.find(segment => segment.type === 'image');
      const file = image?.data.file ?? image?.data.url;
      if (typeof file !== 'string' || !await this.mediaRegistry.resolveCachedUrl(file)) {
        cached = await this.bridge.receiveCachedSticker(messageId, this.mediaRegistry);
      }
    }

    const segments = this.mediaRegistry && cached.segments && !(cached.messageType === 5 && this.config.runtime.stickerAsText) ? await Promise.all(cached.segments.map(async segment => {
      if (!['image', 'video', 'record', 'file'].includes(segment.type)) return segment;
      const file = typeof segment.data.file === 'string' ? segment.data.file : segment.data.url;
      const url = typeof file === 'string' ? await this.mediaRegistry!.resolveCachedUrl(file) : undefined;
      if (segment.type === 'file' && !url) throw new Error('File cache expired or missing');
      return url ? { ...segment, data: { ...segment.data, file: url, url } } : segment;
    })) : cached.segments;
    return {
      ...toOneBotMessageEvent(this.config, { ...cached, segments }),
      real_id: cached.messageId
    };
  }
}

function ok<T>(data: T, echo?: unknown): OneBotActionResponse<T> {
  return {
    status: 'ok',
    retcode: 0,
    data,
    echo
  };
}

function failed(message: string, echo?: unknown): OneBotActionResponse {
  return {
    status: 'failed',
    retcode: message.startsWith('Unsupported') ? 1404 : 10003,
    data: null,
    message,
    wording: message,
    echo
  };
}

function groupMemberInfo(member: DouyinGroupMember): Record<string, unknown> {
  // QQ-only fields have documented neutral values; never invent platform profile facts.
  return { group_id: member.groupId, user_id: member.userId, nickname: member.nickname ?? member.userId,
    card: member.card ?? '', sex: 'unknown', age: 0, area: '', join_time: 0, last_sent_time: 0,
    level: '', role: member.role ?? 'member', unfriendly: false, title: '', title_expire_time: 0,
    card_changeable: false };
}

function unsupported(message: string): Error {
  return new Error(`Unsupported: ${message}`);
}

function booleanParam(params: Record<string, unknown> | undefined, key: string, fallback = false): boolean {
  const value = params?.[key];
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value === undefined ? fallback : value;
}

function requireString(params: unknown, key: string): string {
  if (typeof params !== 'object' || params === null) {
    throw new Error(`Missing required param: ${key}`);
  }

  const value = (params as Record<string, unknown>)[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required param: ${key}`);
  }

  return String(value);
}

function requireNumericId(params: Record<string, unknown> | undefined, key: string): string {
  const raw = params?.[key];
  const value = isLosslessNumber(raw) ? raw.toString() : raw;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${key} must be a positive safe integer; send large IDs as strings`);
  }
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,18}$/.test(String(value)) ||
      BigInt(value) > 9223372036854775807n) {
    throw new Error(`${key} must be a positive numeric ID within int64 range`);
  }
  return String(value);
}

function requireOutgoingMessages(params: Record<string, unknown>): OutgoingMessage[] {
  if (typeof params.message === 'string' && params.auto_escape !== undefined && typeof params.auto_escape !== 'boolean') {
    throw new Error('auto_escape must be a boolean for string messages');
  }
  const source = typeof params.message === 'string' && params.auto_escape !== true ? parseCqMessage(params.message)
    : isMessageSegment(params.message) ? [params.message] : params.message;
  if (!Array.isArray(source)) return [requireOutgoingMessage(params)];
  if (!source.every(isMessageSegment) || source.length > 100) throw new Error('Invalid message segments or more than 100 segments');
  const segments = (source as OneBotMessageSegment[]).map(s => s.type === 'json' || s.type === 'xml' ? unpackCardEnvelope(s.type, s.data.data) : s);
  const replies = segments.filter(s => s.type === 'reply');
  if (replies.length > 1) throw new Error('Message cannot contain multiple reply segments');
  const body = segments.filter(s => s.type !== 'reply');
  const media = new Set(['image', 'file', 'video', 'share', 'sticker', 'contact', 'location', 'music', 'forward', 'rps', 'dice']);
  if (body.some(s => s.type === 'node') && !body.every(s => s.type === 'node')) throw new Error('Forward nodes cannot be mixed with other messages');
  const mixed = body.some(s => media.has(s.type)) && body.length > 1;
  if (!mixed) return [requireOutgoingMessage({ ...params, message: [...replies, ...body] })];
  if (body.some(s => s.data.mode === 'reaction' || s.data.key !== undefined || s.data.emoji_key !== undefined)) {
    throw new Error('Emoji reaction cannot be mixed with media');
  }
  const parts: OneBotMessageSegment[][] = []; let text: OneBotMessageSegment[] = [];
  const flush = () => { if (text.length) { parts.push(text); text = []; } };
  for (const segment of body) {
    if (media.has(segment.type)) { flush(); parts.push([segment]); }
    else text.push(['emoji', 'face'].includes(segment.type) ? { ...segment, data: { ...segment.data, mode: 'message' } } : segment);
  }
  flush();
  // Validate every segment before any upload or send. Actual messages retain input order.
  return parts.map(part => requireOutgoingMessage({ ...params, message: [...replies, ...part] }));
}

function requireOutgoingMessage(params: Record<string, unknown>): OutgoingMessage {
  let message = params.message;
  if (typeof message === 'string') {
    if (!message) {
      throw new Error('Message must contain text or image');
    }
    if (params.auto_escape !== undefined && typeof params.auto_escape !== 'boolean') {
      throw new Error('auto_escape must be a boolean for string messages');
    }
    message = params.auto_escape === true ? [{ type: 'text', data: { text: message } }] : parseCqMessage(message);
  }

  if (!Array.isArray(message)) {
    throw new Error('Message must be a string or OneBot message segment array');
  }

  const out: OutgoingMessage = {
    text: '',
    emojiTokens: [],
    images: [],
    mentions: []
  };
  if (!message.every(isMessageSegment)) throw new Error('Invalid OneBot message segment');
  const segments = message as OneBotMessageSegment[];
  const nodes = segments.filter(s => s.type !== 'reply');
  if (nodes.length && nodes.every(s => s.type === 'node')) {
    out.forward = { messageIds: nodes.map(s => {
      if (Object.keys(s.data).some(k => k !== 'id')) throw new Error('Custom forward authors/content are unsupported; use existing node.id');
      return nativeSourceId(s.data.id);
    }) };
    if (new Set(out.forward.messageIds).size !== nodes.length) throw new Error('Forward cannot contain duplicate message IDs');
    const reply = segments.find(s => s.type === 'reply'); if (reply) out.replyToMessageId = nativeSourceId(reply.data.id ?? reply.data.message_id);
    return out;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (['rps', 'dice'].includes(segment.type)) {
      if (segments.filter(s => s.type !== 'reply').length !== 1 || Object.keys(segment.data).length) throw new Error('Interactive emoji requires a single parameterless segment');
      out.interactive = segment.type as 'dice' | 'rps'; return out;
    }
    if (['location', 'contact', 'music', 'forward'].includes(segment.type)) {
      if (segments.filter(s => s.type !== 'reply').length !== 1) throw new Error('Card must be sent as a single segment');
      if (segment.type === 'location') out.location = locationInput(segment.data);
      if (segment.type === 'contact') {
        if (!['qq', 'douyin', 'group'].includes(String(segment.data.type))) throw new Error('Unsupported contact type');
        out.contact = segment.data.type === 'group' ? { groupId: nativeSourceId(segment.data.id) } : { userId: nativeSourceId(segment.data.id) };
      }
      if (segment.type === 'music') {
        if (segment.data.type !== 'douyin' || segment.data.douyin_source_message_id === undefined) throw new Error('Music currently requires type=douyin and a cached douyin_source_message_id; external music IDs have no Douyin mapping');
        out.music = { sourceMessageId: nativeSourceId(segment.data.douyin_source_message_id) };
      }
      if (segment.type === 'forward') out.forward = { sourceMessageId: nativeSourceId(segment.data.id) };
      return out;
    }
    if (segment.type === 'share') {
      if (segments.filter(s => s.type !== 'reply').length !== 1) throw new Error('Share must be sent as a single segment');
      out.share = outgoingShare(segment.data);
      return out;
    }
    if (segment.type === 'sticker' || (segment.type === 'image' &&
        ['douyin_source_message_id', 'douyin_image_id', 'douyin_emoji_id', 'douyin_package_id'].some(key => segment.data[key] !== undefined))) {
      if (segments.filter(s => s.type !== 'reply').length !== 1) throw new Error('Native sticker must be sent as a single segment');
      if (segment.data.douyin_catalog_id !== undefined) {
        if (segment.data.douyin_source_message_id !== undefined || typeof segment.data.douyin_catalog_id !== 'string' ||
            !/^[0-9a-f-]{36}$/.test(segment.data.douyin_catalog_id)) throw new Error('Invalid or conflicting sticker catalog ID');
        out.sticker = { catalogId: segment.data.douyin_catalog_id };
      } else out.sticker = { sourceMessageId: nativeSourceId(segment.data.douyin_source_message_id) };
      return out;
    }
    if (segment.type === 'text') {
      if (typeof segment.data.text !== 'string') throw new Error('Text segment must contain a string text');
      out.text += segment.data.text;
      continue;
    }
    if (segment.type === 'at') {
      const userId = String(segment.data.qq ?? segment.data.user_id ?? segment.data.id ?? '');
      if (!userId || (userId !== 'all' && !/^[1-9]\d{0,18}$/.test(userId))) {
        throw new Error(`Unsupported outgoing at target: ${userId || '(empty)'}`);
      }

      const name = userId === 'all' ? '所有人' : String(segment.data.name ?? segment.data.nickname ?? userId);
      const next = segments[index + 1];
      const nextText = next?.type === 'text' ? String(next.data.text ?? '') : '';
      const display = nextText.startsWith(' ') || nextText.startsWith('\u3000') ? `@${name}` : `@${name} `;
      const location = out.text.length;
      out.text += display;
      out.mentions.push({
        userId,
        name,
        location,
        length: display.length
      });
      continue;
    }
    if (segment.type === 'image') {
      const file = segment.data.file;
      if (typeof file === 'string' && file) {
        out.images.push(file);
        (out.imageOptions ??= []).push(mediaDownloadOptions(segment.data));
      } else throw new Error('Image segment must contain a non-empty file');
      continue;
    }
    if (segment.type === 'file') {
      if (out.file) throw new Error('Message can contain only one file');
      const file = segment.data.file ?? segment.data.url;
      const name = segment.data.name ?? segment.data.file_name;
      if (typeof file !== 'string' || !file) throw new Error('File segment must contain a non-empty file or url');
      if (name !== undefined && (typeof name !== 'string' || !name)) throw new Error('File name must be a non-empty string');
      out.file = { file, ...(name === undefined ? {} : { name: name as string }) };
      continue;
    }
    if (segment.type === 'video') {
      if (out.video) throw new Error('Message can contain only one video');
      const file = segment.data.file ?? segment.data.url;
      if (typeof file !== 'string' || !file) throw new Error('Video segment must contain a non-empty file or url');
      out.video = { file, download: mediaDownloadOptions(segment.data) };
      continue;
    }
    if (segment.type === 'reply') {
      const messageId = segment.data.id ?? segment.data.message_id;
      if (messageId !== undefined && messageId !== null && messageId !== '') {
        if (out.replyToMessageId) throw new Error('Message cannot contain multiple reply segments');
        out.replyToMessageId = String(messageId);
      } else throw new Error('Reply segment must contain a message id');
      continue;
    }
    if (segment.type === 'face' || segment.type === 'emoji') {
      const mode = segment.data.mode;
      if (mode !== undefined && mode !== 'message' && mode !== 'reaction') throw new Error('Emoji mode must be message or reaction');
      if (mode === 'reaction' || (mode !== 'message' && (segment.data.key !== undefined || segment.data.emoji_key !== undefined))) {
        if (out.emojiReaction) throw new Error('Message cannot contain multiple emoji reactions');
        out.emojiReaction = resolveEmojiReaction(segment);
      } else {
        const token = outgoingEmojiToken(segment);
        out.text += token;
        out.emojiTokens.push(token);
      }
      continue;
    }

    throw new Error(`Unsupported outgoing message segment: ${segment.type}`);
  }

  if (out.video) {
    if (segments.filter(s => s.type !== 'reply').length !== 1) throw new Error('Video must be sent as a single segment, without text, image, at, reply, file, or emoji');
    return out;
  }
  if (out.file) {
    if (segments.filter(s => s.type !== 'reply').length !== 1) throw new Error('File must be sent as a single segment, without text, image, at, reply, or emoji');
    return out;
  }

  if (out.emojiReaction) {
    if (!out.replyToMessageId) {
      throw new Error('Emoji reaction must include a reply segment with target message id');
    }
    if (out.text || out.images.length > 0 || out.mentions.length > 0) {
      throw new Error('Emoji reaction cannot be mixed with text, image, or at segments');
    }
    return out;
  }

  if (!out.text && out.images.length === 0) {
    throw new Error('Message must contain text, image, or reply+face/emoji');
  }
  return out;
}

function outgoingShare(data: OneBotMessageSegment['data']): DouyinShareSendInput {
  if (data.douyin_resolve !== undefined && typeof data.douyin_resolve !== 'boolean') throw new Error('douyin_resolve must be a boolean');
  if (data.douyin_resolve === true) {
    if (typeof data.url !== 'string' || data.url.length > 16384 || data.douyin_source_message_id !== undefined) throw new Error('Share resolution requires a URL');
    return { resolveUrl: data.url };
  }
  if (data.douyin_source_message_id !== undefined) return { sourceMessageId: nativeSourceId(data.douyin_source_message_id) };
  const kind = data.douyin_share_type ?? 'web';
  if (kind !== 'web' && kind !== 'aweme' && kind !== 'photos' && kind !== 'user') throw new Error('Unsupported douyin_share_type');
  const optionalText = (key: string) => {
    const value = data[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`${key} must be a string`);
    return value;
  };
  const input: Exclude<DouyinShareSendInput, { sourceMessageId: string } | { resolveUrl: string }> = { kind, url: optionalText('url') ?? '', title: optionalText('title') ?? '',
    description: optionalText('content'), image: optionalText('image'),
    userId: data.douyin_user_id === undefined ? undefined : numericId(data.douyin_user_id, 'douyin_user_id'),
    authorName: optionalText('douyin_author_name'), secUid: optionalText('douyin_sec_uid'),
    imageCount: data.douyin_image_count === undefined ? undefined :
      /^(?:[1-9]\d*)$/.test(String(data.douyin_image_count)) ? Number(data.douyin_image_count) : NaN };
  const content = buildShareContent(input);
  if (data.douyin_aweme_id !== undefined && (kind === 'aweme' || kind === 'photos') &&
      numericId(data.douyin_aweme_id, 'douyin_aweme_id') !== JSON.parse(content.content).itemId) {
    throw new Error('douyin_aweme_id does not match the share URL');
  }
  return input;
}

function resolveEmojiReaction(segment: OneBotMessageSegment): DouyinEmojiReaction {
  const customKey = stringValue(segment.data.key ?? segment.data.emoji_key);
  const customIconUrl = stringValue(segment.data.icon_url ?? segment.data.iconUrl);
  const customText = stringValue(segment.data.text ?? segment.data.name);
  const customPropertyValue = stringValue(segment.data.value ?? segment.data.property_value ?? segment.data.propertyValue, true);
  if (customKey && customPropertyValue !== undefined) {
    return {
      key: customKey.startsWith('e:') || customKey.startsWith('se:') ? customKey : `e:${customKey}`,
      propertyValue: customPropertyValue
    };
  }
  if (customKey && customIconUrl && customText) {
    return {
      key: customKey.startsWith('e:') || customKey.startsWith('se:') ? customKey : `e:${customKey}`,
      iconUrl: customIconUrl,
      text: customText
    };
  }

  const id = String(segment.data.id ?? segment.data.face_id ?? segment.data.name ?? segment.data.text ?? '').trim();
  const normalized = id.replace(/^e:/, '').toLowerCase();
  if (['ok', '[ok]', '👌'].includes(normalized)) {
    return {
      key: 'se:[OK]',
      propertyValue: ''
    };
  }

  if (['捂脸', '[捂脸]', 'facepalm', 'tearsofjoy'].includes(normalized)) {
    return { key: 'se:[捂脸]', propertyValue: '', additionalProperties: [{ key: 'e:tearsofjoy', value: '' }] };
  }

  if (['love', 'heart', '爱心', '[爱心]', '\u2764\ufe0f'].includes(normalized) || (segment.type === 'face' && normalized === '66')) {
    return {
      key: 'e:love',
      iconUrl: 'https://p6.douyinpic.com/aweme-client-static-resource/single_msg_emoji_love_1588747335.png~tplv-obj.image',
      text: '\u2764\ufe0f'
    };
  }

  const token = outgoingEmojiToken(segment);
  return { key: `se:${token}`, propertyValue: '' };
}

function stringValue(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value === 'string' && (allowEmpty || value)) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

function isMessageSegment(value: unknown): value is OneBotMessageSegment {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as OneBotMessageSegment).type === 'string' &&
    typeof (value as OneBotMessageSegment).data === 'object' &&
    (value as OneBotMessageSegment).data !== null &&
    !Array.isArray((value as OneBotMessageSegment).data)
  );
}
