import { parse, parseNumberAndBigInt } from 'lossless-json';
import type { RealtimeMessageCandidate } from './protobuf.js';
import type { DouyinGroupMember } from './types.js';

export interface DouyinGroupNotice {
  eventId: string; groupId: string; conversationId: string; timestamp: number; userId: string;
  type: 'group_increase' | 'group_decrease' | 'group_admin' | 'group_ban';
  subType: string; operatorId?: string; duration?: number; operatorUnknown?: boolean;
}
const uid = (v: unknown): string | undefined => {
  if (!['string', 'number', 'bigint'].includes(typeof v) || (typeof v === 'number' && !Number.isSafeInteger(v))) return;
  const s = String(v); return /^[1-9]\d{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n ? s : undefined;
};

/** Parse protocol fields only. Never infer actors or operations from localized UI text. */
export function groupNotices(candidate: RealtimeMessageCandidate, selfId: string): DouyinGroupNotice[] {
  if (candidate.conversationType !== 2 || !uid(candidate.serverMessageId) || !uid(candidate.conversationShortId) || !candidate.conversationId) return [];
  let content: any;
  try { content = parse(candidate.content ?? '', undefined, parseNumberAndBigInt); } catch { return []; }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const time = Number(candidate.createTime);
  const base = { eventId: candidate.serverMessageId!, groupId: candidate.conversationShortId!, conversationId: candidate.conversationId,
    timestamp: Number.isFinite(time) && time > 0 ? (time < 1e12 ? time * 1000 : time) : Date.now() };
  const users = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.map(item => uid(item?.uid)).filter((v): v is string => Boolean(v)))] : [];
  if (candidate.messageType === 1001) {
    const active = users(content.active_users), passive = users(content.passive_users), aweType = Number(content.aweType);
    const operatorId = active.length === 1 ? active[0] : '0';
    const actor = { operatorId, ...(operatorId === '0' ? { operatorUnknown: true } : {}) };
    // 100140 is the newer invite notice, confirmed by a captured native group history sample.
    if ([100100, 100101, 100102, 100140].includes(aweType)) return passive.map(userId => ({ ...base, ...actor, userId, type: 'group_increase', subType: 'invite' }));
    if (aweType === 100109) return passive.map(userId => ({ ...base, ...actor, userId, type: 'group_increase', subType: 'approve' }));
    if (aweType === 100104) return passive.map(userId => ({ ...base, ...actor, userId, type: 'group_decrease', subType: userId === selfId ? 'kick_me' : 'kick' }));
    if (aweType === 100105) return active.map(userId => ({ ...base, userId, operatorId: userId, type: 'group_decrease', subType: 'leave' }));
    if (aweType === 100110) return passive.map(userId => ({ ...base, userId, type: 'group_admin', subType: 'set' }));
  }
  if (candidate.messageType === 50011 && [0, 1].includes(Number(content.block_status))) {
    const blocked = Number(content.block_status) === 1, type = Number(content.type);
    const targets = type === 1 && Array.isArray(content.userID) ? content.userID.map(uid).filter((v: string | undefined): v is string => Boolean(v)) : [2, 3].includes(type) ? ['0'] : [];
    return [...new Set<string>(targets)].flatMap(userId => {
      const duration = blocked && userId !== '0' ? Number(content.blockTime?.[userId]) : 0;
      if (!Number.isSafeInteger(duration) || duration < 0) return [];
      // This SDK command contains no operator. Zero and the explicit flag preserve that fact.
      return [{ ...base, userId, operatorId: '0', operatorUnknown: true, type: 'group_ban' as const,
        subType: blocked ? 'ban' : 'lift_ban', duration }];
    });
  }
  return [];
}

/** A generic participant command has no operation label. Reconcile known roles only. */
export function modifiedGroupMembers(candidate: RealtimeMessageCandidate): string[] {
  if (candidate.messageType !== 50001 || candidate.conversationType !== 2) return [];
  try {
    const value = parse(candidate.content ?? '', undefined, parseNumberAndBigInt) as any;
    if (Number(value.command_type) !== 7 || !Array.isArray(value.modified_participant)) return [];
    return [...new Set<string>(value.modified_participant.map(uid).filter(Boolean))];
  } catch { return []; }
}

export function removedAdminNotices(candidate: RealtimeMessageCandidate, before: DouyinGroupMember[], after: DouyinGroupMember[]): DouyinGroupNotice[] {
  if (!uid(candidate.serverMessageId) || !uid(candidate.conversationShortId) || !candidate.conversationId) return [];
  const modified = new Set(modifiedGroupMembers(candidate)), current = new Map(after.map(member => [member.userId, member]));
  const time = Number(candidate.createTime);
  return before.filter(member => member.role === 'admin' && modified.has(member.userId) && current.get(member.userId)?.role === 'member' && (current.get(member.userId)?.rawRole ?? 0) === 0)
    .map(member => ({ eventId: candidate.serverMessageId!, conversationId: candidate.conversationId!, groupId: candidate.conversationShortId!,
      timestamp: Number.isFinite(time) && time > 0 ? (time < 1e12 ? time * 1000 : time) : Date.now(),
      userId: member.userId, type: 'group_admin', subType: 'unset' }));
}
