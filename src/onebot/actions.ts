import type { AppConfig } from '../config/index.js';
import { isLosslessNumber } from 'lossless-json';
import { listDouyinGroupMembers, listDouyinGroups } from '../douyin/conversation.js';
import type { DouyinBridge } from '../douyin/bridge.js';
import type { MediaRegistry } from '../media/registry.js';
import { toOneBotMessageEvent } from './events.js';
import { parseCqMessage } from './cq.js';
import { outgoingEmojiToken, qqFaceNames } from '../douyin/emoji.js';
import type { DouyinEmojiReaction } from '../douyin/types.js';
import type { OneBotActionRequest, OneBotActionResponse, OneBotMessageSegment, OneBotStatus } from './types.js';

interface OutgoingMessage {
  text: string;
  emojiTokens: string[];
  images: string[];
  file?: { file: string; name?: string };
  video?: { file: string };
  mentions: Array<{
    userId: string;
    name?: string;
    location: number;
    length: number;
  }>;
  replyToMessageId?: string;
  emojiReaction?: DouyinEmojiReaction;
}

export class OneBotActionRouter {
  constructor(
    private readonly config: AppConfig,
    private readonly bridge: DouyinBridge,
    private readonly mediaRegistry?: MediaRegistry
  ) {}

  async handle(request: OneBotActionRequest): Promise<OneBotActionResponse> {
    try {
      const data = await this.dispatch(request);
      return ok(data, request.echo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failed(message, request.echo);
    }
  }

  private async dispatch(request: OneBotActionRequest): Promise<unknown> {
    switch (request.action) {
      case 'send_msg':
        return this.sendMsg(request.params ?? {});
      case 'send_private_msg':
        return this.sendPrivateMsg(request.params ?? {});
      case 'send_group_msg':
        return this.sendGroupMsg(request.params ?? {});
      case 'get_msg':
        return this.getMsg(request.params ?? {});
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
        const user = await this.bridge.getUser(requireString(request.params, 'user_id'), request.params?.no_cache === true);
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
        const group = await this.bridge.getGroupInfo(requireString(request.params, 'group_id'));
        return {
          group_id: group.shortId ?? group.id,
          group_name: group.name ?? '',
          member_count: group.memberCount ?? 0,
          max_member_count: group.maxMemberCount ?? 0
        };
      }
      case 'get_group_member_list':
        return (await listDouyinGroupMembers(this.bridge, requireString(request.params, 'group_id'))).map(item => ({
          group_id: item.groupId,
          user_id: item.userId,
          nickname: item.nickname ?? item.userId,
          card: item.card ?? '',
          role: item.role ?? 'member'
        }));
      case 'get_group_member_info': {
        const groupId = requireString(request.params, 'group_id');
        const userId = requireString(request.params, 'user_id');
        const members = await this.bridge.getGroupMembers(groupId, request.params?.no_cache === true);
        const member = members.find(item => item.userId === userId);
        if (!member) {
          throw new Error(`Group member not found: ${groupId}/${userId}`);
        }
        return {
          group_id: member.groupId,
          user_id: member.userId,
          nickname: member.nickname ?? member.userId,
          card: member.card ?? '',
          role: member.role ?? 'member'
        };
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
        return null;
      case 'get_version_info':
        return {
          app_name: 'douyin-onebot',
          app_version: '0.1.0',
          protocol_version: '11'
        };
      case 'set_restart':
        throw unsupported('set_restart is intentionally not implemented; restart the process with a supervisor');
      default:
        throw unsupported(`Unsupported OneBot action: ${request.action}`);
    }
  }

  private async setReaction(messageId: string, emoji: DouyinEmojiReaction, isAdd: boolean): Promise<{ message_id: string }> {
    const cached = this.bridge.getCachedMessage(messageId);
    if (!cached) throw new Error('Reaction target is not available in cache');
    const result = await this.bridge.sendMessage({ text: '', replyToMessageId: messageId,
      target: { type: cached.conversationType, conversationId: cached.conversationId, conversationShortId: cached.conversationShortId },
      emojiReaction: { ...emoji, operation: isAdd ? 0 : 1 } });
    return { message_id: result.messageId };
  }

  private async sendMsg(params: Record<string, unknown>): Promise<{ message_id: string }> {
    const messageType = String(params.message_type ?? '');
    if (messageType === 'group') return this.sendGroupMsg(params);
    if (messageType === 'private') return this.sendPrivateMsg(params);
    if (messageType) throw new Error(`Unsupported outgoing message_type: ${messageType}`);
    return params.group_id !== undefined ? this.sendGroupMsg(params) : this.sendPrivateMsg(params);
  }

  private async sendPrivateMsg(params: Record<string, unknown>): Promise<{ message_id: string }> {
    const userId = requireString(params, 'user_id');
    const message = requireOutgoingMessage(params);
    if (message.file && !this.config.runtime.fileSendEnabled) throw new Error('Unsupported: ordinary file sending is experimental and disabled; native IM delivery has not passed verification');
    const result = await this.bridge.sendMessage({
      target: {
        type: 'private',
        userId
      },
      text: message.text,
      emojiTokens: message.emojiTokens,
      images: message.images,
      file: message.file,
      video: message.video,
      mentions: message.mentions,
      replyToMessageId: message.replyToMessageId,
      emojiReaction: message.emojiReaction,
      operatorUserId: this.config.app.selfId
    });

    return { message_id: result.messageId };
  }

  private async sendGroupMsg(params: Record<string, unknown>): Promise<{ message_id: string }> {
    const groupId = requireString(params, 'group_id');
    const message = requireOutgoingMessage(params);
    if (message.file && !this.config.runtime.fileSendEnabled) throw new Error('Unsupported: ordinary file sending is experimental and disabled; native IM delivery has not passed verification');
    const result = await this.bridge.sendMessage({
      target: {
        type: 'group',
        conversationShortId: groupId
      },
      text: message.text,
      emojiTokens: message.emojiTokens,
      images: message.images,
      file: message.file,
      video: message.video,
      mentions: message.mentions,
      replyToMessageId: message.replyToMessageId,
      emojiReaction: message.emojiReaction,
      operatorUserId: this.config.app.selfId
    });

    return { message_id: result.messageId };
  }

  private async getMsg(params: Record<string, unknown>): Promise<unknown> {
    const messageId = requireString(params, 'message_id');
    let cached = this.bridge.getCachedMessage(messageId);
    if (!cached) {
      throw new Error(`Message not found in cache: ${messageId}`);
    }

    if (cached.messageType === 150 && this.mediaRegistry && !cached.segments?.some(segment => segment.type === 'file')) {
      cached = await this.bridge.receiveCachedFile(messageId, this.mediaRegistry);
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

function unsupported(message: string): Error {
  return new Error(`Unsupported: ${message}`);
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
  const legacyReaction = segments.some(segment => segment.type === 'reply')
    && segments.every(segment => ['reply', 'face', 'emoji'].includes(segment.type) && segment.data.mode !== 'message');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.type === 'text') {
      if (typeof segment.data.text !== 'string') throw new Error('Text segment must contain a string text');
      out.text += segment.data.text;
      continue;
    }
    if (segment.type === 'at') {
      const userId = String(segment.data.qq ?? segment.data.user_id ?? segment.data.id ?? '');
      if (!userId || userId === 'all') {
        throw new Error(`Unsupported outgoing at target: ${userId || '(empty)'}`);
      }

      const name = String(segment.data.name ?? segment.data.nickname ?? userId);
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
      out.video = { file };
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
      if (mode === 'reaction' || (mode !== 'message' && (legacyReaction || segment.data.key !== undefined || segment.data.emoji_key !== undefined))) {
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
    if (segments.length !== 1) throw new Error('Video must be sent as a single segment, without text, image, at, reply, file, or emoji');
    return out;
  }
  if (out.file) {
    if (segments.length !== 1) throw new Error('File must be sent as a single segment, without text, image, at, reply, or emoji');
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
