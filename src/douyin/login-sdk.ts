import type { Page } from 'playwright';

export interface SecondVerifyContext {
  encrypt_uid: string;
  common_params: Record<string, unknown>;
  biz_params: Record<string, unknown>;
  smsParams: Record<string, unknown>;
}
export type LoginSdkOperation =
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
    const release = () => { const pending = host.__douyinOneBotLogin; if (pending) { clearTimeout(pending.timer); pending.resolve?.({ status: false }); delete host.__douyinOneBotLogin; } };
    if (operation.kind === 'cancel') { release(); return {}; }
    let runtime: any;
    const chunks = host.webpackChunkdouyin_web;
    if (Array.isArray(chunks)) chunks.push([[`onebot_login_${crypto.randomUUID()}`], {}, (require: any) => { runtime = require; }]);
    const findExport = (name: string) => {
      for (const [id, factory] of Object.entries(runtime?.m ?? {})) {
        if (typeof factory !== 'function') continue;
        const source = Function.prototype.toString.call(factory);
        if (!source.includes(name) || (name === 'WebInterfaceSdk' && !source.includes('waitForSecureSDKReady'))) continue;
        try { const value = runtime(id)?.[name]; if (typeof value === 'function') return value; } catch { /* dependency chunk not loaded */ }
      }
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
          const result = clean(await findExport('setTrust')({ setParams: { decision: operation.save ? 1 : 2 }, accountApiConfig: { axiosConfig: { timeout: 15000 } } }));
          const end = Date.now() + 10000;
          while (!finalized && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
          if (!finalized) throw new Error('官方登录 SDK 尚未完成保存，请稍后重试或使用官方页面确认');
          return result;
        } finally { if (Storage.prototype.setItem === observe) Storage.prototype.setItem = original; }
      }
      let WebSdk: any;
      try { WebSdk = findExport('WebInterfaceSdk'); }
      catch (error) { if (operation.kind === 'check') return { sdkUnavailable: true }; throw error; }
      if (operation.kind === 'resume') {
        const pending = host.__douyinOneBotLogin;
        if (!pending?.resolve || pending.token !== operation.form.token || pending.decision?.encrypt_uid !== operation.challenge.encrypt_uid ||
            pending.decision?.common_params?.std_verify_flow_id !== operation.challenge.common_params.std_verify_flow_id) throw new Error('验证会话已失效，请重新获取二维码');
        clearTimeout(pending.timer);
        pending.resolve({ status: true, bizParams: operation.result.biz_params ?? operation.result.bizParams ?? {} });
        pending.resolve = undefined;
        return { data: clean(await pending.completed) };
      }
      let pending: any, ready: Promise<any> | undefined, notify: ((value: any) => void) | undefined;
      if (operation.kind === 'check') {
        const previous = host.__douyinOneBotLogin;
        if (previous?.token === operation.form.token && previous.decision) return { data: previous.decision };
        release(); pending = { token: operation.form.token }; host.__douyinOneBotLogin = pending;
        ready = new Promise(resolve => { notify = resolve; });
      } else {
        const decision = host.__douyinOneBotLogin?.decision;
        if (!decision || decision.encrypt_uid !== operation.challenge.encrypt_uid || decision.common_params?.std_verify_flow_id !== operation.challenge.common_params.std_verify_flow_id) throw new Error('验证会话已失效，请重新获取二维码');
      }
      const sdk = operation.kind !== 'check' ? host.__douyinOneBotLogin.sdk : new WebSdk({ aid: 6383, enableWebXttToken: true, printLog: false,
        generalParams: { is_new_login: '1', is_from_iesaccountsaas: 1, p_ui: '2.4.10' }, axiosConfig: { timeout: 15000 },
        enableExternalSecondVerify: operation.kind === 'check',
        externalSecondVerifyHandler: ({ verifyDecision }: any) => {
          if (operation.kind !== 'check' || host.__douyinOneBotLogin !== pending) return Promise.resolve({ status: false });
          const { error_code, encrypt_uid, verify_ways, common_params, biz_params } = verifyDecision;
          pending.decision = { error_code, encrypt_uid, verify_ways, common_params, biz_params };
          const answer = new Promise(resolve => { pending.resolve = resolve; });
          pending.timer = setTimeout(() => { if (host.__douyinOneBotLogin === pending) release(); }, 600000);
          notify!({ data: pending.decision });
          return answer;
        }
      });
      if (operation.kind === 'check') {
        pending.sdk = sdk;
        pending.completed = Promise.resolve(sdk.request({ url: '/passport/web/check_qrconnect/', method: 'POST', params: operation.params, data: operation.form }))
          .finally(() => { clearTimeout(pending.timer); if (host.__douyinOneBotLogin === pending) delete host.__douyinOneBotLogin; });
        // While a human is entering the code, retain the original request solely in this page.
        pending.completed.catch(() => undefined);
        return await Promise.race([pending.completed.then((data: any) => ({ data: clean(data) })), ready!]);
      }
      if (typeof sdk.verify?.sendCode !== 'function' || typeof sdk.verify?.validateMobile !== 'function') throw new Error('官方短信验证能力不可用');
      const input = { encrypt_uid: operation.challenge.encrypt_uid,
        extra_params: { ...operation.challenge.common_params, ...operation.challenge.smsParams, skip_sdk_error_handler: true },
        ...(operation.kind === 'validateCode' ? { code: operation.code } : {}) };
      return clean(await (operation.kind === 'sendCode' ? sdk.verify.sendCode(input) : sdk.verify.validateMobile(input)));
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
    smsParams: { ...params } };
}
