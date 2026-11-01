import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import type { AppLogger } from '../logger/index.js';
import type { BrowserRuntime } from '../browser/chromium.js';
import type { DouyinBridge } from '../douyin/bridge.js';
import { LoginAssist } from '../douyin/login-assist.js';
import { ChannelManager } from './channels.js';
import { registerConsoleAssets } from './assets.js';
import type { ConsoleStatus } from './contracts.js';
import {
  DouyinLogin,
  PassportError,
  clearBrowserLogin,
  browserPassportTransport
} from '../douyin/login.js';

export class ConsoleControl {
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
    return {
      startedAt: this.startedAt,
      account: {
        loggedIn: this.bridge?.loggedIn ?? false,
        id: this.bridge?.loggedIn ? this.bridge.accountId : undefined,
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
  const dir = resolve(config.web.dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let adminToken = config.web.token;
  if (!adminToken) {
    const path = join(dir, 'admin-token');
    try {
      adminToken = (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      adminToken = randomBytes(24).toString('base64url');
      await writeFile(path, `${adminToken}\n`, { mode: 0o600, flag: 'wx' });
    }
    if (!adminToken)
      throw new Error(
        '管理台令牌文件为空，请设置 WEB_TOKEN 或修复 admin-token'
      );
    logger.info(
      { tokenFile: path },
      'web console token is stored in this file'
    );
  }
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(adminToken);
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  let developmentNonce: string | undefined;
  const sessionOf = (cookie?: string) =>
    cookie?.match(/(?:^|;\s*)dy_console=([\w-]+)/)?.[1];
  server.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self'${developmentNonce ? ` 'nonce-${developmentNonce}'` : ''}; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
    );
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.origin;
      if (
        request.headers['sec-fetch-site'] === 'cross-site' ||
        (origin && new URL(origin).host !== request.headers.host)
      ) {
        return reply.code(403).send({ message: '不允许跨站操作' });
      }
    }
    if (!request.url.startsWith('/api/') || request.url === '/api/auth/login')
      return;
    const session = sessionOf(request.headers.cookie);
    const expires = session && sessions.get(session);
    if (!expires || expires <= Date.now()) {
      if (session) sessions.delete(session);
      return reply.code(401).send({ message: '请先登录管理台' });
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
    const failure = error as Error & { statusCode?: number };
    const status = failure.statusCode ?? 500;
    return reply.code(status).send({
      message: status >= 500 ? '服务暂时不可用，请稍后重试' : failure.message
    });
  });
  if (options.development) {
    const { registerConsoleDevAssets } = await import('./dev-assets.js');
    developmentNonce = await registerConsoleDevAssets(server);
  } else {
    await registerConsoleAssets(server);
  }
  server.post('/api/auth/login', async (request, reply) => {
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
    const attempt = attempts.get(request.ip) ?? {
      count: 0,
      until: now + 60_000
    };
    if (attempt.count >= 8)
      return reply
        .code(429)
        .header('Retry-After', '60')
        .send({ message: '尝试过于频繁，请一分钟后重试' });
    if (attempts.size >= 256 && !attempts.has(request.ip))
      return reply.code(429).send({ message: '请求过于频繁，请稍后重试' });
    attempt.count++;
    attempts.set(request.ip, attempt);
    const { token } = z
      .object({ token: z.string().min(1).max(1024) })
      .parse(request.body);
    if (!timingSafeEqual(digest(token), expected))
      return reply.code(401).send({ message: '管理令牌不正确' });
    attempts.delete(request.ip);
    for (const [key, expires] of sessions)
      if (expires <= now) sessions.delete(key);
    if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
    const session = randomBytes(32).toString('base64url');
    sessions.set(session, now + 12 * 3600_000);
    reply.header(
      'Set-Cookie',
      `dy_console=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${request.protocol === 'https' ? '; Secure' : ''}`
    );
    return { ok: true };
  });
  server.post('/api/auth/logout', async (request, reply) => {
    const session = sessionOf(request.headers.cookie);
    if (session) sessions.delete(session);
    reply.header(
      'Set-Cookie',
      'dy_console=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
    );
    return { ok: true };
  });
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
