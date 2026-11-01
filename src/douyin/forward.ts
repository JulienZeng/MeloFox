import { createDecipheriv, type CipherGCMTypes } from 'node:crypto';
import { parse, parseNumberAndBigInt, stringify } from 'lossless-json';
import type { Page } from 'playwright';
import type { ActionDeadline } from '../runtime/deadline.js';
import type { DouyinMessage } from './types.js';
import type { NativeMessageContent } from './native-message.js';
import { nativeSourceId } from './native-message.js';
import { fetchDouyinResource } from './resources.js';
import { toDouyinMessage } from './message-adapter.js';

const LIMIT = 4 * 1024 * 1024;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseForward(content: string | undefined): Record<string, any> {
  if (!content || Buffer.byteLength(content) > LIMIT) throw new Error('Missing or oversized forward content');
  const value = parse(content, undefined, parseNumberAndBigInt);
  if (!object(value) || Number(value.aweType) !== 13600 || !Array.isArray(value.msg_ids) || !value.msg_ids.length || value.msg_ids.length > 100) {
    throw new Error('Unsupported forward card');
  }
  return value;
}

/** Official PC merge_msg_card/prepare contract. The service supplies the trusted content and send ID. */
export function forwardPrepareBody(messages: DouyinMessage[]): string {
  if (!messages.length || messages.length > 100) throw new Error('Forward requires 1 to 100 existing messages');
  const origin = nativeSourceId(messages[0].conversationShortId);
  if (new Set(messages.map(m => m.messageId)).size !== messages.length) throw new Error('Forward cannot contain duplicate message IDs');
  for (const m of messages) {
    if (m.conversationShortId !== origin || m.conversationId !== messages[0].conversationId) throw new Error('Forward nodes must belong to one existing conversation');
    nativeSourceId(m.messageId); nativeSourceId(m.senderId);
    if (!m.content || !m.messageType || !Number.isFinite(m.timestamp) || m.timestamp <= 0) throw new Error('Forward source is incomplete');
    if (m.messageType === 136 && parseForward(m.content).msg_ids.some((v: any) => Number(v?.msg_type) === 136)) throw new Error('Nested forward depth exceeds the official client limit');
  }
  const generated = { aweType: 13600, new_mr_share_version: 2, origin_conv_id: BigInt(origin), title: '聊天记录',
    msg_ids: messages.map(m => { let aweType = 0; try { aweType = Number((parse(m.content!, undefined, parseNumberAndBigInt) as any)?.aweType ?? 0); } catch { /* plain content */ }
      return { msg_id: BigInt(m.messageId), msg_type: m.messageType, awe_type: aweType, show_flag: [7, 51, 5].includes(m.messageType!),
        uid: BigInt(m.senderId), create_time: m.timestamp }; }),
    list_content: messages.slice(0, 3).map(m => ({ msgid: BigInt(m.messageId), nick_name: (m.senderName ?? '').slice(0, 256),
      text: (m.text ?? `[消息 ${m.messageType}]`).replace(/[\r\n]+/g, ' ').slice(0, 500) })) };
  return stringify({ origin_conv_short_id: BigInt(origin), msg_id_list: messages.map(m => BigInt(m.messageId)), generated_content: stringify(generated) })!;
}

export async function prepareForward(page: Page, messages: DouyinMessage[] | DouyinMessage, deadline: ActionDeadline): Promise<NativeMessageContent> {
  let body: string;
  if (Array.isArray(messages)) body = forwardPrepareBody(messages);
  else {
    if (messages.messageType !== 136) throw new Error('Source is not a forward card');
    const card = parseForward(messages.content);
    body = stringify({ origin_conv_short_id: BigInt(nativeSourceId(String(card.origin_conv_id))),
      msg_id_list: card.msg_ids.map((v: any) => BigInt(nativeSourceId(String(v.msg_id)))), generated_content: messages.content })!;
  }
  const response = await fetchDouyinResource(page, '/aweme/v1/web/im_communication/merge_msg_card/prepare/', {}, deadline, 'POST', body);
  const content = response.verified_content;
  if (typeof content !== 'string' || Buffer.byteLength(content) > 64 * 1024) throw new Error('Forward preparation returned invalid content');
  const card = parseForward(content);
  if ((!Array.isArray(card.inline_content) || !card.inline_content.length) && (!Array.isArray(card.upload_key_list) || !card.upload_key_list.length)) throw new Error('Forward preparation did not return records');
  if (typeof response.send_id !== 'string' || !response.send_id || response.send_id.length > 1024) throw new Error('Forward preparation is missing its send ID');
  return { messageType: 136, content, text: '[聊天记录]', forwardSendId: response.send_id };
}

