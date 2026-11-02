import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import type { AppLogger } from '../logger/index.js';
import type { BrowserRuntime } from '../browser/chromium.js';
import type { DouyinBridge } from '../douyin/bridge.js';
import { LoginAssist } from '../douyin/login-assist.js';
import { ChannelManager } from './channels.js';
import { registerConsoleAssets } from './assets.js';
import { registerConsoleAuthentication } from './auth.js';
import { RuntimeMetrics } from './metrics.js';
import { AccountProfile, AVATAR_DOMAINS } from './account-profile.js';
import type { ConsoleStatus } from './contracts.js';
import {
  DouyinLogin,
  PassportError,
  clearBrowserLogin,
  browserPassportTransport
} from '../douyin/login.js';

export class ConsoleControl {
  readonly metrics = new RuntimeMetrics(undefined, undefined, () => this.browser?.context?.browser?.() ?? null);
  readonly profile = new AccountProfile(() => this.bridge);
  browser?: BrowserRuntime;
  bridge?: DouyinBridge;
  recover?: (reason: string) => void;
  checkSession?: () => Promise<void>;
  error?: string;
  login?: DouyinLogin;
  assisting?: () => boolean;
  readonly startedAt = Date.now();
  readonly activity: Array<{ time: string; message: string }> = [];
  constructor(readonly channels: ChannelManager) {}
  record(message: string) {
    this.activity.unshift({ time: new Date().toISOString(), message });
    this.activity.splice(50);
  }
  detached() {
    this.browser = undefined;
    this.bridge = undefined;
    this.recover = undefined;
    this.checkSession = undefined;
  }
  status(): ConsoleStatus {
    void this.profile.refresh();
    let chromiumVersion: string | undefined;
    try { chromiumVersion = this.browser?.context?.browser?.()?.version(); } catch { /* Browser may be restarting. */ }
    return {
      serverTime: Date.now(),
      startedAt: this.startedAt,
      runtime: { ...this.metrics.snapshot(), chromiumVersion },
      account: {
        loggedIn: this.bridge?.loggedIn ?? false,
        id: this.bridge?.loggedIn ? this.bridge.accountId : undefined,
        ...this.profile.snapshot(),
        ...this.bridge?.getStatus()
      },
      browser:
        this.browser && !this.browser.page.isClosed()
          ? 'ready'
          : this.error
            ? 'error'
            : 'starting',
      error: this.error,
      channels: this.channels.list(),
      activity: this.activity,
      login: this.login?.status()
    };
  }
}

