type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};

/** Upgrade the old shared HTTP/cache configuration without reading environment overrides. */
export function migrateMediaConfig(input: unknown, channels?: unknown): unknown {
  const config = object(input), onebot = object(config.onebot);
  if (config.media !== undefined) return input;
  const http = Array.isArray(channels)
    ? channels.find(c => c?.enabled && c.type === 'http') ?? onebot.http
    : onebot.http;
  const listeners = Array.isArray(channels) ? channels : [object(onebot.http), object(onebot.forwardWs)];
  const used = new Set(listeners.filter(c => c?.enabled && (!c.type || ['http', 'forward-ws'].includes(c.type))).map(c => c.port));
  if (config.web?.enabled !== false) used.add(config.web?.port ?? 3000);
  let port = 3001;
  while (used.has(port) && port < 65535) port++;
  if (used.has(port)) throw new Error('没有可用的媒体服务端口');
  let publicBaseUrl = http?.publicBaseUrl ?? '';
  if (publicBaseUrl) {
    const url = new URL(publicBaseUrl);
    // Direct endpoints follow the new port. External reverse proxies retain their URL.
    if (Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === (http?.port ?? 3001)) url.port = String(port);
    publicBaseUrl = url.href.replace(/\/$/, '');
  }
  const { mediaCache, ...rest } = onebot;
  const { publicBaseUrl: _oldUrl, ...oldHttp } = object(onebot.http);
  return { ...config, onebot: { ...rest, ...(onebot.http ? { http: oldHttp } : {}) },
    media: { host: http?.host || '127.0.0.1', port, publicBaseUrl, ...(mediaCache ? { cache: mediaCache } : {}) } };
}
