import { invokeLoginSdk, secondVerifyContext, type SecondVerifyContext, type LoginSdkOperation } from './login-sdk.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import type { BrowserRuntime } from '../browser/chromium.js';
import type { AppConfig } from '../config/index.js';

export type LoginState =
  | 'waiting'
  | 'scanned'
  | 'verifying'
  | 'choose_trust'
  | 'confirmed'
  | 'saved'
  | 'expired'
  | 'refused'
  | 'error';
export interface LoginAttempt {
  id: string;
  state: LoginState;
  expiresAt: number;
  message: string;
  verification?: { smsAvailable: boolean; resendAt: number };
}
interface PrivateAttempt extends LoginAttempt {
  token: string;
  image: Buffer;
  checkedAt: number;
  challenge?: SecondVerifyContext;
  resendAt?: number;
  codeSent?: boolean;
  verificationFailures?: number;
}
export interface PassportTransport {
  request(
    path: string,
    method: 'GET' | 'POST',
    params: Record<string, string>,
    form?: Record<string, string>
  ): Promise<Record<string, any>>;
  cancel?(): Promise<void>;
  sendCode?(challenge: SecondVerifyContext): Promise<Record<string, any>>;
  validateCode?(challenge: SecondVerifyContext, code: string): Promise<Record<string, any>>;
  resume?(challenge: SecondVerifyContext, result: Record<string, any>, params: Record<string, string>, form: Record<string, string>): Promise<Record<string, any>>;
  setTrust?(save: boolean): Promise<void>;
  save(): Promise<Awaited<ReturnType<BrowserContext['storageState']>>>;
}
const common = {
  aid: '6383',
  account_sdk_source: 'web',
  passport_jssdk_type: 'normal',
  is_from_ttaccountsdk: '1',
  is_from_iesaccountsaas: '1',
  is_new_login: '1'
};
export class PassportError extends Error {
  readonly statusCode = 502;
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
  }
}

/** Calls the passport HTTP API in the existing session, preserving cookies and the site's request SDK. */
export function browserPassportTransport(
  getBrowser: () => BrowserRuntime | undefined
): PassportTransport {
  const browser = () => {
    const current = getBrowser();
    if (!current || current.page.isClosed())
      throw Object.assign(new Error('后台会话正在初始化，请稍后重试'), {
        statusCode: 409
      });
    if (new URL(current.page.url()).origin !== 'https://www.douyin.com')
      throw Object.assign(new Error('后台抖音会话尚未就绪'), {
        statusCode: 409
      });
    return current;
  };
  const sdk = async (operation: LoginSdkOperation) => {
    const page = browser().page;
    try { return await invokeLoginSdk(page, operation); }
    catch (error) {
      const text = error instanceof Error ? error.message : '';
      const safe = text.match(/(?:官方登录 SDK[^\n]*|官方短信验证[^\n]*|请先完成短信验证码校验|验证会话已失效，请重新获取二维码|抖音验证失败（\d+）[^\n]*|官方验证请求未完成[^\n]*)/)?.[0];
      throw new PassportError(safe ?? '官方验证请求未完成，请使用官方页面辅助验证');
    }
  };
  return {
    async request(path, method, params, form) {
      if (path === '/passport/web/get_qrcode/' && method === 'GET') {
        return sdk({ kind: 'create', params });
      }
      if (path === '/passport/web/check_qrconnect/' && method === 'POST' && form) {
        return sdk({ kind: 'check', params, form });
      }
      throw new PassportError('不支持的抖音登录操作');
    },
    cancel: async () => { const current = getBrowser(); if (current && !current.page.isClosed() && new URL(current.page.url()).origin === 'https://www.douyin.com') await invokeLoginSdk(current.page, { kind: 'cancel' }); },
    sendCode: challenge => sdk({ kind: 'sendCode', challenge }),
    validateCode: (challenge, code) => sdk({ kind: 'validateCode', challenge, code }),
    resume: (challenge, result, params, form) => sdk({ kind: 'resume', challenge, result, params, form }),
    setTrust: async save => { await sdk({ kind: 'trust', save }); },
    save: () => browser().context.storageState()
  };
}
export function loginStatePath(config: AppConfig): string {
  return join(config.web.dataDir, 'douyin-session.json');
}
const logoutMarker = (config: AppConfig) => join(config.web.dataDir, 'douyin-signed-out');

