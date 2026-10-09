import { randomUUID } from 'node:crypto';
import type { DouyinOutgoingMention } from './types.js';

export interface DouyinSendProtocolContext {
  userAgent: string;
  language: string;
  platform: string;
  cookieEnabled: boolean;
  browserName: string;
  browserVersion: string;
  online: boolean;
  screenWidth: number;
  screenHeight: number;
  timezoneName: string;
  deviceId?: string;
  userId?: string;
  identitySecurityToken?: string;
  identitySecurityDeviceId?: string;
}

export interface BuildTextSendRequestInput {
  conversationId?: string;
  inboxType?: number;
  conversationShortId: string;
  conversationType: 1 | 2;
  text: string;
  mentions?: DouyinOutgoingMention[];
  replyReference?: DouyinReplyReference;
  context: DouyinSendProtocolContext;
  clientMessageId?: string;
  sequenceId?: number;
}

export interface BuildEmojiReactionRequestInput {
  conversationId?: string;
  inboxType?: number;
  conversationShortId: string;
  conversationType: 1 | 2;
  targetMessageId: string;
  targetClientMessageId: string;
  operatorUserId: string;
  emoji: {
    key: string;
    iconUrl?: string;
    text?: string;
    propertyValue?: string;
  };
  context: DouyinSendProtocolContext;
  sequenceId?: number;
}

export interface BuildImageSendRequestInput {
  conversationId?: string;
  inboxType?: number;
  conversationShortId: string;
  conversationType: 1 | 2;
  image: DouyinUploadedImage;
  context: DouyinSendProtocolContext;
  clientMessageId?: string;
  sequenceId?: number;
}

export interface DouyinUploadedImage {
  oid: string;
  skey: string;
  size: number;
  md5: string;
  width: number;
  height: number;
}

export interface DouyinReplyReference {
  messageId: string;
  content?: string;
  originalContent?: string;
  messageType?: number;
  senderId?: string;
  secSender?: string;
  nickname?: string;
  indexInConversation?: string;
}

export interface DecodedSendResponse {
  ok: boolean;
  statusCode?: number;
  status?: string;
  serverMessageId?: string;
  clientMessageId?: string;
  logId?: string;
  rawBase64: string;
}

export function buildImApiRequest(command: number, payload: Buffer, context: DouyinSendProtocolContext, inboxType = 0): Buffer {
  const envelope = new ProtoWriter()
    .uint32(1, command)
    .uint32(2, nextSequenceId())
    .string(3, '0.1.8')
    .string(4, '')
    .uint32(5, 3)
    .uint32(6, inboxType)
    .string(7, '0d50935:feat/pc-im-group')
    .bytes(8, new ProtoWriter().bytes(command, payload).finish())
    .string(9, '0')
    .string(11, 'douyin_pc')
    .string(14, '360000');
  for (const [key, value] of buildCommonHeaders(context)) {
    envelope.bytes(15, encodeKeyValue(key, value));
  }
  return envelope.uint32(18, 1).string(21, 'douyin_web').string(22, 'web_sdk').finish();
}

export function buildRecallRequest(input: {
  conversationId: string;
  conversationShortId: string;
  conversationType: 1 | 2;
  messageId: string;
  context: DouyinSendProtocolContext;
}): Buffer {
  for (const id of [input.conversationShortId, input.messageId]) {
    if (!/^[1-9]\d*$/.test(id) || BigInt(id) > 9223372036854775807n) throw new Error('Recall requires a valid numeric server message/conversation ID');
  }
  const payload = new ProtoWriter()
    .string(1, input.conversationId)
    .uint64(2, input.conversationShortId)
    .uint32(3, input.conversationType)
    .uint64(4, input.messageId)
    .finish();
  // Both captured private and group web recalls use inbox zero, unlike incoming notifications.
  return buildImApiRequest(702, payload, input.context, 0);
}

