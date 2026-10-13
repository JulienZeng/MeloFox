import type { Page } from 'playwright';

export interface DouyinFileResource {
  uri: string;
  conversationShortId: string;
  messageId: string;
}

export async function resolveDouyinFileUrl(page: Page, resource: DouyinFileResource): Promise<string> {
  if (!/^tos-[a-z0-9-]+\/[a-zA-Z0-9/_-]+$/.test(resource.uri) ||
      ![resource.conversationShortId, resource.messageId].every(id => /^[1-9]\d*$/.test(id) && BigInt(id) <= 9223372036854775807n)) {
    throw new Error('File resolver requires a valid resource, conversation and message ID');
  }
  const result = await page.evaluate(async input => {
    const query = new URLSearchParams({ aid: '6383', device_platform: 'webapp', app_name: 'douyin_web',
      conv_short_id: input.conversationShortId, msg_id: input.messageId, uri: input.uri });
    const response = await fetch(`/aweme/v1/web/im/file/meta/?${query}`, {
      credentials: 'include', signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`File resolver HTTP ${response.status}`);
    return await response.json() as { status_code?: number; status_msg?: string; meta?: Record<string, unknown> };
  }, resource);
  if (result.status_code !== 0) throw new Error(`File resolver failed: ${result.status_code} ${result.status_msg ?? ''}`);
  const meta = result.meta;
  if (!meta || meta.uri !== resource.uri || meta.file_status !== 0) {
    throw new Error('File resolver returned an unavailable or mismatched resource');
  }
  const now = Date.now() / 1000;
  for (const field of ['url_expire_time', 'file_expire_time']) {
    const expiry = meta[field];
    if (expiry !== undefined && (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= now)) {
      throw new Error('File resolver returned an expired resource');
    }
  }
  const urls = meta.url_list;
  if (!Array.isArray(urls)) throw new Error('File resolver returned no downloadable URL');
  const url = urls.find(value => {
    if (typeof value !== 'string') return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && parsed.hostname.endsWith('.douyinstatic.com') &&
        !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443');
    } catch { return false; }
  });
  if (!url) throw new Error('File resolver returned no downloadable URL');
  return url;
}
