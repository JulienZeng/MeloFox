export type DouyinConversationType = 'private' | 'group';

export interface DouyinUser {
  id: string;
  name?: string;
  avatar?: string;
}

export interface DouyinConversation {
  id: string;
  shortId?: string;
  type: DouyinConversationType;
  name?: string;
  memberCount?: number;
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
}

export interface DouyinSendMessageInput {
  target: DouyinSendTarget;
  text: string;
}

export interface DouyinSendMessageResult {
  messageId: string;
  raw?: unknown;
}

export interface DouyinGroupMember {
  groupId: string;
  userId: string;
  nickname?: string;
  card?: string;
  raw?: unknown;
}
