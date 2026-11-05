import { loadConfig } from './config/index.js';
import { loadStartupEnvironment } from './config/environment.js';
import { createDouyinBridgeCache } from './douyin/bridge.js';
import { createLogger } from './logger/index.js';
import { MediaRegistry } from './media/registry.js';
import { MessageCacheStore } from './runtime/message-cache-store.js';
import { startGatewaySession } from './runtime/gateway.js';
import { superviseSessions } from './runtime/supervisor.js';
import { ChannelManager } from './web/channels.js';
import { ConsoleControl, createConsoleServer } from './web/server.js';

async function main(): Promise<void> {
  const environmentFile = loadStartupEnvironment();
  const config = loadConfig();
  const logger = createLogger(config);
  const shutdown = new AbortController();
  const mediaRegistry = new MediaRegistry(config, logger);
  const messageCache = createDouyinBridgeCache(config.runtime.messageCacheLimit, config.runtime.messageCacheTtlMs);
  const messageCacheStore = new MessageCacheStore(messageCache, config, logger);
  const control = config.web.enabled ? new ConsoleControl(new ChannelManager(config, logger)) : undefined;
  let web: Awaited<ReturnType<typeof createConsoleServer>> | undefined;
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  logger.info('正在启动 MeloFox（OneBot 11）');
  if (environmentFile) logger.info({ environmentFile }, '已加载运行配置');
  try {
    await messageCacheStore.initialize();
    await mediaRegistry.initialize();
    if (control) {
      await control.channels.initialize();
      const development = process.argv.includes('--web-dev');
      web = await createConsoleServer(config, logger, control, { development });
      await web.listen({ host: config.web.host, port: config.web.port });
      control.record('管理服务已启动');
      logger.info({ url: `http://${config.web.host}:${config.web.port}` }, '管理台已启动');
      if (development) logger.info('管理台热更新已启用');
    }
    await superviseSessions({
      signal: shutdown.signal,
      retryMs: config.runtime.reconnectIntervalMs,
      start: recover => startGatewaySession(config, logger, recover, mediaRegistry, messageCache, control),
      onRetry: reason => {
        if (control) { control.error = '会话正在重建；若持续失败，请检查 Chromium 安装、网络或服务日志'; control.record('正在恢复抖音会话'); }
        logger.warn({ reason: String(reason), retryMs: config.runtime.reconnectIntervalMs }, 'restarting gateway session');
      }
    });
  } finally {
    try { await web?.close(); }
    finally {
      try { await mediaRegistry.stop(); } finally { await messageCacheStore.stop(); }
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}

main().catch(error => {
  // Logger might not exist yet if config parsing failed.
  console.error(error);
  process.exit(1);
});
