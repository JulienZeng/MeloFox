import { parse, parseNumberAndBigInt } from 'lossless-json';
import type { RealtimeMessageCandidate } from './protobuf.js';

export interface DouyinReactionNotice {
  eventId: string; messageId: string; conversationId: string; conversationShortId: string;
  conversationType: 'private' | 'group'; operatorId: string; emoji: string; operation: 'add' | 'remove'; timestamp: number;
}
export function reactionNotices(candidate: RealtimeMessageCandidate): DouyinReactionNotice[] {
  if (candidate.messageType !== 70002 || !candidate.serverMessageId || !candidate.conversationId || !candidate.conversationShortId) return [];
  try {
    const raw = candidate.raw as { ext?: Array<{ key: string; value: string }> };
    const ext = Object.fromEntries((raw.ext ?? []).map(item => [item.key, item.value]));
    const change = parse(ext['s:property_modify'] ?? '', undefined, parseNumberAndBigInt) as any;
    const messageId = String(change.ServerMessageId), operatorId = String(change.UserId);
    if (!/^[1-9]\d{0,18}$/.test(messageId) || !/^[1-9]\d{0,18}$/.test(operatorId) ||
        messageId !== ext['s:server_message_id'] || String(change.ConversationShortId) !== candidate.conversationShortId || !Array.isArray(change.Modifys)) return [];
    const aliases: Record<string, string> = { 'e:love': '[爱心]', 'e:ok': '[OK]', 'e:tearsofjoy': '[捂脸]' };
    const notices = new Map<string, DouyinReactionNotice>();
    for (const item of change.Modifys) {
      const emoji = aliases[item.Key] ?? (/^se:\[[^\[\]\x00-\x1f\x7f]{1,64}\]$/.test(item.Key) ? item.Key.slice(3) : undefined);
      const op = Number(item.Op);
      if (!emoji || ![0, 1].includes(op)) continue;
      notices.set(`${op}:${emoji}`, { eventId: candidate.serverMessageId, messageId, operatorId, emoji,
        operation: op === 0 ? 'add' : 'remove', conversationId: candidate.conversationId,
        conversationShortId: candidate.conversationShortId, conversationType: candidate.conversationType === 2 ? 'group' : 'private',
        timestamp: Number(candidate.createTime) || Date.now() });
    }
    return [...notices.values()];
  } catch { return []; }
}
