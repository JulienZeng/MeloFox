import type { AppConfig } from '../config/index.js';
import { listDouyinFriends, listDouyinGroupMembers, listDouyinGroups } from '../douyin/conversation.js';
import type { DouyinBridge } from '../douyin/bridge.js';
import { extractPlainText, textSegment } from './message-segment.js';
import type { OneBotActionRequest, OneBotActionResponse, OneBotStatus } from './types.js';

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
    const text = requireMessageText(params);
    const result = await this.bridge.sendMessage({
      target: {
        type: 'private',
        userId
      },
      text
    });

    return { message_id: result.messageId };
  }

  private async sendGroupMsg(params: Record<string, unknown>): Promise<{ message_id: string }> {
    const groupId = requireString(params, 'group_id');
    const text = requireMessageText(params);
    const result = await this.bridge.sendMessage({
      target: {
        type: 'group',
        conversationShortId: groupId
      },
      text
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

function requireMessageText(params: Record<string, unknown>): string {
  const text = extractPlainText(params.message);
  if (!text) {
    throw new Error('Only non-empty text messages are supported in the current Douyin bridge');
  }
  return text;
}
