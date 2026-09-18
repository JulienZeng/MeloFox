import { resolve } from 'node:path';
import protobuf from 'protobufjs';
import type { NetworkEvent } from '../browser/network.js';

interface ProtoCandidate {
  file: string;
  type: string;
}

const candidates: ProtoCandidate[] = [
  {
    file: 'GetUserMsgResponse.proto',
    type: 'GetUserMsgResponse'
  },
  {
    file: 'DyStrangerMsgResponse.proto',
    type: 'DyStrangerMsgResponse'
  },
  {
    file: 'ChatMessage.proto',
    type: 'Response'
  },
  {
    file: 'ChatMessage.proto',
    type: 'PushFrame'
  }
];

const loadedTypes = new Map<string, Promise<protobuf.Type>>();

export interface DecodedNetworkEvent {
  url: string;
  size?: number;
  contentType?: string;
  candidates: Array<{
    type: string;
    value: unknown;
  }>;
}

export interface RealtimeMessageCandidate {
  source: string;
  conversationId?: string;
  conversationType?: number;
  serverMessageId?: string;
  conversationShortId?: string;
  sender?: string;
  messageType?: number;
  text?: string;
  content?: string;
  mediaUrl?: string;
  createTime?: string;
  reference?: RealtimeMessageReference;
  raw: unknown;
}

export interface RealtimeMessageReference {
  messageId?: string;
  content?: string;
  refmsgContent?: string;
  refmsgType?: number;
  refmsgUid?: string;
  nickname?: string;
  raw?: unknown;
}

export async function decodeNetworkResponseBodies(events: NetworkEvent[]): Promise<DecodedNetworkEvent[]> {
  const responseBodies = events.filter(
    event =>
      (event.type === 'response_body' || event.type === 'ws_frame_received' || event.type === 'ws_frame_sent') &&
      event.payloadPreview &&
      event.contentType !== 'text/plain'
  );
  const decoded: DecodedNetworkEvent[] = [];

  for (const event of responseBodies) {
    const buffer = Buffer.from(event.payloadPreview ?? '', 'base64');
    const decodedEvent: DecodedNetworkEvent = {
      url: event.url,
      size: event.size,
      contentType: event.contentType,
      candidates: []
    };

    for (const candidate of candidates) {
      const value = await tryDecode(buffer, candidate);
      if (value) {
        decodedEvent.candidates.push({
          type: candidate.type,
          value
        });

        if (candidate.type === 'PushFrame' && isRecord(value) && typeof value.payload === 'string') {
          const responseValue = await tryDecode(Buffer.from(value.payload, 'base64'), {
            file: 'ChatMessage.proto',
            type: 'Response'
          });
          if (responseValue) {
            attachMessageExtras(responseValue, Buffer.from(value.payload, 'base64'));
            decodedEvent.candidates.push({
              type: 'Response',
              value: responseValue
            });
          }
        }
      }
    }

    decoded.push(decodedEvent);
  }

  return decoded;
}

export async function extractRealtimeMessageCandidates(events: NetworkEvent[]): Promise<RealtimeMessageCandidate[]> {
  const decoded = await decodeNetworkResponseBodies(events);
  return extractRealtimeMessageCandidatesFromDecoded(decoded);
}

export function extractRealtimeMessageCandidatesFromDecoded(decoded: DecodedNetworkEvent[]): RealtimeMessageCandidate[] {
  const messages: RealtimeMessageCandidate[] = [];

  for (const event of decoded) {
    for (const candidate of event.candidates) {
      collectMessageCandidate(candidate.type, candidate.value, event.url, messages);
    }
  }

  return messages;
}

export async function extractRealtimeMessageDetails(events: NetworkEvent[]): Promise<RealtimeMessageCandidate[]> {
  const decoded = await decodeNetworkResponseBodies(events);
  return extractRealtimeMessageDetailsFromDecoded(decoded);
}

