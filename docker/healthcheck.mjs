import { loadConfig } from '../dist/config/index.js';

// 只检查管理服务或 HTTP 监听存活；未扫码、IM 离线不等于容器进程损坏。
try {
  const config = loadConfig();
  const web = config.web.enabled;
  if (!web && !config.onebot.http.enabled) process.exit(0); // 无 HTTP 入口时跳过。
  const port = web ? config.web.port : config.onebot.http.port;
  const response = await fetch(`http://127.0.0.1:${port}${web ? '/' : '/health'}`, {
    signal: AbortSignal.timeout(4000),
    headers: !web && config.onebot.accessToken ? { Authorization: `Bearer ${config.onebot.accessToken}` } : {}
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
