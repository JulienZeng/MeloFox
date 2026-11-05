import { loadConfig } from './config/index.js';
import { loadStartupEnvironment } from './config/environment.js';
import { createDouyinBridgeCache } from './douyin/bridge.js';
import { createLogger, type AppLogger } from './logger/index.js';
import { sanitizeLogText } from './logger/sanitize.js';
import { MediaRegistry } from './media/registry.js';
import { MessageCacheStore } from './runtime/message-cache-store.js';
import { startGatewaySession } from './runtime/gateway.js';
import { superviseSessions } from './runtime/supervisor.js';
import { ChannelManager } from './web/channels.js';
import { ConsoleControl, createConsoleServer } from './web/server.js';

let startupLogger: AppLogger | undefined;
async function main(): Promise<void> {
  const environmentFile = loadStartupEnvironment();
  const config = loadConfig();
  const logger = createLogger(config);
  startupLogger = logger;
  const shutdown = new AbortController();
  const mediaRegistry = new MediaRegistry(config, logger);
  const messageCache = createDouyinBridgeCache(config.runtime.messageCacheLimit, config.runtime.messageCacheTtlMs);
  const messageCacheStore = new MessageCacheStore(messageCache, config, logger);
  const control = config.web.enabled ? new ConsoleControl(new ChannelManager(config, logger)) : undefined;
  let web: Awaited<ReturnType<typeof createConsoleServer>> | undefined;
  const stop = () => { logger.info('收到退出信号，正在关闭 MeloFox'); shutdown.abort(); };
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
      logger.info({ url: `http://${config.web.host}:${config.web.port}` }, '管理台已启动');
      if (development) logger.info('管理台热更新已启用');
    }
    await superviseSessions({
      signal: shutdown.signal,
      retryMs: config.runtime.reconnectIntervalMs,
      start: recover => startGatewaySession(config, logger, recover, mediaRegistry, messageCache, control),
      onRetry: reason => {
        if (control) { control.error = '会话正在重建；若持续失败，请检查 Chromium 安装、网络或服务日志'; }
        logger.warn({ reason: String(reason), retryMs: config.runtime.reconnectIntervalMs }, '正在重建网关会话');
      }
    });
  } finally {
    try { await web?.close(); }
    finally {
      try { await mediaRegistry.stop(); } finally { await messageCacheStore.stop(); }
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      logger.info('MeloFox 已停止');
    }
  }
}

main().catch(error => {
  // Logger might not exist yet if config parsing failed.
  if (startupLogger) startupLogger.fatal({ error }, 'MeloFox 运行失败，进程退出');
  else console.error('[FATAL] [MeloFox] 启动配置加载失败：' + sanitizeLogText(error instanceof Error ? error.stack || error.message : String(error)));
  process.exit(1);
});