export function extractRealtimeMessageDetailsFromDecoded(decoded: DecodedNetworkEvent[]): RealtimeMessageCandidate[] {
  const messages: RealtimeMessageCandidate[] = [];

  for (const event of decoded) {
    for (const candidate of event.candidates) {
      if (candidate.type === 'GetUserMsgResponse' && isRecord(candidate.value)) {
        collectMessageDetails(event.url, candidate.value, messages);
      }
    }
  }

  return messages;
}

async function tryDecode(buffer: Buffer, candidate: ProtoCandidate): Promise<unknown | undefined> {
  try {
    const type = await loadType(candidate);
    const decoded = type.decode(buffer);
    return type.toObject(decoded, {
      longs: String,
      enums: String,
      bytes: String,
      defaults: false
    });
  } catch {
    return undefined;
  }
}

function loadType(candidate: ProtoCandidate): Promise<protobuf.Type> {
  const key = `${candidate.file}:${candidate.type}`;
  const existing = loadedTypes.get(key);
  if (existing) {
    return existing;
  }

  const promise = protobuf
    .load(resolve(process.cwd(), 'proto/douyin', candidate.file))
    .then(root => root.lookupType(candidate.type));
  loadedTypes.set(key, promise);
  return promise;
}

function collectMessageCandidate(type: string, value: unknown, source: string, out: RealtimeMessageCandidate[]): void {
  if (type === 'Response' && isRecord(value)) {
    const body = value.body;
    if (!isRecord(body)) {
      return;
    }
    const notify = body.hasNewMessageNotify;
    if (!isRecord(notify)) {
      return;
    }
    const message = notify.message;
    if (!isRecord(message)) {
      return;
    }

    out.push(normalizeMessageBody(source, message));
  }

  if ((type === 'GetUserMsgResponse' || type === 'DyStrangerMsgResponse') && isRecord(value)) {
    collectNestedMessageBodies(source, value, out);
  }
}

function collectNestedMessageBodies(source: string, value: unknown, out: RealtimeMessageCandidate[]): void {
  if (!isRecord(value)) {
    return;
  }

  if (
    typeof value.conversationId === 'string' &&
    (typeof value.content === 'string' || typeof value.textContent === 'string' || typeof value.serverMessageId === 'string')
  ) {
    out.push(normalizeMessageBody(source, value));
  }

  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        collectNestedMessageBodies(source, item, out);
      }
    } else if (isRecord(entry)) {
      collectNestedMessageBodies(source, entry, out);
    }
  }
}

function normalizeMessageBody(source: string, body: Record<string, unknown>): RealtimeMessageCandidate {
  const content = stringValue(body.content) ?? stringValue(body.textContent);
  return {
    source,
    conversationId: stringValue(body.conversationId),
    conversationType: numberValue(body.conversationType),
    serverMessageId: stringValue(body.serverMessageId),
    conversationShortId: stringValue(body.conversationShortId),
    sender: stringValue(body.sender),
    messageType: numberValue(body.messageType ?? body.contentType),
    content,
    text: parseTextContent(content),
    createTime: stringValue(body.createTime),
    reference: normalizeReference(body.__douyinOneBotReference),
    raw: body
  };
}

function collectMessageDetails(source: string, value: unknown, out: RealtimeMessageCandidate[]): void {
  if (!isRecord(value)) {
    return;
  }

  const detail = normalizeMessageDetail(source, value);
  if (detail) {
    out.push(detail);
  }

  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        collectMessageDetails(source, item, out);
      }
    } else if (isRecord(entry)) {
      collectMessageDetails(source, entry, out);
    }
  }
}

