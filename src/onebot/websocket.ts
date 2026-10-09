import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../config/index.js';
import type { AppLogger } from '../logger/index.js';
import type { OneBotActionRouter } from './actions.js';
import type { OneBotActionRequest, OneBotEvent } from './types.js';
import { lifecycleEvent } from './events.js';
import { parseOneBotJson, stringifyOneBotJson } from './json.js';

export interface OneBotWebSocketRuntime {
  emit(event: OneBotEvent): void;
  stop(): Promise<void>;
}

export class OneBotWebSocketHub implements OneBotWebSocketRuntime {
  private readonly clients = new Set<WebSocket>();
  private readonly servers: WebSocketServer[] = [];
  private reverseSocket?: WebSocket;
  private reverseReconnectTimer?: NodeJS.Timeout;
  private stopped = true;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly router: OneBotActionRouter
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.stopPromise = undefined;
    if (this.config.onebot.forwardWs.enabled) {
      await this.startForwardServer();
    }

    if (this.config.onebot.reverseWs.enabled) {
      this.connectReverseWebSocket();
    }
  }

  emit(event: OneBotEvent): void {
    this.broadcast(event);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
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
      ...this.servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
    ]).then(() => { this.clients.clear(); });
    return this.stopPromise;
  }

  private async startForwardServer(): Promise<void> {
    const server = new WebSocketServer({
      host: this.config.onebot.forwardWs.host,
      port: this.config.onebot.forwardWs.port
    });

    server.on('connection', (socket, request) => {
      socket.on('error', error => this.logger.warn({ error }, 'onebot forward websocket error'));
      if (this.stopped) { socket.terminate(); return; }
      if (!this.isAuthorized(request)) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      this.addClient(socket, 'forward websocket client connected');
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
    });
    server.on('error', error => this.logger.warn({ error }, 'onebot forward websocket server error'));
    this.servers.push(server);
    this.logger.info(
      {
        host: this.config.onebot.forwardWs.host,
        port: this.config.onebot.forwardWs.port
      },
      'onebot forward websocket server started'
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

    socket.on('open', () => {
      if (this.stopped) { socket.close(); return; }
      this.addClient(socket, 'onebot reverse websocket connected');
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      if (this.reverseSocket === socket) this.reverseSocket = undefined;
      if (this.stopped) return;
      this.logger.warn('onebot reverse websocket closed');
      this.reverseReconnectTimer = setTimeout(() => {
        this.reverseReconnectTimer = undefined;
        this.connectReverseWebSocket();
      }, this.config.runtime.reconnectIntervalMs);
    });

    socket.on('error', error => {
      this.logger.warn({ error }, 'onebot reverse websocket error');
    });
  }

  private addClient(socket: WebSocket, message: string): void {
    this.clients.add(socket);
    this.logger.info(message);

    socket.on('message', payload => {
      void this.handleMessage(socket, payload.toString());
    });

    socket.on('close', () => {
      this.clients.delete(socket);
    });
    this.send(socket, lifecycleEvent(this.config, 'connect'));
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
      if (error) this.logger.warn({ error }, 'onebot websocket send failed');
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
