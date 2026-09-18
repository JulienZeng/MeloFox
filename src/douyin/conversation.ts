import type { DouyinBridge } from './bridge.js';
import type { DouyinConversation, DouyinGroupMember } from './types.js';

export async function listDouyinGroups(bridge: DouyinBridge): Promise<DouyinConversation[]> {
  return (await bridge.getConversations()).filter(conversation => conversation.type === 'group');
}

export async function listDouyinFriends(bridge: DouyinBridge): Promise<DouyinConversation[]> {
  return (await bridge.getConversations()).filter(conversation => conversation.type === 'private');
}

export function listDouyinGroupMembers(bridge: DouyinBridge, groupId: string): Promise<DouyinGroupMember[]> {
  return bridge.getGroupMembers(groupId);
}
