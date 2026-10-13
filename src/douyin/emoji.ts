import type { Page } from 'playwright';
import { z } from 'zod';
import type { OneBotMessageSegment } from '../onebot/types.js';

const catalogSchema = z.object({ status_code: z.literal(0), emoji_list: z.array(z.object({
  display_name: z.string().max(128), hide: z.number().int()
})).max(2000) });

export const qqFaceNames: Readonly<Record<string, string>> = { '66': '爱心' };

export function parseSmallEmojiCatalog(value: unknown): string[] {
  const catalog = catalogSchema.parse(value);
  const tokens = catalog.emoji_list.filter(item => item.hide === 0 && /^\[[^\[\]\x00-\x1f\x7f]{1,64}\]$/.test(item.display_name))
    .map(item => item.display_name);
  if (!tokens.length) throw new Error('Douyin small emoji catalog has no visible entries');
  return [...new Set(tokens)];
}

export function outgoingEmojiToken(segment: OneBotMessageSegment): string {
  if (segment.data.key !== undefined || segment.data.emoji_key !== undefined) throw new Error('Reaction keys require reaction mode and a reply target');
  let name: unknown;
  if (segment.type === 'face') {
    const id = segment.data.id ?? segment.data.face_id;
    name = (typeof id === 'string' || typeof id === 'number') && Object.hasOwn(qqFaceNames, String(id)) ? qqFaceNames[String(id)] : undefined;
    if (!name) throw new Error(`Unsupported QQ face mapping: ${String(id ?? '(empty)')}; use emoji.name for a Douyin emoji`);
  } else {
    name = segment.data.name ?? segment.data.text ?? segment.data.id;
    if (typeof name === 'string') {
      const aliases: Record<string, string> = { love: '爱心', heart: '爱心', ok: 'OK', '❤': '爱心', '❤️': '爱心', '👌': 'OK' };
      const trimmed = name.trim();
      const normalized = (trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed).toLowerCase();
      name = Object.hasOwn(aliases, normalized) ? aliases[normalized] : name;
    }
  }
  if (typeof name !== 'string') throw new Error('Douyin emoji must have a string name');
  const trimmed = name.trim();
  const token = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed : `[${trimmed}]`;
  if (!/^\[[^\[\]\x00-\x1f\x7f]{1,64}\]$/.test(token)) throw new Error('Invalid Douyin emoji name');
  return token;
}

export async function fetchSmallEmojiCatalog(page: Page, timeoutMs: number): Promise<string[]> {
  const value = await page.evaluate(async timeout => {
    const query = new URLSearchParams({ aid: '6383', device_platform: 'webapp', channel: 'channel_pc_web',
      pc_client_type: '1', version_code: '170400', update_version_code: '170400', need_all: 'true',
      cookie_enabled: String(navigator.cookieEnabled), browser_language: navigator.language, browser_platform: navigator.platform });
    const response = await fetch(`https://www.douyin.com/aweme/v1/web/emoji/list?${query}`, {
      credentials: 'include', signal: AbortSignal.timeout(timeout)
    });
    if (!response.ok) throw new Error(`Douyin emoji catalog HTTP failed: ${response.status}`);
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('Douyin emoji catalog exceeds size limit');
    return JSON.parse(text) as unknown;
  }, timeoutMs);
  return parseSmallEmojiCatalog(value);
}
