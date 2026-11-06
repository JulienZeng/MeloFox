import { RuntimeSettingsStore } from './config/settings.js';
import { createDouyinBridgeCache } from './douyin/bridge.js';
import { createLogger, type AppLogger } from './logger/index.js';
import { sanitizeLogText } from './logger/sanitize.js';
import { startMediaHttpServer } from './media/http.js';
import { validateMediaListener } from './config/listeners.js';
import { MediaRegistry } from './media/registry.js';
import { MessageCacheStore } from './runtime/message-cache-store.js';
import { startGatewaySession } from './runtime/gateway.js';
import { superviseSessions } from './runtime/supervisor.js';
import { SERVICE_RESTART_EXIT_CODE } from './runtime/service-process.js';
import { ChannelManager } from './web/channels.js';
import { ConsoleControl, createConsoleServer } from './web/server.js';

let startupLogger: AppLogger | undefined;
const shutdown = new AbortController();
let restarting = false;
const stop = () => {
  restarting = false;
  if (!shutdown.signal.aborted) startupLogger?.info('收到退出信号，正在关闭 MeloFox');
  shutdown.abort();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
async function main(): Promise<void> {
  const { store: settings, imported } = await RuntimeSettingsStore.load();
  if (shutdown.signal.aborted) return;
  const config = settings.config();
  const logger = createLogger(config);
  startupLogger = logger;
  const mediaRegistry = new MediaRegistry(config, logger);
  const messageCache = createDouyinBridgeCache(config.runtime.messageCacheLimit, config.runtime.messageCacheTtlMs);
  const messageCacheStore = new MessageCacheStore(messageCache, config, logger);
  const control = config.web.enabled ? new ConsoleControl(new ChannelManager(config, logger)) : undefined;
  if (control) control.media = { state: config.media.enabled ? 'starting' : 'disabled', host: config.media.host, port: config.media.port };
  let media: Awaited<ReturnType<typeof startMediaHttpServer>>;
  let web: Awaited<ReturnType<typeof createConsoleServer>> | undefined;
  const restart = () => {
    if (shutdown.signal.aborted) return;
    restarting = true;
    logger.info('管理台请求重启服务，正在关闭通道、Chromium 并保存缓存');
    shutdown.abort();
  };
  logger.info('正在启动 MeloFox（OneBot 11）');
  logger.info({ settingsFile: settings.path }, imported ? '首次运行配置已导入并保存，后续通过控制台管理' : '已加载控制台保存的运行设置');
  try {
    await messageCacheStore.initialize();
    await mediaRegistry.initialize();
    if (control) {
      await control.channels.initialize();
      const development = process.argv.includes('--web-dev');
      web = await createConsoleServer(config, logger, control, { development, settings, restart });
      await web.listen({ host: config.web.host, port: config.web.port });
      logger.info({ url: `http://${config.web.host}:${config.web.port}` }, '管理台已启动');
      if (development) logger.info('管理台热更新已启用');
    }
    if (!control) validateMediaListener(config);
    try {
      media = await startMediaHttpServer(config, mediaRegistry, logger);
      if (control?.media && media) control.media.state = 'listening';
    } catch (error) {
      if (!control) throw error;
      control.media = { state: 'error', host: config.media.host, port: config.media.port,
        error: '媒体服务启动失败，请检查监听地址与端口，保存后重启服务。' };
      logger.error({ error }, control.media.error);
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
    try { await Promise.all([web?.close(), media?.close()]); }
    finally {
      try { await mediaRegistry.stop(); } finally { await messageCacheStore.stop(); }
      logger.info(restarting ? '服务已停止，正在启动新进程并加载保存的设置' : 'MeloFox 已停止');
    }
  }
}

main().then(() => {
  process.exit(restarting ? SERVICE_RESTART_EXIT_CODE : 0);
}).catch(error => {
  // Logger might not exist yet if config parsing failed.
  if (startupLogger) startupLogger.fatal({ error }, 'MeloFox 运行失败，进程退出');
  else console.error('[FATAL] [MeloFox] 启动配置加载失败：' + sanitizeLogText(error instanceof Error ? error.stack || error.message : String(error)));
  process.exit(1);
});
