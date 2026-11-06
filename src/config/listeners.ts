import type { AppConfig } from './schema.js';

/** Reserve media's listener even before the Douyin session attaches its channels. */
export function validateMediaListener(config: AppConfig, channels?: unknown[]): void {
  if (!config.media.enabled) return;
  const used = channels ?? [
    { type: 'http', ...config.onebot.http },
    { type: 'forward-ws', ...config.onebot.forwardWs },
  ];
  if ((config.web.enabled && config.web.port === config.media.port) || used.some(value => {
    const channel = value as { enabled?: boolean; type?: string; port?: number } | null;
    return channel?.enabled && ['http', 'forward-ws'].includes(channel.type ?? '') && channel.port === config.media.port;
  })) throw Object.assign(new Error('媒体服务端口与管理台或 OneBot 通道冲突，请使用独立端口'), { statusCode: 409 });
}
