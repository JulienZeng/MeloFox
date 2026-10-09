import type { Page } from 'playwright';

export async function resolveDouyinVideoUrl(page: Page, tosKey: string): Promise<string | undefined> {
  const result = await page.evaluate(async key => {
    const query = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      app_name: 'douyin_web',
      pc_client_type: '1',
      pc_libra_divert: 'Mac',
      update_version_code: '170400',
      support_h265: '0',
      support_dash: '0',
      version_code: '170400',
      version_name: '17.4.0'
    });

    const response = await fetch(`/aweme/v1/web/maya/story/batch_play_info/v1/?${query.toString()}`, {
      method: 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        req_infos: [
          {
            item_id: 0,
            tos_key: key,
            type: 2
          }
        ],
        with_caption: true
      })
    });

    return {
      ok: response.ok,
      status: response.status,
      text: await response.text()
    };
  }, tosKey);

  if (!result.ok) {
    return undefined;
  }

  return pickVideoUrl(parseJson(result.text));
}

export function extractDouyinVideoKey(parsedContent: unknown): string | undefined {
  if (!isRecord(parsedContent)) {
    return undefined;
  }

  const video = parsedContent.video;
  if (!isRecord(video)) {
    return undefined;
  }

  const tkey = stringValue(video.tkey);
  if (tkey) {
    return tkey;
  }

  const vid = stringValue(video.vid);
  return vid ? `vid-${vid}` : undefined;
}

export function extractDouyinVideoSkey(parsedContent: unknown): string | undefined {
  if (!isRecord(parsedContent)) {
    return undefined;
  }

  const video = parsedContent.video;
  if (!isRecord(video)) {
    return undefined;
  }

  const skey = stringValue(video.skey);
  return skey && /^[0-9a-f]{32}$/i.test(skey) ? skey : undefined;
}

export function pickVideoUrl(value: unknown): string | undefined {
  const urls = collectUrls(value);
  return urls.find(isDouyinVideoUrl) ?? urls.find(isLikelyVideoUrl);
}

function collectUrls(value: unknown, out = new Set<string>()): string[] {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      out.add(value);
      return [...out];
    }

    const parsed = parseJson(value);
    if (parsed !== undefined && parsed !== value) {
      collectUrls(parsed, out);
    }
    return [...out];
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrls(item, out);
    }
    return [...out];
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectUrls(item, out);
    }
  }

  return [...out];
}

function isDouyinVideoUrl(value: string): boolean {
  return /(?:douyinvod\.com|\.v\.smtcdns\.com)\//i.test(value) && /(?:\/video\/|mime_type=video_|sc=video)/i.test(value);
}

function isLikelyVideoUrl(value: string): boolean {
  return /\.(?:mp4|mov|m4v|webm|avi)(?:[?#].*)?$/i.test(value) || /mime_type=video_/i.test(value);
}

function parseJson(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
