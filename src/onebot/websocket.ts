import { WebSocket, WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EventOutbox } from './outbox.js';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../config/index.js';
import { scopedLogger, type AppLogger } from '../logger/index.js';
import type { OneBotActionRouter } from './actions.js';
import type { OneBotActionRequest, OneBotEvent } from './types.js';
import { lifecycleEvent } from './events.js';
import { parseOneBotJson, stringifyOneBotJson } from './json.js';

export interface OneBotWebSocketRuntime {
  emit(event: OneBotEvent): Promise<void>;
  stop(): Promise<void>;
}

export class OneBotWebSocketHub implements OneBotWebSocketRuntime {
  private readonly clients = new Set<WebSocket>();
  private readonly servers: WebSocketServer[] = [];
  private reverseSocket?: WebSocket;
  private reverseReconnectTimer?: NodeJS.Timeout;
  private reverseFailures = 0;
  private lastReverseWarning?: { key: string; time: number };
  private reverseConnectionError?: string;
  private stopped = true;
  private stopPromise?: Promise<void>;
  private readonly outboxes = new Map<'forward' | 'reverse', EventOutbox>();
  private readonly kinds = new Map<WebSocket, 'forward' | 'reverse'>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly router: OneBotActionRouter
  ) {
    this.logger = scopedLogger(logger, 'OneBot WS');
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.stopPromise = undefined;
    this.reverseFailures = 0;
    this.lastReverseWarning = undefined;
    this.reverseConnectionError = undefined;
    for (const kind of ['forward', 'reverse'] as const) {
      if (!(kind === 'forward' ? this.config.onebot.forwardWs.enabled : this.config.onebot.reverseWs.enabled)) continue;
      const destination = kind === 'forward' ? `${this.config.onebot.forwardWs.host}:${this.config.onebot.forwardWs.port}` : this.config.onebot.reverseWs.url;
      const key = createHash('sha256').update(`${kind}:${destination}:${this.config.app.selfId}`).digest('hex');
      const outbox = new EventOutbox(join(this.config.runtime.messageCacheDir, 'events', `${key}.json`), this.config.app.selfId);
      await outbox.initialize(); this.outboxes.set(kind, outbox);
    }
    if (this.config.onebot.forwardWs.enabled) {
      await this.startForwardServer();
    }

    if (this.config.onebot.reverseWs.enabled) {
      this.connectReverseWebSocket();
    }
  }

  async emit(event: OneBotEvent): Promise<void> {
    if (this.stopped) return;
    if (event.post_type === 'meta_event') { this.broadcast(event); return; }
    await Promise.all([...this.outboxes].map(async ([kind, outbox]) => {
      await outbox.enqueue(event);
      // Await durability, but let reconnection/backpressure control delivery.
      this.flush(kind);
    }));
  }

  status(): { state: string; clients: number; pendingEvents: number; error?: string } {
    return {
      state: this.stopped ? 'waiting' : this.config.onebot.reverseWs.enabled
        ? this.reverseSocket?.readyState === WebSocket.OPEN ? 'connected' : 'connecting'
        : 'listening',
      clients: this.clients.size,
      pendingEvents: [...this.outboxes.values()].reduce((sum, outbox) => sum + outbox.size, 0),
      ...(this.reverseConnectionError ? { error: this.reverseConnectionError } : {})
    };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.reverseConnectionError = undefined;
    if (this.reverseReconnectTimer) {
      clearTimeout(this.reverseReconnectTimer);
      this.reverseReconnectTimer = undefined;
    }
    const sockets = new Set(this.clients);
    for (const server of this.servers) {
      for (const socket of server.clients) sockets.add(socket);
    }
    if (this.reverseSocket) sockets.add(this.reverseSocket);
    this.reverseSocket = undefined;
    this.stopPromise = Promise.all([
      ...Array.from(sockets, socket => this.closeSocket(socket)),
      ...this.servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))),
      ...[...this.outboxes.values()].map(outbox => outbox.settled())
    ]).then(() => { this.clients.clear(); this.kinds.clear(); });
    return this.stopPromise;
  }

  private async startForwardServer(): Promise<void> {
    const server = new WebSocketServer({
      host: this.config.onebot.forwardWs.host,
      port: this.config.onebot.forwardWs.port
    });

    server.on('connection', (socket, request) => {
      socket.on('error', error => this.logger.warn({ error }, '正向 WebSocket 客户端连接异常'));
      if (this.stopped) { socket.terminate(); return; }
      if (!this.isAuthorized(request)) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      this.addClient(socket, 'OneBot 正向 WebSocket 客户端已连接', 'forward');
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
    });
    server.on('error', error => this.logger.warn({ error }, '正向 WebSocket 服务异常'));
    this.servers.push(server);
    this.logger.info(
      {
        host: this.config.onebot.forwardWs.host,
        port: this.config.onebot.forwardWs.port
      },
      'OneBot 正向 WebSocket 服务已启动'
    );
  }

  private connectReverseWebSocket(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.config.onebot.reverseWs.url, {
      headers: {
        'X-Self-ID': this.config.app.selfId,
        'X-Client-Role': 'Universal',
        ...(this.config.onebot.accessToken ? { Authorization: `Bearer ${this.config.onebot.accessToken}` } : {})
      }
    });

    this.reverseSocket = socket;
    let connectionError: Error | undefined;
    const destination = new URL(this.config.onebot.reverseWs.url);
    // The configured URL may carry credentials or access_token query parameters.
    const endpoint = `${destination.protocol}//${destination.host}${destination.pathname}`;

    socket.on('open', () => {
      if (this.stopped) { socket.close(); return; }
      this.reverseFailures = 0;
      this.lastReverseWarning = undefined;
      this.reverseConnectionError = undefined;
      this.logger.info({ endpoint }, 'OneBot 反向 WebSocket 已连接');
      this.addClient(socket, undefined, 'reverse');
    });

    socket.on('close', code => {
      this.clients.delete(socket);
      if (this.reverseSocket === socket) this.reverseSocket = undefined;
      if (this.stopped) return;
      this.reverseConnectionError = describeReverseFailure(connectionError, code);
      this.reverseFailures++;
      const key = connectionError ? `${(connectionError as NodeJS.ErrnoException).code ?? ''}:${connectionError.message}` : `close:${code}`;
      const now = Date.now();
      if (!this.lastReverseWarning || this.lastReverseWarning.key !== key || now - this.lastReverseWarning.time >= 60000) {
        this.lastReverseWarning = { key, time: now };
        this.logger.warn({ endpoint, error: connectionError, closeCode: code, attempts: this.reverseFailures,
          retryMs: this.config.runtime.reconnectIntervalMs },
        connectionError ? 'OneBot 反向 WebSocket 连接失败，将自动重试；请检查机器人监听地址、端口和容器网络（相同错误每分钟汇总一次）'
          : 'OneBot 反向 WebSocket 已断开，将自动重连（相同错误每分钟汇总一次）');
      }
      this.reverseReconnectTimer = setTimeout(() => {
        this.reverseReconnectTimer = undefined;
        this.connectReverseWebSocket();
      }, this.config.runtime.reconnectIntervalMs);
    });

    socket.on('error', error => {
      connectionError = error;
    });
  }

  private addClient(socket: WebSocket, message: string | undefined, kind: 'forward' | 'reverse'): void {
    this.clients.add(socket);
    this.kinds.set(socket, kind);
    if (message) this.logger.info(message);

    socket.on('message', payload => {
      void this.handleMessage(socket, payload.toString());
    });

    socket.on('close', (code) => {
      if (kind === 'forward' && !this.stopped) this.logger.info({ closeCode: code }, 'OneBot 正向 WebSocket 客户端已断开');
      this.clients.delete(socket);
      this.kinds.delete(socket);
    });
    this.send(socket, lifecycleEvent(this.config, 'connect'));
    this.flush(kind);
  }

  private flush(kind: 'forward' | 'reverse'): void {
    void this.outboxes.get(kind)?.drain(async event => {
      if (this.stopped) return false;
      const sockets = [...this.clients].filter(socket => this.kinds.get(socket) === kind && socket.readyState === WebSocket.OPEN);
      if (!sockets.length) return false;
      const results = await Promise.all(sockets.map(socket => new Promise<boolean>(resolve => {
        if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.terminate(); resolve(false); return; }
        const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 10000);
        try { socket.send(stringifyOneBotJson(event), error => { clearTimeout(timer); resolve(!error); }); }
        catch { clearTimeout(timer); resolve(false); }
      })));
      return results.every(Boolean);
    }).catch(error => this.logger.error({ error }, 'OneBot 事件补发失败，未完成事件已保留'));
  }

  private async handleMessage(socket: WebSocket, payload: string): Promise<void> {
    try {
      const request = parseOneBotJson(payload) as OneBotActionRequest;
      const response = await this.router.handle(request);
      this.send(socket, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send(socket, {
        status: 'failed',
        retcode: 10003,
        data: null,
        message,
        wording: message
      });
    }
  }

  private broadcast(event: OneBotEvent): void {
    for (const client of this.clients) {
      this.send(client, event);
    }
  }

  private send(socket: WebSocket, value: unknown): void {
    if (this.stopped || socket.readyState !== WebSocket.OPEN) return;
    socket.send(stringifyOneBotJson(value), error => {
      if (error) this.logger.warn({ error }, 'OneBot WebSocket 发送失败');
    });
  }

  private closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => socket.terminate(), 1000);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close();
    });
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.config.onebot.accessToken) {
      return true;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    return (
      request.headers.authorization === `Bearer ${this.config.onebot.accessToken}` ||
      url.searchParams.get('access_token') === this.config.onebot.accessToken
    );
  }
}

function describeReverseFailure(error: Error | undefined, closeCode: number): string {
  if (!error) return `连接已断开（关闭码 ${closeCode}），正在重连`;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `无法解析目标地址（${code}），正在重试；使用容器名时请确认双方处于同一自定义 Docker 网络`;
  if (code === 'ECONNREFUSED') return '目标拒绝连接（ECONNREFUSED），正在重试；请确认机器人 WS 服务已启动，地址和端口正确';
  if (code === 'ETIMEDOUT' || /opening handshake has timed out/i.test(error.message)) return '连接超时，正在重试；请检查目标地址、容器网络及防火墙';
  const status = error.message.match(/Unexpected server response: (\d{3})/i)?.[1];
  if (status === '401' || status === '403') return `握手被拒绝（HTTP ${status}），正在重试；请检查双方令牌及访问权限`;
  if (status === '404') return 'WS 路径不存在（HTTP 404），正在重试；请检查机器人配置的连接路径';
  if (status) return `WS 握手失败（HTTP ${status}），正在重试；请检查机器人服务或反向代理配置`;
  return 'WebSocket 连接失败，正在重试；详细原因请查看服务日志';
}