export function buildTextSendRequest(input: BuildTextSendRequestInput): { body: Buffer; clientMessageId: string } {
  const clientMessageId = input.clientMessageId ?? randomUUID();
  const content = buildTextContent(input.text, input.mentions ?? [], input.conversationShortId, Boolean(input.replyReference));
  const mentionedUsers = (input.mentions ?? []).map(mention => mention.userId).filter(Boolean).join(',');
  const stime = `${Date.now()}.${Math.floor(Math.random() * 10_000)}`;

  const sendBody = new ProtoWriter()
    .string(1, input.conversationId ?? input.conversationShortId)
    .uint32(2, input.conversationType)
    .uint64(3, input.conversationShortId)
    .string(4, JSON.stringify(content))
    .bytes(5, encodeKeyValue('s:mentioned_users', mentionedUsers))
    .bytes(5, encodeKeyValue('s:client_message_id', clientMessageId))
    .bytes(5, encodeKeyValue('s:stime', stime))
    .uint32(6, 7)
    .string(8, clientMessageId);

  if (input.replyReference) {
    sendBody.bytes(11, encodeReplyReference(input.replyReference));
  }

  const sendPayload = sendBody.finish();

  const bodyWrapper = new ProtoWriter().bytes(100, sendPayload).finish();

  const envelope = new ProtoWriter()
    .uint32(1, 100)
    .uint32(2, input.sequenceId ?? nextSequenceId())
    .string(3, '0.1.8')
    .string(4, '')
    .uint32(5, 3)
    .uint32(6, input.inboxType ?? 0)
    .string(7, '0d50935:feat/pc-im-group')
    .bytes(8, bodyWrapper)
    .string(9, '0')
    .string(11, 'douyin_pc')
    .string(14, '360000');

  for (const [key, value] of buildCommonHeaders(input.context)) {
    envelope.bytes(15, encodeKeyValue(key, value));
  }

  envelope.uint32(18, 1).string(21, 'douyin_web').string(22, 'web_sdk');
  return {
    body: envelope.finish(),
    clientMessageId
  };
}

export function buildEmojiReactionRequest(input: BuildEmojiReactionRequestInput): { body: Buffer } {
  const propertyValue = input.emoji.propertyValue ?? JSON.stringify({
    emoji_data: {
      icon_url: input.emoji.iconUrl ?? '',
      me_text: '',
      text: input.emoji.text ?? ''
    },
    type: 1
  });

  const property = new ProtoWriter()
    .uint32(1, 0)
    .string(2, input.emoji.key)
    .string(3, propertyValue)
    .string(4, input.operatorUserId)
    .finish();

  const body = new ProtoWriter()
    .string(1, input.conversationId ?? input.conversationShortId)
    .uint32(2, input.conversationType)
    .uint64(3, input.conversationShortId)
    .uint64(4, input.targetMessageId)
    .string(5, input.targetClientMessageId)
    .bytes(6, property)
    .finish();

  const command = new ProtoWriter()
    .bytes(1, body)
    .finish();

  const bodyWrapper = new ProtoWriter().bytes(705, command).finish();

  const envelope = new ProtoWriter()
    .uint32(1, 705)
    .uint32(2, input.sequenceId ?? nextSequenceId())
    .string(3, '0.1.8')
    .string(4, '')
    .uint32(5, 3)
    .uint32(6, input.inboxType ?? 0)
    .string(7, '0d50935:feat/pc-im-group')
    .bytes(8, bodyWrapper)
    .string(9, '0')
    .string(11, 'douyin_pc')
    .string(14, '360000');

  for (const [key, value] of buildCommonHeaders(input.context)) {
    envelope.bytes(15, encodeKeyValue(key, value));
  }

  envelope.uint32(18, 1).string(21, 'douyin_web').string(22, 'web_sdk');
  return {
    body: envelope.finish()
  };
}

