import type { AppConfig } from '../config/index.js';
import { listDouyinFriends, listDouyinGroupMembers, listDouyinGroups } from '../douyin/conversation.js';
import type { DouyinBridge } from '../douyin/bridge.js';
import { textSegment } from './message-segment.js';
import type { OneBotActionRequest, OneBotActionResponse, OneBotMessageSegment, OneBotStatus } from './types.js';

interface OutgoingMessage {
  text: string;
  images: string[];
  mentions: Array<{
    userId: string;
    name?: string;
    location: number;
    length: number;
  }>;
  replyToMessageId?: string;
  emojiReaction?: {
    key: string;
    iconUrl?: string;
    text?: string;
    propertyValue?: string;
  };
}

export class OneBotActionRouter {
  constructor(
    private readonly config: AppConfig,
    private readonly bridge: DouyinBridge
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
      case 'delete_msg':
        throw unsupported('delete_msg is not supported until a reliable Douyin revoke entry is found');
      case 'get_login_info':
        return {
          user_id: this.config.app.selfId,
          nickname: 'Douyin OneBot'
        };
      case 'get_friend_list':
        return (await listDouyinFriends(this.bridge)).map(item => ({
          user_id: item.id,
          nickname: item.name ?? item.id,
          remark: item.name ?? ''
        }));
      case 'get_group_list':
        return (await listDouyinGroups(this.bridge)).map(item => ({
          group_id: item.shortId ?? item.id,
          group_name: item.name ?? item.shortId ?? item.id,
          member_count: item.memberCount ?? 0,
          max_member_count: 0
        }));
      case 'get_group_member_list':
        return (await listDouyinGroupMembers(this.bridge, requireString(request.params, 'group_id'))).map(item => ({
          group_id: item.groupId,
          user_id: item.userId,
          nickname: item.nickname ?? item.userId,
          card: item.card ?? item.nickname ?? '',
          role: 'member'
        }));
      case 'get_group_member_info': {
        const groupId = requireString(request.params, 'group_id');
        const userId = requireString(request.params, 'user_id');
        const members = await listDouyinGroupMembers(this.bridge, groupId);
        const member = members.find(item => item.userId === userId);
        if (!member) {
          throw new Error(`Group member not found: ${groupId}/${userId}`);
        }
        return {
          group_id: member.groupId,
          user_id: member.userId,
          nickname: member.nickname ?? member.userId,
          card: member.card ?? member.nickname ?? '',
          role: 'member'
        };
      }
      case 'get_status':
        return {
          online: true,
          good: true
        } satisfies OneBotStatus;
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

  private async sendMsg(params: Record<string, unknown>): Promise<{ message_id: string }> {
    const messageType = String(params.message_type ?? '');
    if (messageType === 'group' || params.group_id !== undefined) {
      return this.sendGroupMsg(params);
    }
    return this.sendPrivateMsg(params);
  }

  private async sendPrivateMsg(params: Record<string, unknown>): Promise<{ message_id: string }> {
    const userId = requireString(params, 'user_id');
    const message = requireOutgoingMessage(params);
    const result = await this.bridge.sendMessage({
      target: {
        type: 'private',
        userId
      },
      text: message.text,
      images: message.images,
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
    const result = await this.bridge.sendMessage({
      target: {
        type: 'group',
        conversationShortId: groupId
      },
      text: message.text,
      images: message.images,
      mentions: message.mentions,
      replyToMessageId: message.replyToMessageId,
      emojiReaction: message.emojiReaction,
      operatorUserId: this.config.app.selfId
    });

    return { message_id: result.messageId };
  }

  private getMsg(params: Record<string, unknown>): unknown {
    const messageId = requireString(params, 'message_id');
    const cached = this.bridge.getCachedMessage(messageId);
    if (!cached) {
      throw new Error(`Message not found in cache: ${messageId}`);
    }

    return {
      message_id: cached.messageId,
      real_id: cached.messageId,
      sender: {
        user_id: cached.senderId,
        nickname: cached.senderName ?? ''
      },
      time: Math.floor(cached.timestamp / 1000),
      message: cached.segments?.length ? cached.segments : [textSegment(cached.text ?? '')],
      raw_message: cached.text ?? ''
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

function requireOutgoingMessage(params: Record<string, unknown>): OutgoingMessage {
  const message = params.message;
  if (typeof message === 'string') {
    if (!message) {
      throw new Error('Message must contain text or image');
    }
    return {
      text: message,
      images: [],
      mentions: []
    };
  }

  if (!Array.isArray(message)) {
    throw new Error('Message must be a string or OneBot message segment array');
  }

  const out: OutgoingMessage = {
    text: '',
    images: [],
    mentions: []
  };
  const segments = message.filter(isMessageSegment);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!isMessageSegment(segment)) {
      continue;
    }

    if (segment.type === 'text') {
      out.text += String(segment.data.text ?? '');
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
      }
      continue;
    }
    if (segment.type === 'reply') {
      const messageId = segment.data.id ?? segment.data.message_id;
      if (messageId !== undefined && messageId !== null && messageId !== '') {
        out.replyToMessageId = String(messageId);
      }
      continue;
    }
    if (segment.type === 'face' || segment.type === 'emoji') {
      out.emojiReaction = resolveEmojiReaction(segment);
      continue;
    }

    throw new Error(`Unsupported outgoing message segment: ${segment.type}`);
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

function resolveEmojiReaction(segment: OneBotMessageSegment): { key: string; iconUrl?: string; text?: string; propertyValue?: string } {
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

  if (['love', 'heart', '爱心', '\u2764\ufe0f', '66'].includes(normalized)) {
    return {
      key: 'e:love',
      iconUrl: 'https://p6.douyinpic.com/aweme-client-static-resource/single_msg_emoji_love_1588747335.png~tplv-obj.image',
      text: '\u2764\ufe0f'
    };
  }

  throw new Error(`Unsupported Douyin emoji reaction: ${id || '(empty)'}`);
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
    (value as OneBotMessageSegment).data !== null
  );
}
