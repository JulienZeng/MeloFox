import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { RuntimeSettingsStore } from '../config/settings.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loggerBuffer, scopedLogger, type AppLogger } from '../logger/index.js';
import { LogBuffer } from '../logger/buffer.js';
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
  logs = new LogBuffer();
  constructor(readonly channels: ChannelManager) {}
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
      logs: this.logs.recent(),
      login: this.login?.status()
    };
  }
}

export async function createConsoleServer(
  config: AppConfig,
  logger: AppLogger,
  control: ConsoleControl,
  options: { development?: boolean; settings?: RuntimeSettingsStore; restart?: () => void } = {}
): Promise<FastifyInstance> {
  logger = scopedLogger(logger, '管理台');
  control.logs = loggerBuffer(logger);
  control.login ??= new DouyinLogin(
    config,
    browserPassportTransport(() => control.browser),
    () => {
      logger.info('抖音登录配置已保存');
      control.recover?.('Douyin API login completed; restore saved session');
    }
  );
  const assist = new LoginAssist(() => control.browser);
  control.assisting = () => assist.active;
  const server = Fastify({ bodyLimit: 16 * 1024, requestTimeout: 15_000 });
  const instanceId = randomUUID();
  let restartPending = false, restartStarted = false;
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
  server.setErrorHandler((error, request, reply) => {
    if (!(error instanceof z.ZodError) && ((error as { statusCode?: number }).statusCode ?? 500) >= 500)
      logger.error({ error, method: request.method, route: request.routeOptions.url }, '管理接口执行失败');
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
  // Public readiness exposes no account/configuration details. The browser uses
  // the boot ID to distinguish a new process from the old, still-draining one.
  server.get('/healthz', async () => ({ instanceId, status: restartPending ? 'restarting' : 'ready' }));
  server.addHook('preHandler', async (request, reply) => {
    if (restartPending && !['GET', 'HEAD'].includes(request.method) && request.routeOptions.url !== '/api/service/restart')
      return reply.code(503).send({ message: '服务正在重启，请等待恢复后操作' });
  });
  server.post('/api/service/restart', {
    onResponse: async (_request, reply) => {
      // Send the acknowledgement before closing the HTTP connection. Repeated
      // clicks/requests belong to the same restart and cannot schedule another.
      if (reply.statusCode === 202 && !restartStarted) {
        restartStarted = true;
        options.restart!();
      }
    },
  }, async (_request, reply) => {
    if (!options.restart) return reply.code(503).send({ message: '当前启动方式未接入服务重启，请通过 MeloFox 启动入口运行' });
    restartPending = true;
    return reply.code(202).send({ instanceId, status: 'restarting' });
  });
  if (options.settings) await options.settings.forgetInitialPassword();
  let settings = options.settings;
  const getSettings = async () => settings ??= await RuntimeSettingsStore.fromConfig(config, join(config.web.dataDir, 'settings.json'));
  server.get('/api/settings', async () => (await getSettings()).snapshot());
  server.put('/api/settings', async request => {
    const result = await (await getSettings()).save(request.body);
    logger.info(result.restartRequired ? '运行设置已保存，重启 MeloFox 后生效' : '运行设置已保存');
    return result;
  });
  server.addHook('onReady', () => control.metrics.start(config.web.dataDir));
  server.addHook('onClose', () => control.metrics.stop());
  if (options.development) {
    const { registerConsoleDevAssets } = await import('./dev-assets.js');
    developmentNonce = await registerConsoleDevAssets(server);
  } else {
    await registerConsoleAssets(server);
  }
  server.get('/api/status', async () => control.status());
  server.get('/api/logs', async request => {
    const query = z.object({
      after: z.coerce.number().int().nonnegative().safe().optional(),
      stream: z.string().uuid().optional(),
    }).strict().parse(request.query);
    return control.logs.read(query.after, query.stream);
  });
  server.post('/api/channels', async (request, reply) => {
    await control.channels.save(request.body);
    logger.info('创建通道');
    return reply.code(201).send({ ok: true });
  });
  server.put<{ Params: { id: string } }>(
    '/api/channels/:id',
    async (request) => {
      await control.channels.save(request.body, request.params.id);
      logger.info('更新通道配置');
      return { ok: true };
    }
  );
  server.delete<{ Params: { id: string } }>(
    '/api/channels/:id',
    async (request) => {
      await control.channels.remove(request.params.id);
      logger.info('删除通道');
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
  server.post('/api/douyin/login', async () => {
    const result = await control.login!.create();
    logger.info('登录二维码已生成，请使用抖音 App 扫码');
    return result;
  });
  server.post<{ Params: { id: string } }>('/api/douyin/login/:id/sms', async request => {
    const result = await control.login!.sendVerificationCode(request.params.id);
    logger.info('登录短信验证码已发送，请在管理台完成验证');
    return result;
  });
  server.post<{ Params: { id: string } }>('/api/douyin/login/:id/verify', async request => {
    const body = z.object({ code: z.string().regex(/^[0-9]{4,8}$/) }).strict().parse(request.body);
    const result = await control.login!.verifyCode(request.params.id, body.code);
    logger.info('短信验证已通过，请选择登录保存方式');
    return result;
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
    logger.info('已退出抖音并清除保存的登录状态');
    return { ok: true };
  });
  server.get<{ Params: { id: string } }>(
    '/api/douyin/login/:id',
    async (request) => {
      const previous = control.login!.status()?.state;
      const result = await control.login!.check(request.params.id);
      if (result.state !== previous && result.state !== 'saved') {
        if (result.state === 'error' || result.state === 'refused') logger.warn(result.message);
        else logger.info(result.message);
      }
      return result;
    }
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
    logger.info('手动重连抖音会话');
    return { ok: true };
  });
  return server;
}
