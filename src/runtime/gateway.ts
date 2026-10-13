import { startBrowserRuntime, type BrowserRuntime } from '../browser/chromium.js';
import type { AppConfig } from '../config/index.js';
import { DouyinBridge, type DouyinBridgeCache } from '../douyin/bridge.js';
import { registerDouyinMessageListener } from '../douyin/message-listener.js';
import { enrichRealtimeMedia } from '../douyin/message-adapter.js';
import { RealtimeMessageProcessor } from '../douyin/realtime.js';
import type { AppLogger } from '../logger/index.js';
import { MediaRegistry } from '../media/registry.js';
import { OneBotActionRouter } from '../onebot/actions.js';
import { heartbeatEvent, toOneBotMessageEvent, toOneBotRecallEvent } from '../onebot/events.js';
import { startOneBotHttpServer, type HttpServerRuntime } from '../onebot/http.js';
import { OneBotWebSocketHub } from '../onebot/websocket.js';
import { SessionMonitor } from './session-monitor.js';
import { SessionCleanupError, type ManagedSession } from './supervisor.js';

export async function startGatewaySession(config: AppConfig, logger: AppLogger, recover: (reason: string) => void, sharedMediaRegistry?: MediaRegistry, sharedMessageCache?: DouyinBridgeCache): Promise<ManagedSession> {
  let browser: BrowserRuntime | undefined;
  let wsHub: OneBotWebSocketHub | undefined;
  let httpServer: HttpServerRuntime | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let monitor: SessionMonitor | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let bridge: DouyinBridge;
  const mediaRegistry = sharedMediaRegistry ?? new MediaRegistry(config, logger);
  // Capture starts before navigation; consumption waits until OneBot is ready.
  const realtime = new RealtimeMessageProcessor({
    logger,
    stickerAsText: config.runtime.stickerAsText,
    queueLimit: config.runtime.realtimeQueueLimit,
    mediaConcurrency: config.runtime.realtimeMediaConcurrency,
    mediaDetailWaitMs: config.runtime.realtimeMediaDetailWaitMs,
    mediaTimeoutMs: config.runtime.realtimeMediaTimeoutMs,
    emit: message => bridge.ingestMessage(message),
    emitRecall: notice => bridge.ingestRecall(notice),
    enrich: (candidate, signal) => enrichRealtimeMedia(browser!.page, mediaRegistry, logger, candidate, signal,
      resource => bridge.resolveFileUrl(resource))
  });
  const stop = (): Promise<void> => stopPromise ??= (async () => {
    stopping = true;
    monitor?.stop();
    clearInterval(heartbeatTimer);
    logger.info('stopping gateway session');
    const errors: unknown[] = [];
    for (const close of [() => realtime.stop(), () => httpServer?.stop(), () => wsHub?.stop(), () => browser?.stop(), () => sharedMediaRegistry ? undefined : mediaRegistry.stop()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new SessionCleanupError(errors, 'Gateway session cleanup failed');
  })();

  try {
    browser = await startBrowserRuntime(config, logger, { onNetworkEvent: event => { realtime.enqueue(event); } });
    bridge = new DouyinBridge(browser.page, logger, {
      actionTimeoutMs: config.runtime.actionTimeoutMs,
      videoSendTimeoutMs: config.runtime.videoSendTimeoutMs,
      ffmpegPath: config.onebot.mediaCache.ffmpegPath,
      ffprobePath: config.onebot.mediaCache.ffprobePath,
      maxFileBytes: config.onebot.mediaCache.maxFileBytes,
      fileSendAllowedDirs: [config.onebot.mediaCache.dir, ...config.runtime.fileSendAllowedDirs],
      messageCacheLimit: config.runtime.messageCacheLimit,
      messageCacheTtlMs: config.runtime.messageCacheTtlMs,
      cache: sharedMessageCache,
      isImConnected: () => browser!.isImConnected(),
      isRealtimeHealthy: () => realtime.getStats().good,
      isSessionHealthy: () => !stopping && (monitor?.healthy ?? true)
    });
    monitor = new SessionMonitor({
      page: browser.page,
      context: browser.context,
      accountId: bridge.accountId,
      intervalMs: config.runtime.sessionCheckIntervalMs,
      disconnectGraceMs: config.runtime.imDisconnectGraceMs,
      probe: () => bridge.refreshSession(),
      isImConnected: () => browser!.isImConnected(),
      recover,
      onHealthChange: (healthy, error) => {
        logger.warn({ healthy, error: error instanceof Error ? error.message : error }, healthy ? 'Douyin session probe recovered' : 'Douyin session unavailable; check login or connectivity');
        wsHub?.emit(heartbeatEvent(config, bridge.getStatus()));
      }
    });
    await bridge.start();
    monitor.bindAccount(bridge.accountId);
    if (bridge.accountId) config.app.selfId = bridge.accountId;
    const actionRouter = new OneBotActionRouter(config, bridge, mediaRegistry);
    wsHub = new OneBotWebSocketHub(config, logger, actionRouter);
    await wsHub.start();
    if (config.onebot.http.enabled) httpServer = await startOneBotHttpServer(config, logger, actionRouter, browser, mediaRegistry, realtime, bridge);
    registerDouyinMessageListener(bridge, message => {
      if (bridge.accountId) config.app.selfId = bridge.accountId;
      wsHub!.emit(toOneBotMessageEvent(config, message));
    });
    bridge.onRecall(notice => {
      if (bridge.accountId) config.app.selfId = bridge.accountId;
      wsHub!.emit(toOneBotRecallEvent(config, notice));
    });
    realtime.start();
    monitor.start();
    if (browser.page.isClosed()) recover('browser closed during startup');
    heartbeatTimer = setInterval(() => {
      wsHub!.emit(heartbeatEvent(config, bridge.getStatus()));
    }, config.runtime.heartbeatIntervalMs);
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
