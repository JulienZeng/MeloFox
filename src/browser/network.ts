import type { Page, Request, WebSocket } from 'playwright';
import { scopedLogger, type AppLogger } from '../logger/index.js';

export interface NetworkEvent {
  time: number;
  type: 'request' | 'response' | 'response_body' | 'ws_open' | 'ws_frame_received' | 'ws_frame_sent' | 'ws_close';
  url: string;
  method?: string;
  status?: number;
  resourceType?: string;
  size?: number;
  payloadPreview?: string;
  payloadBase64?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export class NetworkRecorder {
  private readonly events: NetworkEvent[] = [];
  private readonly imSockets = new Set<WebSocket>();
  private readonly listeners = new Map<(event: NetworkEvent) => void, (error: unknown) => void>();

  constructor(private readonly limit = 500) {}

  add(event: Omit<NetworkEvent, 'time'>): void {
    const recorded = {
      time: Date.now(),
      ...event
    };
    this.events.push(recorded);

    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
    for (const [listener, onError] of this.listeners) {
      try { listener(recorded); } catch (error) { onError(error); }
    }
  }

  subscribe(listener: (event: NetworkEvent) => void, onError: (error: unknown) => void = () => {}): () => void {
    this.listeners.set(listener, onError);
    return () => { this.listeners.delete(listener); };
  }

  list(): NetworkEvent[] {
    return [...this.events];
  }

  trackWebSocket(socket: WebSocket): void {
    if (!socket.url().includes('frontier-im.douyin.com')) return;
    this.imSockets.add(socket);
    socket.on('close', () => this.imSockets.delete(socket));
  }

  isImConnected(): boolean {
    return this.imSockets.size > 0;
  }

  resetImConnections(): void {
    this.imSockets.clear();
  }

  clear(): void {
    this.events.splice(0);
  }
}

export function attachNetworkDiagnostics(page: Page, logger: AppLogger, recorder = new NetworkRecorder()): NetworkRecorder {
  logger = scopedLogger(logger, '抖音网络');
  let documentNavigation: Request | undefined;
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentNavigation = request;
  });
  page.on('requestfailed', request => {
    if (request === documentNavigation) documentNavigation = undefined;
  });
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    // Document teardown may omit WS close events; same-document SPA navigation must keep live sockets.
    if (documentNavigation || /^(?:about|data):/.test(frame.url())) {
      documentNavigation = undefined;
      recorder.resetImConnections();
    }
  });
  page.on('request', request => {
    const url = request.url();
    if (!isInterestingUrl(url)) {
      return;
    }

    void request
      .allHeaders()
      .catch(() => request.headers())
      .then(headers => {
        recorder.add({
          type: 'request',
          method: request.method(),
          url: sanitizeUrl(url),
          resourceType: request.resourceType(),
          headers: sanitizeHeaders(headers),
          payloadPreview: request.postData()?.slice(0, 2_000),
          payloadBase64: request.postDataBuffer()?.toString('base64'),
          size: request.postDataBuffer()?.byteLength
        });
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

    const contentType = response.headers()['content-type'] ?? '';
    if (shouldCaptureResponseBody(url, contentType)) {
      void response
        .body()
        .then(body => {
          recorder.add({
            type: 'response_body',
            status: response.status(),
            url: sanitizeUrl(url),
            size: body.byteLength,
            contentType,
            payloadBase64: /imapi\.douyin\.com/.test(url) ? body.toString('base64') : undefined,
            payloadPreview: body.subarray(0, 65_536).toString('base64')
          });
        })
        .catch(() => undefined);
    }
  });

  page.on('websocket', (ws: WebSocket) => {
    recorder.trackWebSocket(ws);
    const safeUrl = sanitizeUrl(ws.url());
    recorder.add({
      type: 'ws_open',
      url: safeUrl
    });

    logger.info({ url: safeUrl }, '抖音 WebSocket 已打开');

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
        payloadBase64: typeof frame.payload === 'string' ? undefined : Buffer.from(frame.payload).toString('base64'),
        payloadPreview: payload
      });

      logger.debug(
        {
          url: safeUrl,
          size: typeof frame.payload === 'string' ? frame.payload.length : frame.payload.byteLength
        },
        '接收抖音 WebSocket 数据帧'
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
        payloadBase64: typeof frame.payload === 'string' ? undefined : Buffer.from(frame.payload).toString('base64'),
        payloadPreview: payload
      });

      logger.debug(
        {
          url: safeUrl,
          size: typeof frame.payload === 'string' ? frame.payload.length : frame.payload.byteLength
        },
        '发送抖音 WebSocket 数据帧'
      );
    });

    ws.on('close', () => {
      recorder.add({
        type: 'ws_close',
        url: safeUrl
      });

      logger.warn({ url: safeUrl }, '抖音 WebSocket 已关闭');
    });
  });

  return recorder;
}

function isInterestingUrl(url: string): boolean {
  return /douyin|zijieapi|byte|frontier|im|conversation|message|chat/i.test(url);
}

function shouldCaptureResponseBody(url: string, contentType: string): boolean {
  if (/imapi\.douyin\.com|batch_play_info/i.test(url)) {
    return true;
  }

  return /(?:json|protobuf|text|x-www-form-urlencoded)/i.test(contentType);
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

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^authorization$/i.test(key)) {
      safe[key] = value
        .replace(/Credential=([^/,]+)(\/[^,]+)?/i, (_match, _accessKey, scope) => `Credential=[redacted]${scope ?? ''}`)
        .replace(/Signature=([0-9a-f]+)/i, 'Signature=[redacted]');
    } else if (/token|cookie|x-security-token/i.test(key)) {
      safe[key] = '[redacted]';
    } else {
      safe[key] = value;
    }
  }
  return safe;
}
