import type { RealtimeMessageCandidate } from './protobuf.js';
import type { DouyinRecall } from './types.js';

export function isRecallMessage(candidate: RealtimeMessageCandidate): boolean {
  if (candidate.messageType === 40001) return true;
  if (candidate.messageType !== 50002) return false;
  const raw = candidate.raw as { ext?: Array<{ key: string; value: string }> };
  return Array.isArray(raw?.ext) && raw.ext.some(item => item.key === 's:is_recalled' && item.value === 'true');
}

export function toDouyinRecall(candidate: RealtimeMessageCandidate): DouyinRecall | undefined {
  if (!isRecallMessage(candidate)) return undefined;
  const raw = candidate.raw as { ext?: Array<{ key: string; value: string }> };
  const ext = new Map((Array.isArray(raw?.ext) ? raw.ext : []).map(item => [item.key, item.value]));
  const messageId = candidate.messageType === 50002 ? ext.get('s:server_message_id') : ext.get('s:target_server_message_id');
  const operatorId = ext.get('s:recall_uid');
  if (ext.get('s:is_recalled') !== 'true' || !numericId(messageId) || !numericId(operatorId) ||
      !candidate.conversationId || !numericId(candidate.conversationShortId) || ![1, 2].includes(candidate.conversationType ?? 0)) {
    throw new Error('Recall notification lacks a valid target, operator, or conversation');
  }
  const createTime = Number(candidate.createTime);
  return {
    messageId, operatorId,
    conversationId: candidate.conversationId,
    conversationShortId: candidate.conversationShortId,
    conversationType: candidate.conversationType === 2 ? 'group' : 'private',
    // Role zero identifies a self recall; unfamiliar roles need a cached author, not an assumed permission.
    senderId: ext.get('s:recall_role') === '0' ? operatorId : undefined,
    timestamp: Number.isFinite(createTime) && createTime > 0 ? (createTime < 1e12 ? createTime * 1000 : createTime) : Date.now(),
    raw: { source: candidate.source, payload: candidate.raw }
  };
}

function numericId(value: string | undefined): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
