import { readSavedConfig } from '../dist/config/settings.js';

// 管理台端口不随待重启设置改变，优先检查它，避免保存新媒体端口后误判运行中的服务。
// 无管理台时检查独立媒体服务；未扫码、IM 离线不等于容器进程损坏。
try {
  const config = await readSavedConfig();
  const web = config.web.enabled, media = !web && config.media.enabled;
  if (!web && !media && !config.onebot.http.enabled) process.exit(0);
  const listener = web ? config.web : media ? config.media : config.onebot.http;
  const host = ['0.0.0.0', '::'].includes(listener.host) ? '127.0.0.1' : listener.host;
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const response = await fetch(`http://${address}:${listener.port}${web ? '/healthz' : '/health'}`, {
    signal: AbortSignal.timeout(4000),
    headers: !web && !media && config.onebot.accessToken ? { Authorization: `Bearer ${config.onebot.accessToken}` } : {}
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
