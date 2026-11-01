import type { DouyinConversation } from './types.js';

export type GroupOperation =
  | { kind: 'kick'; userId: string; rejectAddRequest: boolean }
  | { kind: 'leave'; dismiss: boolean }
  | { kind: 'card'; userId: string; card: string }
  | { kind: 'admin'; userId: string; enable: boolean }
  | { kind: 'ban'; userId: string; duration: number }
  | { kind: 'whole_ban'; enable: boolean };

export interface GroupMutation {
  command: number; type: string; path: string; responseKey: string; params: Record<string, unknown>;
}

export function groupMutation(group: DouyinConversation, selfId: string, operation: GroupOperation): GroupMutation {
  const id = (value: string | undefined) => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
  if (!id(selfId) || !id(group.shortId) || group.type !== 'group') throw new Error('Group operation requires an authenticated existing group');
  if ('userId' in operation && !id(operation.userId)) throw new Error('user_id must be a positive int64 ID');
  const common = { conversationId: group.id, conversationShortId: group.shortId, conversationType: 2 };
  const result = (command: number, type: string, path: string, responseKey: string, params: Record<string, unknown>): GroupMutation =>
    ({ command, type, path: `v1/conversation/${path}`, responseKey, params });
  switch (operation.kind) {
    case 'kick':
      if (operation.rejectAddRequest) throw new Error('Unsupported: Douyin removal does not provide permanent rejection of future join requests');
      if (operation.userId === selfId) throw new Error('Use set_group_leave to leave the group');
      return result(651, 'RemoveParticipantsRequest', 'remove_participants', 'removeParticipants', { ...common, participants: [operation.userId] });
    case 'leave':
      if (operation.dismiss && group.ownerId !== selfId) throw new Error('Only the group owner can dissolve the group');
      if (!operation.dismiss && group.ownerId === selfId) throw new Error('Group owner must explicitly set is_dismiss=true to dissolve the group');
      return result(operation.dismiss ? 614 : 652, 'GroupIdentifier', operation.dismiss ? 'dissolve' : 'leave', operation.dismiss ? 'dissolve' : 'leave', common);
    case 'card':
      if (typeof operation.card !== 'string' || /[\x00-\x1f\x7f]/.test(operation.card)) throw new Error('Invalid group card');
      return result(655, 'UpdateParticipantRequest', 'update_participant', 'updateParticipant', { ...common, userId: operation.userId, alias: operation.card, isAliasSet: true });
    case 'admin':
      return result(655, 'UpdateParticipantRequest', 'update_participant', 'updateParticipant', { ...common, userId: operation.userId, role: operation.enable ? 2 : 0 });
    case 'ban':
      if (!Number.isSafeInteger(operation.duration) || operation.duration < 0 || operation.duration > 30 * 86400) throw new Error('duration must be an integer from 0 to 2592000 seconds');
      return result(2019, 'BlockMembersRequest', 'block_member', 'blockMembers', { conversationId: group.id, convShortId: group.shortId,
        conversationType: 2, blockStatus: operation.duration ? 1 : 0, blockTime: { [operation.userId]: operation.duration } });
    case 'whole_ban':
      return result(2020, 'BlockConversationRequest', 'block_conversation', 'blockConversation', { conversationId: group.id,
        convShortId: group.shortId, conversationType: 2, blockStatus: operation.enable ? 1 : 0, blockNormalOnly: true });
  }
}

export function verifyGroupMutation(body: Record<string, any> | undefined, mutation: GroupMutation, operation: GroupOperation): void {
  // Leave/dissolve use only the checked command/status envelope; the SDK defines no response body.
  if (operation.kind === 'leave') return;
  const value = body?.[mutation.responseKey];
  if (!value || typeof value !== 'object') throw new Error('Group operation has no matching response body; result is unconfirmed, do not retry automatically');
  if (['kick', 'card', 'admin'].includes(operation.kind) &&
      (value.status !== 0 || (value.checkCode !== undefined && String(value.checkCode) !== '0'))) {
    throw new Error(`Douyin group operation rejected: status=${value.status ?? 'missing'}, check_code=${value.checkCode ?? 'missing'}; ${value.checkMessage || value.extraInfo || ''}`);
  }
  if (value.failedParticipants?.length || value.failedMembers?.length) throw new Error('Douyin rejected the requested member operation');
  if (operation.kind === 'card' || operation.kind === 'admin') {
    const member = value.participant;
    if (member?.userId !== operation.userId || (operation.kind === 'card' ? (member.alias ?? '') !== operation.card : (member.role ?? 0) !== (operation.enable ? 2 : 0))) {
      throw new Error('Group member update was not confirmed; do not retry automatically');
    }
  }
}
