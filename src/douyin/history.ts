import { resolve } from 'node:path';
import protobuf from 'protobufjs';
import { normalizeMessageBody, type RealtimeMessageCandidate } from './protobuf.js';

const root = protobuf.load(resolve(process.cwd(), 'proto/douyin/History.proto'));
export function cursorId(value: unknown): string {
  const text = String(value);
  if (!/^\d{1,19}$/.test(text) || BigInt(text) > 9223372036854775807n) throw new Error('Invalid message cursor');
  return text;
}
export function nextSyncCursor(current: string, next: unknown, hasMore: boolean | undefined, itemCount: number): string {
  const value = cursorId(next ?? current);
  // The live service uses zero for an empty, exhausted stream. It is not a reset request.
  if (value === '0' && !hasMore && itemCount === 0) return current;
  if (BigInt(value) < BigInt(current)) throw new Error('Recovery cursor regressed');
  return value;
}
export async function encodeHistoryRequest(type: string, value: Record<string, unknown>): Promise<Buffer> {
  const schema = (await root).lookupType(type);
  return Buffer.from(schema.encode(schema.fromObject(value)).finish());
}
export async function decodeHistoryResponse(buffer: Buffer, command: number): Promise<Record<string, any>> {
  const schema = (await root).lookupType('HistoryResponse');
  const decoded = schema.decode(buffer);
  if (!Object.hasOwn(decoded, 'statusCode')) throw new Error('Message query has no status receipt');
  const value = schema.toObject(decoded, { longs: String, defaults: false });
  if (value.cmd !== command || value.statusCode !== 0) throw new Error(`Message query rejected: command=${value.cmd}, status=${value.statusCode}`);
  return value.body ?? {};
}
export function historyCandidates(page: Record<string, any>): RealtimeMessageCandidate[] {
  return (page.messages ?? []).filter((body: any) => !body.status).map((body: any) => normalizeMessageBody('imapi', body));
}
