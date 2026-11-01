import { z } from 'zod';
import { parse, parseNumberAndBigInt } from 'lossless-json';
import type { DouyinConversation, DouyinUser } from './types.js';
import type { NativeMessageContent } from './native-message.js';

const id = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n);
const secUid = z.string().regex(/^MS4w[A-Za-z0-9_-]{8,252}$/);
const http = z.string().url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; });
const cardSchema = z.object({ aweme_invite_card: z.object({ scene: z.literal(0), card_type: z.literal(1),
  conversation_id: id, conversation_short_id: id, group_name: z.string().min(1).max(4096), group_member_count: z.number().int().nonnegative(),
  group_icon: z.object({ url_list: z.array(http).max(1) }), group_owner_nickname: z.string(), group_owner_uid: id, sec_group_owner_uid: secUid,
  from_uid: id, sec_from_uid: secUid, group_create_type: z.literal('0'), need_cut_icon: z.literal(1), source: z.literal(0)
}), title: z.string(), desc: z.string(), type_desc: z.string(), push_detail: z.string() });

export function buildGroupCard(group: DouyinConversation, owner: DouyinUser, self: DouyinUser): NativeMessageContent {
  const value = cardSchema.parse({ aweme_invite_card: { scene: 0, card_type: 1, conversation_id: group.shortId, conversation_short_id: group.shortId,
    group_name: group.name, group_member_count: group.memberCount ?? 0, group_icon: { url_list: group.icon ? [group.icon] : [] },
    group_owner_nickname: owner.name ?? '', group_owner_uid: owner.id, sec_group_owner_uid: owner.secUid,
    from_uid: self.id, sec_from_uid: self.secUid, group_create_type: '0', need_cut_icon: 1, source: 0 },
    title: '邀请你加入群聊', desc: `${self.name ?? ''} 邀请你加入“${group.name}”群聊, 进入可查看更多详情。`, type_desc: '群聊邀请', push_detail: '邀请你加入群聊' });
  if (owner.id !== group.ownerId) throw new Error('Group card owner mismatch');
  return { messageType: 58, content: JSON.stringify(value), text: `[群名片: ${group.name}]` };
}

export function validateGroupCard(content: string): void { cardSchema.parse(JSON.parse(content)); }

export function groupCardSegment(content: string | undefined): { type: string; data: Record<string, string> } | undefined {
  try {
    const card = (parse(content ?? '', undefined, parseNumberAndBigInt) as any).aweme_invite_card;
    const groupId = id.parse(String(card.conversation_short_id ?? card.conversation_id));
    return { type: 'contact', data: { type: 'group', id: groupId, name: typeof card.group_name === 'string' ? card.group_name : '' } };
  } catch { return; }
}
