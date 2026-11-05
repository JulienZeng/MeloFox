import type { Page } from 'playwright';

export interface SecondVerifyContext {
  encrypt_uid: string;
  common_params: Record<string, unknown>;
  biz_params: Record<string, unknown>;
  smsParams: Record<string, unknown>;
}
export type LoginSdkOperation =
  | { kind: 'create'; params: Record<string, string> }
  | { kind: 'check'; params: Record<string, string>; form: Record<string, string> }
  | { kind: 'cancel' }
  | { kind: 'sendCode'; challenge: SecondVerifyContext }
  | { kind: 'validateCode'; challenge: SecondVerifyContext; code: string }
  | { kind: 'resume'; challenge: SecondVerifyContext; result: Record<string, unknown>; params: Record<string, string>; form: Record<string, string> }
  | { kind: 'trust'; save: boolean };

/** Use the site's loaded SDK exports, discovered by capability rather than release-specific module IDs. */
export async function invokeLoginSdk(page: Page, operation: LoginSdkOperation): Promise<Record<string, any>> {
  return page.evaluate(async operation => {
    if (location.origin !== 'https://www.douyin.com') throw new Error('请先打开后台抖音登录会话');
    const host = window as any;
    const release = () => { const pending = host.__douyinOneBotLogin; if (pending) { clearTimeout(pending.timer); delete host.__douyinOneBotLogin; } };
    if (operation.kind === 'cancel') { release(); return {}; }
    const findExport = async (name: string) => {
      // The login chunks arrive asynchronously on a clean profile. Wait for them
      // instead of falling back to an unsigned fetch with a different SDK version.
      const deadline = Date.now() + 12000;
      do {
        let runtime: any;
        const chunks = host.webpackChunkdouyin_web;
        if (Array.isArray(chunks)) chunks.push([[`onebot_login_${crypto.randomUUID()}`], {}, (require: any) => { runtime = require; }]);
        for (const [id, factory] of Object.entries(runtime?.m ?? {})) {
          if (typeof factory !== 'function') continue;
          const source = Function.prototype.toString.call(factory);
          if (!source.includes(name) || (name === 'WebInterfaceSdk' && !source.includes('waitForSecureSDKReady'))) continue;
          try { const value = runtime(id)?.[name]; if (typeof value === 'function') return value; } catch { /* dependency chunk not loaded */ }
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      throw new Error('官方登录 SDK 尚未加载所需能力，请使用官方页面辅助验证');
    };
    const clean = (value: any) => {
      const data = value?.data && typeof value.data === 'object' ? value.data : value;
      if (!data || typeof data !== 'object') throw new Error('官方登录 SDK 返回格式不正确');
      if (Number(data.error_code ?? 0) !== 0) throw new Error(`抖音验证失败（${Number(data.error_code)}），请重试或使用官方页面验证`);
      const { originConfig: _config, respHeader: _headers, ...rest } = data;
      return JSON.parse(JSON.stringify(rest));
    };
    try {
      if (operation.kind === 'trust') {
        // setTrust resolves its HTTP response before the lazy security SDK finishes writing account data.
        // Observe completion without copying ticket data or persisting the session too early.
        let finalized = !operation.save;
        const original = Storage.prototype.setItem;
        const observe = function(this: Storage, key: string, value: string) {
          const result = original.call(this, key, value);
          if (this === localStorage && key === 'security-sdk/s_sdk_sign_data_key/login') finalized = true;
          return result;
        };
        Storage.prototype.setItem = observe;
        try {
          const setTrust = await findExport('setTrust');
          const result = clean(await setTrust({ setParams: { decision: operation.save ? 1 : 2 }, accountApiConfig: { axiosConfig: { timeout: 15000 } } }));
          const end = Date.now() + 10000;
          while (!finalized && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
          if (!finalized) throw new Error('官方登录 SDK 尚未完成保存，请稍后重试或使用官方页面确认');
          return result;
        } finally { if (Storage.prototype.setItem === observe) Storage.prototype.setItem = original; }
      }
      let sdk = host.__douyinOneBotPassport;
      if (!sdk) {
        const WebSdk = await findExport('WebInterfaceSdk');
        sdk = new WebSdk({ aid: 6383, enableWebXttToken: true, printLog: false,
          browserInfo: { useBitReport: true }, nocaptchaOptions: { enabled: true },
          generalParams: { is_new_login: '1', is_from_iesaccountsaas: 1 }, axiosConfig: { timeout: 15000 }
        });
        host.__douyinOneBotPassport = sdk;
      }
      // Native SDK verification handlers can consume 2046 and wait for a hidden
      // modal before an external callback runs. Keep signing/transport, but let our state
      // machine handle business errors instead of holding an HTTP request open.
      const request = async (config: any) => {
        try {
          const response = await sdk.request({ ...config,
            params: { ...config.params, skip_sdk_error_handler: true }
          });
          const data = response?.data ?? response;
          if (Number(data?.error_code) === 2046) throw data;
          return clean(response);
        } catch (error) {
          const data = (error as any)?.data ?? error;
          if (Number((data as any)?.error_code) === 2046) {
            const { error_code, encrypt_uid, verify_ways, common_params, biz_params } = data as any;
            return { error_code, encrypt_uid, verify_ways, common_params, biz_params };
          }
          throw error;
        }
      };
      if (operation.kind === 'create') {
        release();
        return { data: await request({ url: '/passport/web/get_qrcode/', method: 'GET', params: operation.params }) };
      }
      if (operation.kind === 'check') {
        const previous = host.__douyinOneBotLogin;
        if (previous?.token === operation.form.token && previous.decision) return { data: previous.decision };
        release();
        const data = await request({ url: '/passport/web/check_qrconnect/', method: 'POST', params: operation.params, data: operation.form });
        if (Number(data.error_code) === 2046) {
          const pending = { token: operation.form.token, form: { ...operation.form }, decision: data, timer: 0 };
          host.__douyinOneBotLogin = pending;
          pending.timer = window.setTimeout(() => { if (host.__douyinOneBotLogin === pending) release(); }, 600000);
        }
        return { data };
      }
      const pending = host.__douyinOneBotLogin;
      if (!pending?.decision || pending.decision.encrypt_uid !== operation.challenge.encrypt_uid ||
          pending.decision.common_params?.std_verify_flow_id !== operation.challenge.common_params.std_verify_flow_id) throw new Error('验证会话已失效，请重新获取二维码');
      if (operation.kind === 'resume') {
        if (pending.token !== operation.form.token) throw new Error('验证会话已失效，请重新获取二维码');
        if (!pending.validated) throw new Error('请先完成短信验证码校验');
        // validate_code returns a ticket; replay the same QR token with the
        // challenge's business parameters and the successfully verified method.
        const data = await request({ url: '/passport/web/check_qrconnect/', method: 'POST', params: operation.params,
          data: { ...pending.form, ...pending.decision.biz_params,
            ...(pending.validated.biz_params ?? pending.validated.bizParams ?? {}), std_verify_way: 'mobile_sms_verify' }
        });
        if (Number(data.error_code) !== 2046) release();
        return { data };
      }
      if (typeof sdk.verify?.sendCode !== 'function' || typeof sdk.verify?.validateMobile !== 'function') throw new Error('官方短信验证能力不可用');
      const input = { encrypt_uid: operation.challenge.encrypt_uid,
        extra_params: { ...operation.challenge.common_params, ...operation.challenge.smsParams, skip_sdk_error_handler: true },
        ...(operation.kind === 'validateCode' ? { code: operation.code } : {}) };
      if (operation.kind === 'sendCode') {
        return clean(await sdk.verify.sendCode({ ...input, extra_params: { ...input.extra_params, is6Digits: 1 } }));
      }
      const result = clean(await sdk.verify.validateMobile(input));
      if (typeof result.ticket !== 'string' || !result.ticket) throw new Error('官方短信验证未返回凭据，请重新验证');
      host.__douyinOneBotLogin.validated = result;
      return result;
    } catch (error) {
      if (error instanceof Error && /^[\u4e00-\u9fff]/.test(error.message)) throw error;
      const code = Number((error as any)?.error_code ?? 0);
      throw new Error(code ? `抖音验证失败（${code}），请重试或使用官方页面验证` : '官方验证请求未完成，请重试或使用官方页面辅助验证');
    }
  }, operation);
}

export function secondVerifyContext(data: Record<string, any>): SecondVerifyContext | undefined {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (typeof data.encrypt_uid !== 'string' || !data.encrypt_uid || !record(data.common_params) || !record(data.biz_params)) return undefined;
  const ways = data.verify_ways;
  let sms: unknown;
  if (record(ways)) sms = ways.assist_mobile_sms_verify;
  if (Array.isArray(ways)) sms = ways.find(v => v === 'assist_mobile_sms_verify' || v?.verify_way === 'assist_mobile_sms_verify' || v?.way === 'assist_mobile_sms_verify');
  if (sms === undefined || sms === false) return undefined;
  const descriptor = record(sms) ? sms : {};
  const params = record(descriptor.params) ? descriptor.params : record(descriptor.extra_params) ? descriptor.extra_params : {};
  // Identity and flow are server-supplied. No phone number, endpoint or flow ticket is accepted from the management UI.
  return { encrypt_uid: data.encrypt_uid, common_params: { ...data.common_params }, biz_params: { ...data.biz_params },
    smsParams: { ...params, type: 39, verify_ticket: '', std_verify_way: 'assist_mobile_sms_verify' } };
}
