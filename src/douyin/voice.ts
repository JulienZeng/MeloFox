import { parse } from 'lossless-json';
import type { OneBotMessageSegment } from '../onebot/types.js';

/** The PC SDK identifies 109 (IM_ENCRYPT_VOICE) and 501 (ENCRYPT_VOICE) separately from plain 17. */
export function isVoiceMessageType(type: number | undefined): boolean {
  return type === 17 || type === 109 || type === 501;
}

/** Type 17 carries a plain voice URL; encrypted variants need a verified decryption protocol. */
export function voiceUrl(content: string | undefined): string | undefined {
  let value: any;
  try { value = parse(content ?? ''); } catch { return undefined; }
  const urls = value?.resource_url?.url_list;
  if (!Array.isArray(urls)) return undefined;
  for (const item of urls) {
    if (typeof item !== 'string' || /[\x00-\x20\x7f]/.test(item)) continue;
    try {
      const url = new URL(item.replace(/\\u0026/gi, '&'));
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
    } catch { /* Ignore invalid resource candidates. */ }
  }
  return undefined;
}

export function voiceSegment(type: number, cachedUrl?: string): OneBotMessageSegment {
  return type === 17 && cachedUrl ? { type: 'record', data: { file: cachedUrl } }
    : { type: 'text', data: { text: type === 109 || type === 501 ? '[加密语音暂不支持]' : '[语音暂不可用]' } };
}
