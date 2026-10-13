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
  messageType?: number;
  clientMessageId?: string;
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
  file?: { file: string; name?: string };
  video?: { file: string };
  mentions?: DouyinOutgoingMention[];
  replyToMessageId?: string;
  emojiReaction?: DouyinEmojiReaction;
  operatorUserId?: string;
}

export interface DouyinSendMessageResult {
  messageId: string;
  raw?: unknown;
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
  role?: 'owner' | 'member';
  raw?: unknown;
}