export function buildImageSendRequest(input: BuildImageSendRequestInput): { body: Buffer; clientMessageId: string } {
  const clientMessageId = input.clientMessageId ?? randomUUID();
  const content = {
    resource_url: {
      oid: input.image.oid,
      skey: input.image.skey,
      data_size: input.image.size,
      md5: input.image.md5
    },
    cover_height: input.image.height,
    cover_width: input.image.width,
    check_pics: [],
    md5: input.image.md5,
    from_gallery: 1,
    aweType: 2702
  };
  const stime = `${Date.now()}.${Math.floor(Math.random() * 10_000)}`;

  const sendPayload = new ProtoWriter()
    .string(1, input.conversationId ?? input.conversationShortId)
    .uint32(2, input.conversationType)
    .uint64(3, input.conversationShortId)
    .string(4, JSON.stringify(content))
    .bytes(5, encodeKeyValue('s:mentioned_users', ''))
    .bytes(5, encodeKeyValue('s:client_message_id', clientMessageId))
    .bytes(5, encodeKeyValue('s:stime', stime))
    .uint32(6, 27)
    .string(8, clientMessageId)
    .finish();

  const bodyWrapper = new ProtoWriter().bytes(100, sendPayload).finish();

  const envelope = new ProtoWriter()
    .uint32(1, 100)
    .uint32(2, input.sequenceId ?? nextSequenceId())
    .string(3, '0.1.8')
    .string(4, '')
    .uint32(5, 3)
    .uint32(6, input.inboxType ?? 0)
    .string(7, '0d50935:feat/pc-im-group')
    .bytes(8, bodyWrapper)
    .string(9, '0')
    .string(11, 'douyin_pc')
    .string(14, '360000');

  for (const [key, value] of buildCommonHeaders(input.context)) {
    envelope.bytes(15, encodeKeyValue(key, value));
  }

  envelope.uint32(18, 1).string(21, 'douyin_web').string(22, 'web_sdk');
  return {
    body: envelope.finish(),
    clientMessageId
  };
}

export function decodeSendResponse(buffer: Buffer): DecodedSendResponse {
  const fields = readProtoFields(buffer);
  const statusCode = asNumber(firstField(fields, 3)?.value);
  const status = asString(firstField(fields, 4)?.value);
  const logId = asString(firstField(fields, 7)?.value);
  const payload = firstField(fields, 6);
  const wrapped = payload?.wireType === 2 && Buffer.isBuffer(payload.value) ? readProtoFields(payload.value) : [];
  const nestedPayload = firstField(wrapped, 100);
  const nested = nestedPayload?.wireType === 2 && Buffer.isBuffer(nestedPayload.value) ? readProtoFields(nestedPayload.value) : [];
  const serverMessageId = valueToString(firstField(nested, 1)?.value);
  const clientMessageId = asString(firstField(nested, 4)?.value);

  return {
    ok: statusCode === 0 && (!status || status === 'OK'),
    statusCode,
    status,
    serverMessageId,
    clientMessageId,
    logId,
    rawBase64: buffer.toString('base64')
  };
}

function buildTextContent(text: string, mentions: DouyinOutgoingMention[], conversationShortId: string, isReply: boolean): unknown {
  return {
    aweType: isReply ? 703 : 700,
    type: 0,
    richTextInfos: mentions.flatMap(mention => [
      {
        info: {
          uid: mention.userId,
          con_id: conversationShortId
        },
        infoType: 1,
        length: mention.length,
        location: mention.location
      },
      {
        info: {
          font_weight: '2'
        },
        infoType: 2,
        length: mention.length,
        location: mention.location
      }
    ]),
    text
  };
}