export async function createConsoleServer(
  config: AppConfig,
  logger: AppLogger,
  control: ConsoleControl,
  options: { development?: boolean } = {}
): Promise<FastifyInstance> {
  control.login ??= new DouyinLogin(
    config,
    browserPassportTransport(() => control.browser),
    () => {
      control.record('抖音登录配置已保存');
      control.recover?.('Douyin API login completed; restore saved session');
    }
  );
  const assist = new LoginAssist(() => control.browser);
  control.assisting = () => assist.active;
  const server = Fastify({ bodyLimit: 16 * 1024, requestTimeout: 15_000 });
  let developmentNonce: string | undefined;
  server.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self'${developmentNonce ? ` 'nonce-${developmentNonce}'` : ''}; img-src 'self' blob: ${AVATAR_DOMAINS.flatMap(host => [`https://${host}`, `https://*.${host}`]).join(' ')}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
    );
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.origin;
      let validOrigin = true;
      if (origin) {
        try {
          const url = new URL(origin);
          validOrigin = ['http:', 'https:'].includes(url.protocol) && url.host === request.headers.host;
        } catch { validOrigin = false; }
      }
      if (
        request.headers['sec-fetch-site'] === 'cross-site' ||
        !validOrigin
      ) {
        return reply.code(403).send({ message: '不允许跨站操作' });
      }
    }
  });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof PassportError)
      return reply
        .code(error.statusCode)
        .send({ message: error.message, code: error.code });
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ message: error.issues.map((i) => i.message).join('；') });
    const failure = error as Error & { statusCode?: number; code?: string };
    const status = failure.statusCode ?? 500;
    const requestErrors: Record<string, string> = {
      FST_ERR_CTP_INVALID_JSON_BODY: '请求内容格式不正确，请刷新页面重试',
      FST_ERR_CTP_EMPTY_JSON_BODY: '请求内容为空，请填写后重试',
      FST_ERR_CTP_BODY_TOO_LARGE: '提交的内容过长，请减少输入',
      FST_ERR_CTP_INVALID_MEDIA_TYPE: '请求格式不正确，请刷新页面重试'
    };
    return reply.code(status).send({
      message: status >= 500 ? '服务暂时不可用，请稍后重试' : requestErrors[failure.code ?? ''] ?? failure.message
    });
  });
  await registerConsoleAuthentication(server, config, logger);
  server.addHook('onReady', () => control.metrics.start(config.web.dataDir));
  server.addHook('onClose', () => control.metrics.stop());
  if (options.development) {
    const { registerConsoleDevAssets } = await import('./dev-assets.js');
    developmentNonce = await registerConsoleDevAssets(server);
  } else {
    await registerConsoleAssets(server);
  }
  server.get('/api/status', async () => control.status());
  server.post('/api/channels', async (request, reply) => {
    await control.channels.save(request.body);
    control.record('创建通道');
    return reply.code(201).send({ ok: true });
  });
  server.put<{ Params: { id: string } }>(
    '/api/channels/:id',
    async (request) => {
      await control.channels.save(request.body, request.params.id);
      control.record('更新通道配置');
      return { ok: true };
    }
  );
  server.delete<{ Params: { id: string } }>(
    '/api/channels/:id',
    async (request) => {
      await control.channels.remove(request.params.id);
      control.record('删除通道');
      return { ok: true };
    }
  );
  server.addHook('onClose', () => assist.close());
  server.post('/api/douyin/assist', async () => { await assist.start(); return { ok: true }; });
  server.get('/api/douyin/assist/image', async (_request, reply) => reply.type('image/jpeg').send(await assist.snapshot()));
  server.post('/api/douyin/assist/input', async request => { await assist.act(request.body); return { ok: true }; });
  server.post('/api/douyin/assist/complete', async () => {
    await control.login!.completeBrowserLogin(); await assist.close(); return { ok: true };
  });
  server.delete('/api/douyin/assist', async () => { await assist.close(); return { ok: true }; });
  server.post('/api/douyin/login', async () => control.login!.create());
  server.post<{ Params: { id: string } }>('/api/douyin/login/:id/sms', async request => control.login!.sendVerificationCode(request.params.id));
  server.post<{ Params: { id: string } }>('/api/douyin/login/:id/verify', async request => {
    const body = z.object({ code: z.string().regex(/^[0-9]{4,8}$/) }).strict().parse(request.body);
    return control.login!.verifyCode(request.params.id, body.code);
  });
  server.post<{ Params: { id: string } }>('/api/douyin/login/:id/trust', async request => {
    const body = z.object({ save: z.boolean() }).strict().parse(request.body);
    return control.login!.chooseTrust(request.params.id, body.save);
  });
  server.post('/api/douyin/logout', async () => {
    await assist.close();
    const browser = control.browser;
    await control.login!.logout(async () => {
      await control.bridge?.invalidateLogin();
      if (browser) await clearBrowserLogin(browser.context);
    });
    control.recover?.('Douyin account signed out');
    control.record('已退出抖音并清除保存的登录状态');
    return { ok: true };
  });
  server.get<{ Params: { id: string } }>(
    '/api/douyin/login/:id',
    async (request) => control.login!.check(request.params.id)
  );
  server.get<{ Params: { id: string } }>(
    '/api/douyin/login/:id/qr',
    async (request, reply) =>
      reply.type('image/png').send(control.login!.qr(request.params.id))
  );
  server.post('/api/douyin/check', async () => {
    await control.checkSession?.();
    return control.status();
  });
  server.post('/api/douyin/reconnect', async () => {
    if (!control.recover)
      throw Object.assign(new Error('会话正在重建，请稍后重试'), {
        statusCode: 409
      });
    control.recover('web console requested reconnect');
    control.record('手动重连抖音会话');
    return { ok: true };
  });
  return server;
}
