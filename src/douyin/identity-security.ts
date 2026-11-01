import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { ActionDeadline } from '../runtime/deadline.js';

interface IdentitySecurity {
  identitySecurityToken: string;
  identitySecurityDeviceId: string;
}

/** Short-lived credentials belong to one authenticated cookie session and stay in memory. */
export class IdentitySecurityProvider {
  private cached?: { key: string; expiresAt: number; value: IdentitySecurity };
  private loading?: { key: string; promise: Promise<IdentitySecurity> };

  constructor(private readonly page: Page, private readonly accountId: () => string | undefined) {}

  async get(deadline: ActionDeadline): Promise<IdentitySecurity> {
    return deadline.run(async () => {
      const key = await this.sessionKey();
      deadline.remainingMs();
      if (this.cached?.key === key && this.cached.expiresAt > Date.now()) return this.cached.value;
      this.cached = undefined;
      if (this.loading?.key === key) return this.loading.promise;
      const startedAt = Date.now();
      const promise = this.load(deadline).then(async value => {
        deadline.remainingMs();
        if (await this.sessionKey() !== key) throw new Error('Douyin account or login session changed while obtaining send credentials');
        deadline.remainingMs();
        this.cached = { key, expiresAt: startedAt + 240000, value };
        return value;
      }).finally(() => { if (this.loading?.promise === promise) this.loading = undefined; });
      this.loading = { key, promise };
      return promise;
    });
  }

  private async sessionKey(): Promise<string> {
    const accountId = this.accountId();
    if (!accountId) throw new Error('Douyin account is not authenticated');
    const cookies = await this.page.context().cookies('https://www.douyin.com');
    const identity = cookies.filter(cookie => /^(sessionid|sessionid_ss|sid_guard|uid_tt|uid_tt_ss|passport_csrf_token|passport_mfa_token|x_tt_token)$/.test(cookie.name))
      .map(cookie => [cookie.domain, cookie.path, cookie.name, cookie.value]).sort();
    return createHash('sha256').update(JSON.stringify([accountId, identity])).digest('hex');
  }

  private async load(deadline: ActionDeadline): Promise<IdentitySecurity> {
    const result = await this.page.evaluate(async ({ timeoutMs }) => {
      if (location.origin !== 'https://www.douyin.com') throw new Error('Douyin send credentials require the authenticated Douyin page');
      const cookie = (name: string) => document.cookie.split(';').map(value => value.trim())
        .find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
      const traceId = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
      const params = new URLSearchParams({ passport_jssdk_version: '4.2.3', passport_jssdk_type: 'lite',
        is_from_ttaccountsdk: '1', aid: '6383', language: 'zh', scene: 'web_im', auto_retry_req: '0',
        skip_verify: 'false', identity_token_force_get_tag: '0', biz_trace_id: traceId, id_token_version: '1.2.10' });
      const msToken = cookie('msToken');
      if (msToken) params.set('msToken', msToken);
      // The site's patched fetch applies its request signing and ticket-guard SDK.
      let response: Response;
      try {
        response = await fetch(`/passport/safe/get_identity_security_token/?${params}`, {
          credentials: 'include', signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'application/json', 'x-tt-passport-trace-id': traceId,
            'x-tt-passport-csrf-token': cookie('passport_csrf_token') || cookie('passport_csrf_token_default') }
        });
      } catch { throw new Error('Douyin send credential request failed or timed out'); }
      if (!response.ok) throw new Error(`Douyin send credential request failed: HTTP ${response.status}`);
      let body: any;
      try { body = await response.json(); } catch { throw new Error('Douyin send credential response is not JSON'); }
      const data = body?.data;
      if ((body?.message !== undefined && body.message !== 'success') ||
          (data?.error_code !== undefined && data.error_code !== 0)) {
        const code = typeof data?.error_code === 'number' ? data.error_code : 'unknown';
        throw new Error(`Douyin send credentials rejected: code=${code}`);
      }
      if (typeof data?.identity_security_token !== 'string' || !data.identity_security_token ||
          typeof data.device_id !== 'string' || !data.device_id) throw new Error('Douyin send credentials missing token or device ID');
      return { token: data.identity_security_token, deviceId: data.device_id };
    }, { timeoutMs: deadline.remainingMs() });
    return { identitySecurityToken: JSON.stringify({ token: result.token }), identitySecurityDeviceId: result.deviceId };
  }
}
