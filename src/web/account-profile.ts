import type { DouyinUser } from '../douyin/types.js';

export const AVATAR_DOMAINS = ['douyinpic.com', 'byteimg.com', 'douyinstatic.com', 'pstatp.com'];
export function avatarUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      AVATAR_DOMAINS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return url.href;
  } catch { /* Invalid or untrusted images use the local avatar placeholder. */ }
}
interface AccountSource {
  readonly accountId?: string;
  readonly loggedIn: boolean;
  getLoginInfo(noCache?: boolean): Promise<DouyinUser>;
}

/** One shared request per account; status polling never waits for Douyin profile requests. */
export class AccountProfile {
  private source?: AccountSource;
  private id?: string;
  private value?: { name?: string; avatar?: string };
  private nextUpdate = 0;
  private pending?: Promise<void>;
  private generation = 0;
  constructor(private readonly account: () => AccountSource | undefined) {}

  snapshot() {
    const source = this.account(), id = source?.loggedIn ? source.accountId : undefined;
    if (source !== this.source || id !== this.id) {
      this.source = source; this.id = id; this.value = undefined; this.nextUpdate = 0; this.generation++;
      this.pending = undefined;
    }
    return this.value;
  }

  refresh(): Promise<void> {
    this.snapshot();
    if (this.pending) return this.pending;
    const source = this.source, id = this.id, generation = this.generation;
    if (!source || !id || Date.now() < this.nextUpdate) return Promise.resolve();
    this.nextUpdate = Date.now() + 15_000;
    const pending = (async () => {
      try {
        const user = await source.getLoginInfo(true);
        this.snapshot();
        if (generation !== this.generation || user.id !== id) return;
        this.value = { name: user.name || undefined, avatar: avatarUrl(user.avatar) };
        this.nextUpdate = Date.now() + 60_000;
      } catch { /* Preserve a same-account cached profile until the next attempt. */ }
    })().finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }
}
