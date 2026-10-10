import { loadConfig } from './config/index.js';
import { createDouyinBridgeCache } from './douyin/bridge.js';
import { createLogger } from './logger/index.js';
import { MediaRegistry } from './media/registry.js';
import { MessageCacheStore } from './runtime/message-cache-store.js';
import { startGatewaySession } from './runtime/gateway.js';
import { superviseSessions } from './runtime/supervisor.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const shutdown = new AbortController();
  const mediaRegistry = new MediaRegistry(config, logger);
  const messageCache = createDouyinBridgeCache(config.runtime.messageCacheLimit, config.runtime.messageCacheTtlMs);
  const messageCacheStore = new MessageCacheStore(messageCache, config, logger);
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  logger.info('starting douyin-onebot');
  try {
    await messageCacheStore.initialize();
    await mediaRegistry.initialize();
    await superviseSessions({
      signal: shutdown.signal,
      retryMs: config.runtime.reconnectIntervalMs,
      start: recover => startGatewaySession(config, logger, recover, mediaRegistry, messageCache),
      onRetry: reason => logger.warn({ reason: String(reason), retryMs: config.runtime.reconnectIntervalMs }, 'restarting gateway session')
    });
  } finally {
    try { await mediaRegistry.stop(); } finally { await messageCacheStore.stop(); }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(error => {
  // Logger might not exist yet if config parsing failed.
  console.error(error);
  process.exit(1);
});
