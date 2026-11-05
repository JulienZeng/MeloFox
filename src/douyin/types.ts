import type { MediaDownloadOptions } from '../media/outgoing.js';
import type { DouyinShareSendInput } from './native-message.js';

export type DouyinConversationType = 'private' | 'group';

export interface DouyinUser {
  id: string;
  name?: string;
  avatar?: string;
  secUid?: string;
}

export interface DouyinConversation {
  id: string;
  shortId?: string;
  type: DouyinConversationType;
  name?: string;
  memberCount?: number;
  maxMemberCount?: number;
  peerUserId?: string;
  inboxType?: number;
  ownerId?: string;
  icon?: string;
  selfRole?: number;
  participants?: DouyinGroupMember[];
  raw?: unknown;
}

export interface DouyinMessage {
  messageId: string;
  conversationId: string;
  conversationShortId?: string;
  conversationType: DouyinConversationType;
  senderId: string;
  senderName?: string;
  senderCard?: string;
  senderRole?: 'owner' | 'admin' | 'member';
  messageType?: number;
  clientMessageId?: string;
  forwardMessages?: DouyinMessage[];
  forwardUnavailable?: boolean;
  content?: string;
  text?: string;
  segments?: Array<{
    type: string;
    data: Record<string, string | number | boolean | undefined>;
  }>;
  timestamp: number;
  raw: unknown;
}

export interface DouyinSendTarget {
  conversationId?: string;
  conversationShortId?: string;
  userId?: string;
  type: DouyinConversationType;
  inboxType?: number;
}

export interface DouyinRecall {
  messageId: string;
  conversationId: string;
  conversationShortId: string;
  conversationType: DouyinConversationType;
  senderId?: string;
  peerUserId?: string;
  operatorId: string;
  timestamp: number;
  raw: unknown;
}

export interface DouyinSendMessageInput {
  target: DouyinSendTarget;
  text: string;
  emojiTokens?: string[];
  images?: string[];
  imageOptions?: MediaDownloadOptions[];
  file?: { file: string; name?: string };
  video?: { file: string; download?: MediaDownloadOptions };
  share?: DouyinShareSendInput;
  location?: import('./card-compat.js').LocationInput;
  contact?: { userId: string } | { groupId: string };
  music?: { sourceMessageId: string };
  interactive?: 'dice' | 'rps';
  forward?: { messageIds: string[] } | { sourceMessageId: string };
  sticker?: { sourceMessageId?: string; catalogId?: string };
  mentions?: DouyinOutgoingMention[];
  replyToMessageId?: string;
  emojiReaction?: DouyinEmojiReaction;
  operatorUserId?: string;
}

export interface DouyinSendMessageResult {
  messageId: string;
  messageIds?: string[];
  raw?: unknown;
}

/** A batch is not atomic. Receipted messages must never be resent on retry. */
export class PartialSendError extends Error {
  constructor(readonly messageIds: string[], cause: unknown) {
    super(`Partial send: ${messageIds.length} message(s) acknowledged; ${cause instanceof Error ? cause.message : String(cause)}. Do not retry the entire batch`, { cause });
    this.name = 'PartialSendError';
  }
}

export class UncertainSendError extends Error {
  constructor(readonly clientMessageId: string, cause: unknown) {
    super(`Send outcome is unknown; query get_douyin_send_result with client_message_id=${clientMessageId} before retrying`, { cause });
    this.name = 'UncertainSendError';
  }
}

/** An expected lookup miss, distinct from transport failures and programming errors. */
export class MessageUnavailableError extends Error {
  constructor(readonly messageId: string, reason: string) {
    super(`消息 ${messageId} 无法读取：${reason}`);
    this.name = 'MessageUnavailableError';
  }
}

export interface DouyinOutgoingMention {
  userId: string;
  name?: string;
  location: number;
  length: number;
}

export interface DouyinEmojiReaction {
  key: string;
  iconUrl?: string;
  text?: string;
  propertyValue?: string;
  additionalProperties?: Array<{ key: string; value: string }>;
  operation?: 0 | 1;
}

export interface DouyinGroupMember {
  groupId: string;
  userId: string;
  nickname?: string;
  card?: string;
  secUid?: string;
  role?: 'owner' | 'admin' | 'member';
  rawRole?: number;
  raw?: unknown;
}
