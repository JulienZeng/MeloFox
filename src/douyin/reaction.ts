import { resolve } from 'node:path';
import protobuf from 'protobufjs';
import type { RealtimeMessageCandidate } from './protobuf.js';

const root = protobuf.load(resolve(process.cwd(), 'proto/douyin/Reaction.proto'));

export interface ReactionState {
  messageId: string;
  conversationId: string;
  conversationShortId: string;
  conversationType: number;
  version: string;
  properties: Record<string, { items: Array<{ uid: string; idempotentId: string; value: string; createTime?: string }> }>;
}

export async function encodeReactionQuery(input: {
  conversationId: string; conversationShortId: string; conversationType: 1 | 2; messageId: string
}): Promise<Buffer> {
  for (const id of [input.conversationShortId, input.messageId]) {
    if (!/^[1-9]\d*$/.test(id) || BigInt(id) > 9223372036854775807n) throw new Error('Reaction query requires valid numeric IDs');
  }
  const type = (await root).lookupType('ReactionQueryRequest');
  return Buffer.from(type.encode(type.fromObject({ ...input, serverMessageId: input.messageId, onlyStatus: false })).finish());
}

export async function decodeReactionQuery(buffer: Buffer): Promise<ReactionState> {
  const type = (await root).lookupType('ReactionQueryResponse');
  const value = type.toObject(type.decode(buffer), { longs: String, defaults: true }) as {
    cmd: number; statusCode: number; body?: { result?: { msgInfo?: { status: number; body?: {
      serverMessageId: string; conversationId: string; conversationShortId: string; conversationType: number;
      version: string; propertyList?: ReactionState['properties']; status: number
    } } } }
  };
  if (value.cmd !== 211 || value.statusCode !== 0) throw new Error(`Douyin reaction query failed: cmd=${value.cmd} status=${value.statusCode}`);
  const info = value.body?.result?.msgInfo;
  const message = info?.body;
  if (info?.status !== 0 || !message || message.status !== 0 || !/^[1-9]\d*$/.test(message.serverMessageId)) {
    throw new Error('Reaction target is missing, invisible, recalled or deleted');
  }
  return { messageId: message.serverMessageId, conversationId: message.conversationId,
    conversationShortId: message.conversationShortId, conversationType: message.conversationType,
    version: message.version, properties: message.propertyList ?? {} };
}

export async function decodeQueriedMessage(buffer: Buffer): Promise<RealtimeMessageCandidate> {
  // Reuse the same visibility/status checks as the reaction query.
  await decodeReactionQuery(buffer);
  const type = (await root).lookupType('ReactionQueryResponse');
  const response = type.toObject(type.decode(buffer), { longs: String, defaults: false }) as any;
  const body = response.body.result.msgInfo.body;
  return { source: 'imapi', ...body, clientMessageId: body.ext?.find((entry: { key: string }) => entry.key === 's:client_message_id')?.value, raw: body };
}
