import type { Page, WebSocket } from 'playwright';
import type { AppLogger } from '../logger/index.js';

export interface NetworkEvent {
  time: number;
  type: 'request' | 'response' | 'response_body' | 'ws_open' | 'ws_frame_received' | 'ws_frame_sent' | 'ws_close';
  url: string;
  method?: string;
  status?: number;
  resourceType?: string;
  size?: number;
  payloadPreview?: string;
  contentType?: string;
}

export class NetworkRecorder {
  private readonly events: NetworkEvent[] = [];

  constructor(private readonly limit = 500) {}

  add(event: Omit<NetworkEvent, 'time'>): void {
    this.events.push({
      time: Date.now(),
      ...event
    });

    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
  }

  list(): NetworkEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events.splice(0);
  }
}

export function attachNetworkDiagnostics(page: Page, logger: AppLogger, recorder = new NetworkRecorder()): NetworkRecorder {
  page.on('request', request => {
    const url = request.url();
    if (!isInterestingUrl(url)) {
      return;
    }

    recorder.add({
      type: 'request',
      method: request.method(),
      url: sanitizeUrl(url),
      resourceType: request.resourceType(),
      payloadPreview: request.postData()?.slice(0, 2_000)
    });
  });

  page.on('response', response => {
    const url = response.url();
    if (!isInterestingUrl(url)) {
      return;
    }

    recorder.add({
      type: 'response',
      status: response.status(),
      url: sanitizeUrl(url)
    });

    if (/imapi\.douyin\.com|batch_play_info/i.test(url)) {
      void response
        .body()
        .then(body => {
          recorder.add({
            type: 'response_body',
            status: response.status(),
            url: sanitizeUrl(url),
            size: body.byteLength,
            contentType: response.headers()['content-type'],
            payloadPreview: body.subarray(0, 65_536).toString('base64')
          });
        })
        .catch(() => undefined);
    }
  });

  page.on('websocket', (ws: WebSocket) => {
    const safeUrl = sanitizeUrl(ws.url());
    recorder.add({
      type: 'ws_open',
      url: safeUrl
    });

    logger.info({ url: safeUrl }, 'douyin websocket opened');

    ws.on('framereceived', frame => {
      const payload =
        typeof frame.payload === 'string'
          ? frame.payload.slice(0, 200)
          : Buffer.from(frame.payload).subarray(0, 8192).toString('base64');
      recorder.add({
        type: 'ws_frame_received',
        url: safeUrl,
        size: typeof frame.payload === 'string' ? frame.payload.length : frame.payload.byteLength,
        contentType: typeof frame.payload === 'string' ? 'text/plain' : 'application/octet-stream',
        payloadPreview: payload
      });

      logger.debug(
        {
          url: safeUrl,
          size: typeof frame.payload === 'string' ? frame.payload.length : frame.payload.byteLength
        },
        'douyin websocket frame received'
      );
    });

    ws.on('framesent', frame => {
      const payload =
        typeof frame.payload === 'string'
          ? frame.payload.slice(0, 200)
          : Buffer.from(frame.payload).subarray(0, 8192).toString('base64');
      recorder.add({
        type: 'ws_frame_sent',
        url: safeUrl,
        size: typeof frame.payload === 'string' ? frame.payload.length : frame.payload.byteLength,
        contentType: typeof frame.payload === 'string' ? 'text/plain' : 'application/octet-stream',
        payloadPreview: payload
      });

      logger.debug(
        {
          url: safeUrl,
          size: typeof frame.payload === 'string' ? frame.payload.length : frame.payload.byteLength
        },
        'douyin websocket frame sent'
      );
    });

    ws.on('close', () => {
      recorder.add({
        type: 'ws_close',
        url: safeUrl
      });

      logger.warn({ url: safeUrl }, 'douyin websocket closed');
    });
  });

  return recorder;
}

function isInterestingUrl(url: string): boolean {
  return /douyin|zijieapi|byte|frontier|im|conversation|message|chat/i.test(url);
}

function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);
    for (const key of ['access_key', 'msToken', 'a_bogus', 'verifyFp', 'fp', 'uifid', 'webid', 'device_id']) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString();
  } catch {
    return input;
  }
}