export async function clearBrowserLogin(context: BrowserContext): Promise<void> {
  const state = await context.storageState();
  await context.clearCookies();
  const page = await context.newPage();
  try {
    const session = await context.newCDPSession(page);
    const origins = new Set(['https://www.douyin.com', 'https://www-hj.douyin.com', 'https://douyin.com', ...state.origins.map(item => item.origin)]);
    for (const origin of origins) await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await session.detach();
  } finally { await page.close(); }
}

export async function restoreLoginState(
  context: BrowserContext,
  config: AppConfig
): Promise<void> {
  if (!config.web.enabled) return;
  if (await readFile(logoutMarker(config)).then(() => true, error => {
    if (error.code === 'ENOENT') return false; throw error;
  })) { await clearBrowserLogin(context); return; }
  let state: Awaited<ReturnType<BrowserContext['storageState']>>;
  try {
    state = JSON.parse(await readFile(loginStatePath(config), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins))
    throw new Error('Saved Douyin session is invalid');
  const cookies = state.cookies.filter(
    (cookie) =>
      /(^|\.)douyin\.com$/.test(cookie.domain.replace(/^\./, '')) &&
      (cookie.expires < 0 || cookie.expires * 1000 > Date.now())
  );
  await context.addCookies(cookies);
  await context.addInitScript(
    ({ origins, marker }) => {
      const origin = origins.find((item) => item.origin === location.origin);
      if (!origin || sessionStorage.getItem('__douyin_onebot_restore') === marker) return;
      for (const item of origin?.localStorage ?? [])
        localStorage.setItem(item.name, item.value);
      sessionStorage.setItem('__douyin_onebot_restore', marker);
    },
    {
      origins: state.origins.filter((origin) => {
        try {
          const host = new URL(origin.origin).hostname;
          return host === 'douyin.com' || host.endsWith('.douyin.com');
        } catch {
          return false;
        }
      }),
      marker: randomUUID()
    }
  );
}

export class DouyinLogin {
  private attempt?: PrivateAttempt;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly config: AppConfig,
    private readonly transport: PassportTransport,
    private readonly onSaved: () => void,
    private readonly now = Date.now
  ) {}
  get inProgress(): boolean {
    return ['waiting', 'scanned', 'verifying', 'choose_trust', 'confirmed'].includes(this.status()?.state ?? '');
  }
  logout(clear: () => Promise<void>): Promise<void> {
    return this.serial(async () => {
      this.attempt = undefined;
      await this.transport.cancel?.().catch(() => undefined);
      await mkdir(this.config.web.dataDir, { recursive: true, mode: 0o700 });
      // Persist intent before touching the browser, so a crash cannot restore the old account.
      await writeFile(logoutMarker(this.config), 'signed-out\n', { mode: 0o600 });
      await unlink(loginStatePath(this.config)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await clear();
    });
  }
  status(): LoginAttempt | undefined {
    if (!this.attempt) return undefined;
    if (
      ['waiting', 'scanned', 'verifying', 'choose_trust'].includes(this.attempt.state) &&
      this.now() >= this.attempt.expiresAt
    ) {
      this.attempt.state = 'expired';
      this.attempt.message = '登录请求已过期，请重新获取二维码';
      this.attempt.challenge = undefined;
    }
    const { id, state, expiresAt, message } = this.attempt;
    return { id, state, expiresAt, message, ...(state === 'verifying' ? { verification: { smsAvailable: Boolean(this.attempt.challenge && this.transport.sendCode && this.transport.validateCode && this.transport.resume), resendAt: this.attempt.resendAt ?? 0 } } : {}) };
  }
  create(): Promise<LoginAttempt> {
    return this.serial(async () => {
      await this.transport.cancel?.();
      this.attempt = undefined;
      const data = this.unwrap(
        await this.transport.request('/passport/web/get_qrcode/', 'GET', {
          ...common,
          next: this.config.douyin.messagePageUrl,
          need_logo: 'false',
          need_short_url: 'true'
        })
      );
      if (
        typeof data.qrcode !== 'string' ||
        typeof data.token !== 'string' ||
        !data.token
      )
        throw new PassportError('抖音接口未返回二维码或登录标识');
      const image = Buffer.from(
        data.qrcode.replace(/^data:image\/png;base64,/, ''),
        'base64'
      );
      if (
        image.length < 8 ||
        !image
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        image.length > 256 * 1024
      )
        throw new PassportError('抖音接口返回了无效二维码图片');
      const expiresAt = Number(data.expire_time) * 1000;
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now())
        throw new PassportError('抖音接口返回的二维码已过期');
      this.attempt = {
        id: randomUUID(),
        token: data.token,
        image,
        expiresAt,
        state: 'waiting',
        message: '请使用抖音 App 扫码',
        checkedAt: 0
      };
      return this.status()!;
    });
  }
  qr(id: string): Buffer {
    if (
      this.status()?.id !== id ||
      !['waiting', 'scanned'].includes(this.attempt!.state)
    )
      throw Object.assign(new Error('二维码已失效，请重新获取'), {
        statusCode: 410
      });
    return this.attempt!.image;
  }
  check(id: string): Promise<LoginAttempt> {
    return this.serial(async () => {
      if (this.status()?.id !== id)
        throw Object.assign(new Error('登录请求不存在或已被替换'), {
          statusCode: 404
        });
      const attempt = this.attempt!;
      if (
        !['waiting', 'scanned', 'confirmed'].includes(attempt.state) ||
        // Allow the console's 400 ms cadence, with room for timer/network jitter.
        this.now() - attempt.checkedAt < 300
      )
        return this.status()!;
      attempt.checkedAt = this.now();
      if (attempt.state !== 'confirmed') {
        const response = await this.transport.request('/passport/web/check_qrconnect/', 'POST', { ...common }, this.checkForm(attempt));
        if (Number(response.data?.error_code) === 2046) { this.beginVerification(attempt, response.data, response.sdkMfa !== false); return this.status()!; }
        const data = this.unwrap(response);
        const states: Record<string, LoginState> = {
          '1': 'waiting',
          new: 'waiting',
          '2': 'scanned',
          scanned: 'scanned',
          '3': 'confirmed',
          confirmed: 'confirmed',
          '4': 'refused',
          refused: 'refused',
          '5': 'expired',
          expired: 'expired'
        };
        const state = states[String(data.status)];
        if (!state) throw new PassportError('抖音接口返回了未知扫码状态');
        attempt.state = state;
        attempt.message = {
          waiting: '请使用抖音 App 扫码',
          scanned: '已扫码，请在手机上确认登录',
          confirmed: '正在保存登录配置',
          expired: '二维码已过期，请重新获取',
          refused: '手机端已取消登录',
          saved: '登录配置已保存',
          error: '登录失败', verifying: '请完成身份验证', choose_trust: '请选择是否保存抖音快捷登录信息'
        }[state];
      }
      if (attempt.state === 'confirmed' && this.transport.setTrust) {
        attempt.state = 'choose_trust'; attempt.expiresAt = this.now() + 600000; attempt.message = '请选择是否在抖音保存快捷登录信息';
        return this.status()!;
      }
      if (attempt.state === 'confirmed') {
        await this.persistBrowserSession();
        attempt.state = 'saved';
        attempt.message = '登录配置已保存，正在连接消息服务';
        this.onSaved();
      }
      return this.status()!;
    });
  }
  private checkForm(attempt: PrivateAttempt): Record<string, string> {
    return { token: attempt.token, next: this.config.douyin.messagePageUrl, need_logo: 'false', need_short_url: 'true', is_new_login: '1', is_frontier: 'false' };
  }
  private beginVerification(attempt: PrivateAttempt, data: Record<string, any>, available: boolean): void {
    attempt.state = 'verifying'; attempt.challenge = available ? secondVerifyContext(data) : undefined;
    attempt.expiresAt = this.now() + 600000; attempt.resendAt = 0; attempt.codeSent = false; attempt.verificationFailures = 0;
    attempt.message = attempt.challenge ? '请接收并输入绑定手机的短信验证码' : '当前验证方式需使用官方页面辅助验证';
  }
  private requireAttempt(id: string, state: LoginState): PrivateAttempt {
    if (this.status()?.id !== id || this.attempt?.state !== state) throw Object.assign(new Error('登录请求已失效或状态不匹配'), { statusCode: 409 });
    return this.attempt;
  }
  sendVerificationCode(id: string): Promise<LoginAttempt> {
    return this.serial(async () => {
      const attempt = this.requireAttempt(id, 'verifying');
      if (!attempt.challenge || !this.transport.sendCode) throw new PassportError('请使用官方页面辅助验证');
      if (this.now() < (attempt.resendAt ?? 0)) throw Object.assign(new Error('请稍后再发送验证码'), { statusCode: 429 });
      // Reserve before the request: an ambiguous response must not result in an immediate duplicate SMS.
      attempt.resendAt = this.now() + 60000;
      const result = await this.transport.sendCode(attempt.challenge);
      this.unwrap({ data: result });
      const retrySeconds = Number(result.retry_time);
      if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
        attempt.resendAt = this.now() + Math.max(60, Math.min(retrySeconds, 600)) * 1000;
      }
      attempt.codeSent = true; attempt.message = '短信请求已受理，请输入验证码';
      return this.status()!;
    });
  }
  verifyCode(id: string, code: string): Promise<LoginAttempt> {
    return this.serial(async () => {
      const attempt = this.requireAttempt(id, 'verifying');
      if (!/^[0-9]{4,8}$/.test(code)) throw Object.assign(new Error('请输入 4 至 8 位数字验证码'), { statusCode: 400 });
      if (!attempt.challenge || !this.transport.validateCode || !this.transport.resume) throw new PassportError('请使用官方页面辅助验证');
      if (!attempt.codeSent) throw Object.assign(new Error('请先发送短信验证码'), { statusCode: 409 });
      if ((attempt.verificationFailures ?? 0) >= 10) throw new PassportError('验证尝试过多，请重新获取二维码');
      attempt.verificationFailures = (attempt.verificationFailures ?? 0) + 1;
      const result = await this.transport.validateCode(attempt.challenge, code);
      this.unwrap({ data: result });
      const data = this.unwrap(await this.transport.resume(attempt.challenge, result, { ...common }, this.checkForm(attempt)));
      if (!['3', 'confirmed'].includes(String(data.status))) throw new PassportError('验证后扫码事务尚未确认，请使用官方页面检查登录状态');
      attempt.challenge = undefined; attempt.codeSent = false; attempt.state = 'choose_trust';
      attempt.expiresAt = this.now() + 600000; attempt.message = '验证通过，请选择是否在抖音保存快捷登录信息';
      return this.status()!;
    });
  }
  chooseTrust(id: string, save: boolean): Promise<LoginAttempt> {
    return this.serial(async () => {
      const attempt = this.requireAttempt(id, 'choose_trust');
      if (typeof save !== 'boolean') throw Object.assign(new Error('请选择保存或不保存'), { statusCode: 400 });
      if (!this.transport.setTrust) throw new PassportError('官方保存登录能力不可用，请使用官方页面完成选择');
      await this.transport.setTrust(save);
      await this.persistBrowserSession(); attempt.state = 'saved'; attempt.message = '登录配置已保存，正在连接消息服务'; this.onSaved();
      return this.status()!;
    });
  }
  completeBrowserLogin(): Promise<void> {
    return this.serial(async () => {
      await this.transport.cancel?.();
      await this.persistBrowserSession();
      this.attempt = undefined;
      this.onSaved();
    });
  }
  private async persistBrowserSession(): Promise<void> {
    const state = await this.transport.save();
    const authenticated = state.cookies.some(
      (cookie) =>
        ['sessionid', 'sessionid_ss', 'sid_tt'].includes(cookie.name) &&
        /(^|\.)douyin\.com$/.test(cookie.domain.replace(/^\./, '')) &&
        (cookie.expires < 0 || cookie.expires * 1000 > this.now())
    );
    if (!authenticated)
      throw new PassportError(
        '手机已确认，但尚未收到抖音会话 Cookie；请稍后重试'
      );
    await mkdir(this.config.web.dataDir, { recursive: true, mode: 0o700 });
    const path = loginStatePath(this.config),
      temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(state), {
        mode: 0o600,
        flag: 'wx'
      });
      await rename(temp, path);
      await unlink(logoutMarker(this.config)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  private unwrap(body: Record<string, any>): Record<string, any> {
    const data = body.data;
    if (!data || typeof data !== 'object')
      throw new PassportError('抖音接口返回格式不正确');
    if (Number(data.error_code ?? 0) !== 0)
      throw new PassportError(
        `抖音登录失败（${data.error_code}）：${String(data.description || '请稍后重试').slice(0, 180)}`,
        Number(data.error_code)
      );
    return data;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
