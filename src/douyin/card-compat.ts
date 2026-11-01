import { isLosslessNumber, parse, parseNumberAndBigInt } from 'lossless-json';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { OneBotMessageSegment } from '../onebot/types.js';
import type { NativeMessageContent } from './native-message.js';

export interface LocationInput { lat: number; lon: number; title: string; content: string }
export function locationInput(data: Record<string, unknown>): LocationInput {
  const coord = (key: string, bound: number) => {
    const value = data[key];
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(value)) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > bound) throw new Error(`Invalid location ${key}`);
    return Number(value);
  };
  const text = (key: string, fallback: string) => {
    if (data[key] === undefined) return fallback;
    if (typeof data[key] !== 'string' || data[key].length > 2048 || /[\x00-\x1f\x7f]/.test(data[key])) throw new Error(`Invalid location ${key}`);
    return data[key];
  };
  return { lat: coord('lat', 90), lon: coord('lon', 180), title: text('title', '位置'), content: text('content', '') };
}
export function buildLocationContent(input: LocationInput): NativeMessageContent {
  const v = locationInput({ ...input });
  return { messageType: 502, content: JSON.stringify({ latitude: v.lat, longitude: v.lon, poi_name: v.title, poi_address: v.content }), text: `[位置] ${v.title} ${v.lat},${v.lon}` };
}
export function locationSegment(content?: string): OneBotMessageSegment | undefined {
  try {
    const v = parse(content ?? '', undefined, parseNumberAndBigInt) as any;
    const input = locationInput({ lat: String(v.latitude), lon: String(v.longitude), title: v.poi_name, content: v.poi_address });
    return { type: 'location', data: { ...input } };
  } catch { return undefined; }
}

/** Recognised share envelopes only. Never accept arbitrary IM message types or executable XML. */
export function unpackCardEnvelope(type: 'json' | 'xml', data: unknown): OneBotMessageSegment {
  if (typeof data !== 'string' || !data || Buffer.byteLength(data) > 64 * 1024) throw new Error('Card data must be a JSON/XML string up to 64 KiB');
  if (type === 'json') {
    const value = parse(data, (_key, v) => isLosslessNumber(v) ? (Number.isSafeInteger(Number(v.value)) ? Number(v.value) : v.value) : v) as any;
    if (value && ['share', 'location', 'contact', 'music'].includes(value.type) && value.data && typeof value.data === 'object' && !Array.isArray(value.data) &&
        Object.values(value.data).every(v => ['string', 'number', 'boolean'].includes(typeof v))) return value;
    const news = value?.app === 'com.tencent.structmsg' ? value.meta?.news : undefined;
    if (!news || typeof news !== 'object' || Array.isArray(news)) throw new Error('Unsupported JSON card; expected a OneBot card or com.tencent.structmsg news');
    return share(news.jumpUrl, news.title, news.desc, news.preview);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(data) || XMLValidator.validate(data) !== true) throw new Error('Invalid XML card; DTD and entities are not supported');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, processEntities: true }).parse(data);
  const msg = parsed.msg;
  if (!msg || msg['@_serviceID'] !== '1' || !msg.item || Array.isArray(msg.item)) throw new Error('Unsupported XML card; expected serviceID=1 with one item');
  const text = (v: unknown) => typeof v === 'string' ? v : v && typeof v === 'object' ? (v as any)['#text'] : undefined;
  return share(msg['@_url'], text(msg.item.title), text(msg.item.summary), msg.item.picture?.['@_cover']);
}
function share(url: unknown, title: unknown, content: unknown, image: unknown): OneBotMessageSegment {
  if (typeof url !== 'string' || typeof title !== 'string' || [content, image].some(v => v !== undefined && typeof v !== 'string')) throw new Error('Invalid share card fields');
  return { type: 'share', data: { url, title, ...(content ? { content: content as string } : {}), ...(image ? { image: image as string } : {}) } };
}
