import type { AppConfig } from '../config/index.js';
import type { DouyinMessage, DouyinRecall } from '../douyin/types.js';
import { textSegment } from './message-segment.js';
import type { OneBotEvent, OneBotMessageSegment } from './types.js';

export function toOneBotMessageEvent(config: AppConfig, message: DouyinMessage): OneBotEvent {
  const isGroup = message.conversationType === 'group';
  const segments = message.segments?.length ? message.segments : [textSegment(message.text ?? '')];
  return removeUndefined({
    time: Math.floor(message.timestamp / 1000),
    self_id: config.app.selfId,
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    message_id: message.messageId,
    user_id: message.senderId,
    group_id: isGroup ? message.conversationShortId ?? message.conversationId : undefined,
    raw_message: message.text ?? '',
    message: segments,
    font: 0,
    sender: {
      user_id: message.senderId,
      nickname: message.senderName ?? ''
    },
    platform: 'douyin',
    douyin_message_type: message.messageType,
    raw_event: message.raw
  });
}

export function toOneBotMessageSegments(message: DouyinMessage): OneBotMessageSegment[] {
  return message.segments?.length ? message.segments : [textSegment(message.text ?? '')];
}

export function toOneBotRecallEvent(config: AppConfig, notice: DouyinRecall): OneBotEvent {
  const isGroup = notice.conversationType === 'group';
  return removeUndefined({
    time: Math.floor(notice.timestamp / 1000), self_id: config.app.selfId,
    post_type: 'notice', notice_type: isGroup ? 'group_recall' : 'friend_recall',
    group_id: isGroup ? notice.conversationShortId : undefined,
    user_id: isGroup ? notice.senderId : notice.peerUserId,
    operator_id: notice.operatorId,
    message_id: notice.messageId,
    platform: 'douyin', raw_event: notice.raw
  });
}

export function lifecycleEvent(config: AppConfig, subType: 'connect' | 'enable' | 'disable'): OneBotEvent {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: config.app.selfId,
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    sub_type: subType
  };
}

export function heartbeatEvent(config: AppConfig, status: { online: boolean; good: boolean }): OneBotEvent {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: config.app.selfId,
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status,
    interval: config.runtime.heartbeatIntervalMs
  };
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
