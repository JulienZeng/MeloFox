import { textSegment } from './message-segment.js';
import type { OneBotMessageSegment } from './types.js';

const entityValues: Record<string, string> = { amp: '&', '#91': '[', '#93': ']', '#44': ',' };
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);

export function parseCqMessage(message: string): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];
  const pattern = /\[CQ:([^,\[\]]+)((?:,[^\[\]]*)?)\]/g;
  let cursor = 0;
  for (const match of message.matchAll(pattern)) {
    if (match.index! > cursor) segments.push(textSegment(unescapeCq(message.slice(cursor, match.index), false)));
    const type = match[1];
    if (!validName(type)) throw new Error(`Invalid CQ message type: ${type}`);
    const data: OneBotMessageSegment['data'] = {};
    if (match[2]) {
      for (const param of match[2].slice(1).split(',')) {
        // URLs and base64 values may contain multiple equals signs.
        const separator = param.indexOf('=');
        const key = param.slice(0, separator);
        if (separator < 1 || !validName(key) || reservedKeys.has(key) || Object.hasOwn(data, key)) {
          throw new Error(`Invalid or duplicate CQ parameter: ${key || param}`);
        }
        data[key] = unescapeCq(param.slice(separator + 1), true);
      }
    }
    segments.push({ type, data });
    cursor = match.index! + match[0].length;
  }
  if (cursor < message.length) segments.push(textSegment(unescapeCq(message.slice(cursor), false)));
  return segments;
}

export function serializeCqMessage(segments: OneBotMessageSegment[]): string {
  return segments.map(segment => {
    if (segment.type === 'text') return escapeCq(String(segment.data.text ?? ''), false);
    if (!validName(segment.type)) throw new Error(`Invalid CQ message type: ${segment.type}`);
    const params: string[] = [];
    for (const [key, value] of Object.entries(segment.data)) {
      if (value === undefined) continue;
      if (!validName(key) || reservedKeys.has(key)) throw new Error(`Invalid CQ parameter: ${key}`);
      params.push(`${key}=${escapeCq(String(value), true)}`);
    }
    return `[CQ:${segment.type}${params.length ? `,${params.join(',')}` : ''}]`;
  }).join('');
}

function validName(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

function unescapeCq(value: string, parameter: boolean): string {
  // Decode once, after tokenization, so escaped text can never create executable CQ segments.
  return value.replace(parameter ? /&(amp|#91|#93|#44);/g : /&(amp|#91|#93);/g,
    (_match, entity: string) => entityValues[entity]);
}

function escapeCq(value: string, parameter: boolean): string {
  return value.replace(parameter ? /[&\[\],]/g : /[&\[\]]/g, char => {
    if (char === '&') return '&amp;';
    if (char === '[') return '&#91;';
    if (char === ']') return '&#93;';
    return '&#44;';
  });
}
