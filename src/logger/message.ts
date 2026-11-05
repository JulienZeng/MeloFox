import type { DouyinConversation, DouyinMessage, DouyinUser } from '../douyin/types.js';
import { sanitizeLogText } from './sanitize.js';

const compact = (text: string, limit: number) => {
  const value = sanitizeLogText(text).replace(/\s+/g, ' ').trim();
  const characters = Array.from(value);
  return characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : value;
};
const identity = (id: string | undefined, name?: string) => name ? `${compact(name, 32)}(${id || '未知'})` : id || '未知';
export function messagePreview(message: DouyinMessage, includeContent = true): string {
  const labels: Record<string, string> = { image: '图片', video: '视频', record: '语音', file: '文件', share: '分享',
    forward: '合并转发', node: '合并转发', face: '表情', emoji: '表情', sticker: '贴纸', json: '卡片', xml: '卡片',
    location: '位置', music: '音乐', contact: '名片', reply: '回复', at: '提及' };
  const segments = message.segments?.length ? message.segments : message.text ? [{ type: 'text', data: { text: message.text } }] : [];
  const text = segments.slice(0, 20).map(segment => {
    if (segment.type === 'text') return includeContent ? String(segment.data.text ?? '') : '[文本]';
    const label = labels[segment.type] || '消息';
    const detail = includeContent ? segment.type === 'share' ? segment.data.title
      : segment.type === 'file' ? segment.data.name
      : segment.type === 'reply' ? segment.data.id
      : segment.type === 'at' ? segment.data.qq ?? segment.data.id
      : ['emoji', 'face'].includes(segment.type) ? segment.data.name : undefined : undefined;
    return `[${label}${detail ? `: ${compact(String(detail), 40)}` : ''}]`;
  }).join(' ') || (message.forwardMessages ? '[合并转发]' : '[消息]');
  return compact(text, 180);
}
export function messageLog(message: DouyinMessage, options: {
  selfId?: string; conversation?: DouyinConversation; sender?: DouyinUser; peer?: DouyinUser;
  peerId?: string; includeContent?: boolean;
}): string {
  const outgoing = message.senderId === options.selfId;
  const direction = outgoing ? '发送 ->' : '接收 <-';
  const sender = identity(message.senderId, message.senderCard || message.senderName || options.sender?.name);
  const target = message.conversationType === 'group'
    ? `群聊 [${identity(message.conversationShortId || message.conversationId, options.conversation?.name)}] [${sender}]`
    : `私聊 [${outgoing ? identity(options.peerId || options.conversation?.peerUserId || message.conversationShortId || message.conversationId, options.peer?.name || options.conversation?.name) : sender}]`;
  return `${direction} ${target} ${messagePreview(message, options.includeContent)}`;
}
