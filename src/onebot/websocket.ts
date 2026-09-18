import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../config/index.js';
import type { AppLogger } from '../logger/index.js';
import type { OneBotActionRouter } from './actions.js';
import type { OneBotEvent } from './types.js';

export interface OneBotWebSocketRuntime {
  emit(event: OneBotEvent): void;
  stop(): Promise<void>;
}

export class OneBotWebSocketHub implements OneBotWebSocketRuntime {
  private readonly clients = new Set<WebSocket>();
  private readonly servers: WebSocketServer[] = [];
  private reverseSocket?: WebSocket;
  private reverseReconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly router: OneBotActionRouter
  ) {}

  async start(): Promise<void> {
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

  async stop(): Promise<void> {
    if (this.reverseReconnectTimer) {
      clearTimeout(this.reverseReconnectTimer);
    }

    this.reverseSocket?.close();

    for (const client of this.clients) {
      client.close();
    }

    await Promise.all(this.servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }

  private async startForwardServer(): Promise<void> {
    const server = new WebSocketServer({
      host: this.config.onebot.forwardWs.host,
      port: this.config.onebot.forwardWs.port
    });

    server.on('connection', (socket, request) => {
      if (!this.isAuthorized(request)) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      this.addClient(socket, 'forward websocket client connected');
    });

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
    const socket = new WebSocket(this.config.onebot.reverseWs.url, {
      headers: this.config.onebot.accessToken
        ? {
            Authorization: `Bearer ${this.config.onebot.accessToken}`
          }
        : undefined
    });

    this.reverseSocket = socket;

    socket.on('open', () => {
      this.addClient(socket, 'onebot reverse websocket connected');
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      this.logger.warn('onebot reverse websocket closed');
      this.reverseReconnectTimer = setTimeout(() => this.connectReverseWebSocket(), this.config.runtime.reconnectIntervalMs);
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
  }

  private async handleMessage(socket: WebSocket, payload: string): Promise<void> {
    try {
      const request = JSON.parse(payload);
      const response = await this.router.handle(request);
      socket.send(JSON.stringify(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      socket.send(
        JSON.stringify({
          status: 'failed',
          retcode: 10003,
          data: null,
          message,
          wording: message
        })
      );
    }
  }

  private broadcast(event: OneBotEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
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