function buildCommonHeaders(context: DouyinSendProtocolContext): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  if (context.identitySecurityToken) {
    headers.push(['identity_security_token', context.identitySecurityToken]);
  }
  if (context.identitySecurityDeviceId) {
    headers.push(['identity_security_device_id', context.identitySecurityDeviceId]);
  } else if (context.deviceId) {
    headers.push(['identity_security_device_id', context.deviceId]);
  }

  headers.push(
    ['identity_security_aid', ''],
    ['session_aid', '6383'],
    ['session_did', '0'],
    ['app_name', 'douyin_pc'],
    ['priority_region', 'cn'],
    ['user_agent', context.userAgent],
    ['cookie_enabled', String(context.cookieEnabled)],
    ['browser_language', context.language],
    ['browser_platform', context.platform],
    ['browser_name', context.browserName],
    ['browser_version', context.browserVersion],
    ['browser_online', String(context.online)],
    ['screen_width', String(context.screenWidth)],
    ['screen_height', String(context.screenHeight)],
    ['referer', ''],
    ['timezone_name', context.timezoneName],
    ['deviceId', context.deviceId ?? '0'],
    ['is-retry', '0']
  );

  return headers;
}

function encodeKeyValue(key: string, value: string): Buffer {
  return new ProtoWriter().string(1, key).string(2, value).finish();
}

function encodeReplyReference(reference: DouyinReplyReference): Buffer {
  const metadata = {
    refmsg_type: reference.messageType ?? 7,
    content: reference.content ?? '',
    refmsg_uid: reference.senderId ?? '',
    refmsg_sec_uid: reference.secSender ?? '',
    nickname: reference.nickname ?? '',
    refmsg_content: reference.originalContent ?? reference.content ?? '',
    version: 1,
    itemId: '',
    scene_type: 1
  };

  const writer = new ProtoWriter()
    .uint64(1, reference.messageId)
    .string(2, JSON.stringify(metadata))
    .uint64(3, reference.messageId);

  if (reference.indexInConversation) {
    writer.uint64(4, reference.indexInConversation);
  }

  writer
    .bytes(5, encodeKeyValue('s:ref_content', reference.originalContent ?? reference.content ?? ''))
    .bytes(5, encodeKeyValue('s:ref_is_edited', 'false'));

  return writer.finish();
}

let sequence = 10020;

function nextSequenceId(): number {
  sequence += 1;
  return sequence;
}

class ProtoWriter {
  private readonly chunks: Buffer[] = [];

  uint32(field: number, value: number): this {
    this.tag(field, 0);
    this.varint(BigInt(value >>> 0));
    return this;
  }

  uint64(field: number, value: string | number | bigint): this {
    this.tag(field, 0);
    this.varint(typeof value === 'bigint' ? value : BigInt(value));
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(value, 'utf8'));
  }

  bytes(field: number, value: Buffer): this {
    this.tag(field, 2);
    this.varint(BigInt(value.byteLength));
    this.chunks.push(value);
    return this;
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }

  private tag(field: number, wireType: number): void {
    this.varint(BigInt((field << 3) | wireType));
  }

  private varint(value: bigint): void {
    const bytes: number[] = [];
    let current = value;
    while (current >= 0x80n) {
      bytes.push(Number((current & 0x7fn) | 0x80n));
      current >>= 7n;
    }
    bytes.push(Number(current));
    this.chunks.push(Buffer.from(bytes));
  }
}

interface ProtoField {
  field: number;
  wireType: number;
  value: bigint | number | Buffer;
}

function readProtoFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.byteLength) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      fields.push({ field, wireType, value: value.value });
      continue;
    }
    if (wireType === 1) {
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      fields.push({ field, wireType, value: buffer.subarray(offset, end) });
      offset = end;
      continue;
    }
    if (wireType === 5) {
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    break;
  }

  return fields;
}

function readVarint(buffer: Buffer, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.byteLength) {
    const byte = buffer[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value, offset };
    }
    shift += 7n;
  }
  throw new Error('Unexpected end of protobuf varint');
}

function firstField(fields: ProtoField[], field: number): ProtoField | undefined {
  return fields.find(item => item.field === field);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  if (!Buffer.isBuffer(value)) {
    return undefined;
  }
  return value.toString('utf8');
}

function valueToString(value: unknown): string | undefined {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return asString(value);
}