export function decryptForwardRecords(bytes: Buffer, key: string): unknown[] {
  if (bytes.length < 28 || bytes.length > LIMIT || !/^(?:[a-f0-9]{32}|[a-f0-9]{48}|[a-f0-9]{64})$/i.test(key)) throw new Error('Invalid encrypted forward resource');
  const decipher = createDecipheriv(`aes-${key.length * 4}-gcm` as CipherGCMTypes, Buffer.from(key, 'hex'), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const plain = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  const value = parse(plain.toString('utf8'), undefined, parseNumberAndBigInt);
  if (!object(value) || !Array.isArray(value.Messages) || value.Messages.length > 100) throw new Error('Invalid forward record resource');
  return value.Messages;
}

export interface ForwardReadBudget { bytes: number; records: number; chunks: number }

export async function readForwardRecords(page: Page, card: DouyinMessage, deadline: ActionDeadline, viewerId: string, budget: ForwardReadBudget = { bytes: LIMIT, records: 100, chunks: 10 }): Promise<DouyinMessage[]> {
  const value = parseForward(card.content);
  const records: unknown[] = Array.isArray(value.inline_content) ? [...value.inline_content] : [];
  const chunks = value.upload_key_list ?? [];
  if (!Array.isArray(chunks) || chunks.length > 10 || records.length > 100) throw new Error('Forward record limits exceeded');
  for (const chunk of chunks) {
    if (--budget.chunks < 0) throw new Error('Forward resource chunk limit exceeded');
    if (typeof chunk?.key !== 'string' || !chunk.key || chunk.key.length > 2048 || typeof value.skey !== 'string') throw new Error('Invalid forward resource descriptor');
    const resource = await fetchDouyinResource(page, '/aweme/v1/web/im_communication/merge_msg_card/get_object_url/', {}, deadline, 'POST',
      stringify({ uri: chunk.key, access_chain: [{ msg_id: BigInt(nativeSourceId(card.messageId)), conv_id: BigInt(nativeSourceId(card.conversationShortId)) }] })!);
    const url = new URL(resource.url);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !/(^|\.)(douyin\.com|douyincdn\.com|byteimg\.com|ibytedtos\.com|bytedance\.com)$/.test(url.hostname)) throw new Error('Unsupported forward download host');
    const response = await fetch(url, { redirect: 'error', signal: deadline.signal });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Forward download failed'); }
    const reader = response.body.getReader(), buffers: Buffer[] = [];
    try { while (true) { const part = await reader.read(); if (part.done) break;
      budget.bytes -= part.value.byteLength; if (budget.bytes < 0) throw new Error('Forward download exceeds size limit'); buffers.push(Buffer.from(part.value));
    } } finally { await reader.cancel().catch(() => undefined); }
    records.push(...decryptForwardRecords(Buffer.concat(buffers), value.skey));
    if (records.length > 100) throw new Error('Forward record limits exceeded');
  }
  budget.records -= records.length;
  if (budget.records < 0) throw new Error('Forward record limits exceeded');
  return mapForwardRecords(records, value, card, viewerId);
}

export function mapForwardRecords(records: unknown[], content: Record<string, any>, card: DouyinMessage, viewerId: string): DouyinMessage[] {
  const names = new Map((content.list_content ?? []).filter(object).map((r: any) => [String(r.msgid), String(r.nick_name ?? '').slice(0, 256)]));
  const descriptors = new Map(content.msg_ids.filter(object).map((r: any) => [String(r.msg_id), r]));
  return records.map(record => {
    if (!object(record)) throw new Error('Invalid forward record');
    const id = nativeSourceId(String(record.server_message_id)), sender = nativeSourceId(String(record.sender)), descriptor = descriptors.get(id) as any;
    if (!descriptor) throw new Error('Forward record does not belong to this card');
    const time = Number(record.create_time), timestamp = time < 1e12 ? time * 1000 : time;
    const ext = record.ext ?? {};
    const hidden = record.degrade_info || !record.content || Number(record.status ?? 0) !== 0 || String(ext['a:s_async_hide_status']) === '1' || String(ext['a:s_rip_media']) === '1' ||
      (ext['s:visible'] && !String(ext['s:visible']).split(',').some((id: string) => id.trim() === viewerId)) || (ext['s:invisible'] && String(ext['s:invisible']).split(',').some((id: string) => id.trim() === viewerId));
    // Forward records are display-only: never insert them into the actionable message cache or emit them as new events.
    const message = toDouyinMessage({ source: 'forward-card', serverMessageId: id, sender, createTime: String(timestamp),
      conversationId: record.conversation_id ?? '', conversationShortId: String(record.conversation_short_id ?? card.conversationShortId ?? ''),
      conversationType: Number(record.conversation_type ?? 1), messageType: Number(record.message_type),
      content: typeof record.content === 'string' ? record.content : undefined, mediaUnavailable: true, raw: {} }, false, true)!;
    if (!message || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 8640000000000000) throw new Error('Invalid forward record metadata');
    message.senderName = names.get(id) as string | undefined;
    if (message.messageType === 30) message.segments = [{ type: 'text', data: { text: '[视频暂不可用]' } }];
    if (hidden || descriptor.show_flag === false) { message.text = '[转发内容不可用]'; message.content = undefined; message.segments = [{ type: 'text', data: { text: message.text } }]; message.messageType = undefined; }
    return message;
  });
}
