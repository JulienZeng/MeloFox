import type { AppConfig } from '../config/index.js';
import type { DouyinMessage, DouyinRecall } from '../douyin/types.js';
import { parseDouyinShare, shareMessageSegment } from '../douyin/share.js';
import { parseDouyinSticker, stickerSegment, stickerText } from '../douyin/sticker.js';
import { textSegment } from './message-segment.js';
import { serializeCqMessage } from './cq.js';
import type { OneBotEvent, OneBotMessageSegment } from './types.js';

export function toOneBotMessageEvent(config: AppConfig, message: DouyinMessage): OneBotEvent {
  const isGroup = message.conversationType === 'group';
  const segments = toOneBotMessageSegments(message, config.runtime.shareAsText, config.runtime.stickerAsText);
  return removeUndefined({
    time: Math.floor(message.timestamp / 1000),
    self_id: config.app.selfId,
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    message_id: message.messageId,
    user_id: message.senderId,
    group_id: isGroup ? message.conversationShortId ?? message.conversationId : undefined,
    raw_message: serializeCqMessage(segments),
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

export function toOneBotMessageSegments(message: DouyinMessage, shareAsText = false, stickerAsText = true): OneBotMessageSegment[] {
  if (message.messageType === 5 && stickerAsText) return [
    ...(message.segments?.filter(segment => segment.type === 'reply') ?? []),
    textSegment(stickerText(parseDouyinSticker(message.content, 5)))
  ];
  // Reparse card content so restored caches also benefit from protocol fixes, without replaying events.
  const share = parseDouyinShare(message.content, message.messageType);
  let segments = share ? [...(message.segments?.filter(segment => segment.type === 'reply') ?? []), shareMessageSegment(share)]
    : message.segments?.length ? message.segments : [textSegment(message.text ?? '')];
  const sticker = parseDouyinSticker(message.content, message.messageType);
  if (sticker) segments = segments.map(segment => {
    const file = segment.data.file ?? segment.data.url;
    return segment.type === 'image' && typeof file === 'string'
      ? { ...segment, data: { ...segment.data, ...stickerSegment(sticker, file).data } } : segment;
  });
  if (!shareAsText) return segments;
  return segments.map(segment => segment.type === 'share' ? textSegment(
    [segment.data.title, segment.data.content, segment.data.url].filter(value => typeof value === 'string' && value).join('\n')
  ) : segment);
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