function normalizeMessageDetail(source: string, value: Record<string, unknown>): RealtimeMessageCandidate | undefined {
  const serverMessageId = stringValue(value.timestamp);
  const content = stringValue(value.jsonData);
  if (!serverMessageId || !content) {
    return undefined;
  }

  return {
    source,
    conversationId: stringValue(value.identifier),
    serverMessageId,
    conversationShortId: stringValue(value.contentId) ?? stringValue(value.userId),
    sender: stringValue(value.shareId),
    messageType: numberValue(value.statusCode),
    content,
    text: parseTextContent(content),
    createTime: stringValue(value.createTime),
    raw: value
  };
}

function attachMessageExtras(responseValue: unknown, responseBuffer: Buffer): void {
  if (!isRecord(responseValue)) {
    return;
  }

  const message = getResponseMessage(responseValue);
  if (!message) {
    return;
  }

  const messageBuffer = getNestedLengthDelimitedField(responseBuffer, [6, 500, 5]);
  if (!messageBuffer) {
    return;
  }

  const reference = decodeReferenceField(messageBuffer);
  if (reference) {
    message.__douyinOneBotReference = reference;
  }
}

function getResponseMessage(responseValue: Record<string, unknown>): Record<string, unknown> | undefined {
  const body = responseValue.body;
  if (!isRecord(body)) {
    return undefined;
  }
  const notify = body.hasNewMessageNotify;
  if (!isRecord(notify)) {
    return undefined;
  }
  const message = notify.message;
  return isRecord(message) ? message : undefined;
}

function decodeReferenceField(messageBuffer: Buffer): RealtimeMessageReference | undefined {
  for (const field of readWireFields(messageBuffer)) {
    if (field.no !== 18 || field.wireType !== 2 || !field.bytes) {
      continue;
    }

    const reference: RealtimeMessageReference = {
      raw: {}
    };

    for (const nested of readWireFields(field.bytes)) {
      if (nested.no === 1 && nested.varint !== undefined) {
        reference.messageId = nested.varint;
      }
      if (nested.no === 2 && nested.bytes) {
        const rawText = nested.bytes.toString('utf8');
        const parsed = parseJsonObject(rawText);
        reference.raw = parsed ?? rawText;
        if (parsed) {
          reference.content = stringValue(parsed.content);
          reference.refmsgContent = stringValue(parsed.refmsg_content);
          reference.refmsgType = numberValue(parsed.refmsg_type);
          reference.refmsgUid = stringValue(parsed.refmsg_uid);
          reference.nickname = stringValue(parsed.nickname);
        }
      }
    }

    return reference;
  }

  return undefined;
}

function normalizeReference(value: unknown): RealtimeMessageReference | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    messageId: stringValue(value.messageId),
    content: stringValue(value.content),
    refmsgContent: stringValue(value.refmsgContent),
    refmsgType: numberValue(value.refmsgType),
    refmsgUid: stringValue(value.refmsgUid),
    nickname: stringValue(value.nickname),
    raw: value.raw
  };
}

interface WireField {
  no: number;
  wireType: number;
  varint?: string;
  bytes?: Buffer;
}

function getNestedLengthDelimitedField(buffer: Buffer, path: number[]): Buffer | undefined {
  let current: Buffer | undefined = buffer;
  for (const fieldNo of path) {
    if (!current) {
      return undefined;
    }

    current = readWireFields(current).find(field => field.no === fieldNo && field.wireType === 2)?.bytes;
  }

  return current;
}

function readWireFields(buffer: Buffer): WireField[] {
  const fields: WireField[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const no = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    const field: WireField = {
      no,
      wireType
    };

    if (wireType === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      field.varint = value.value.toString();
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      field.bytes = buffer.subarray(offset, offset + Number(length.value));
      offset += Number(length.value);
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }

    fields.push(field);
  }

  return fields;
}

function readVarint(buffer: Buffer, offset: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;

  while (offset < buffer.length) {
    const byte = buffer[offset];
    offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, offset };
    }
    shift += 7n;
  }

  throw new Error('Invalid protobuf varint');
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseTextContent(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.text === 'string') {
      return parsed.text;
    }
  } catch {
    return content;
  }
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
