import { startBrowserRuntime, type BrowserRuntime } from '../browser/chromium.js';
import type { AppConfig } from '../config/index.js';
import { DouyinBridge, type DouyinBridgeCache } from '../douyin/bridge.js';
import { registerDouyinMessageListener } from '../douyin/message-listener.js';
import { enrichRealtimeMedia } from '../douyin/message-adapter.js';
import { RealtimeMessageProcessor } from '../douyin/realtime.js';
import { scopedLogger, type AppLogger } from '../logger/index.js';
import { MediaRegistry } from '../media/registry.js';
import { OneBotActionRouter } from '../onebot/actions.js';
import { heartbeatEvent, toOneBotMessageEvent, toOneBotRecallEvent, toOneBotGroupNotice, toOneBotGroupUpload } from '../onebot/events.js';
import { startOneBotHttpServer, type HttpServerRuntime } from '../onebot/http.js';
import { OneBotReverseHttp } from '../onebot/reverse-http.js';
import { OneBotWebSocketHub, type OneBotWebSocketRuntime } from '../onebot/websocket.js';
import type { ConsoleControl } from '../web/server.js';
import { SessionMonitor } from './session-monitor.js';
import { SessionCleanupError, type ManagedSession } from './supervisor.js';
import { GatewayRestart } from './restart.js';

export async function startGatewaySession(config: AppConfig, logger: AppLogger, recover: (reason: string) => void, sharedMediaRegistry?: MediaRegistry, sharedMessageCache?: DouyinBridgeCache, console?: ConsoleControl): Promise<ManagedSession> {
  logger = scopedLogger(logger, '会话');
  let browser: BrowserRuntime | undefined;
  let wsHub: OneBotWebSocketRuntime | undefined;
  let httpServer: HttpServerRuntime | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let recoveryTimer: NodeJS.Timeout | undefined;
  let recoveryTask: Promise<void> | undefined;
  let requestsTimer: NodeJS.Timeout | undefined, requestsTask: Promise<void> | undefined;
  let monitor: SessionMonitor | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let bridge: DouyinBridge;
  const restart = new GatewayRestart(recover);
  const mediaRegistry = sharedMediaRegistry ?? new MediaRegistry(config, logger);
  // Capture starts before navigation; consumption waits until OneBot is ready.
  const realtime = new RealtimeMessageProcessor({
    logger: scopedLogger(logger, '消息接收'),
    stickerAsText: config.runtime.stickerAsText,
    queueLimit: config.runtime.realtimeQueueLimit,
    mediaConcurrency: config.runtime.realtimeMediaConcurrency,
    mediaDetailWaitMs: config.runtime.realtimeMediaDetailWaitMs,
    mediaTimeoutMs: config.runtime.realtimeMediaTimeoutMs,
    emit: message => bridge.ingestMessage(message),
    emitRecall: notice => bridge.ingestRecall(notice),
    emitReaction: candidate => bridge.ingestReaction(candidate),
    emitGroupNotice: candidate => bridge.ingestGroupNotice(candidate),
    updateDetail: detail => bridge.updateCachedMessageDetail(detail),
    enrich: (candidate, signal) => enrichRealtimeMedia(browser!.page, mediaRegistry, logger, candidate, signal,
      resource => bridge.resolveFileUrl(resource))
  });
  const stop = (): Promise<void> => stopPromise ??= (async () => {
    stopping = true;
    restart.stop();
    if (bridge) OneBotActionRouter.stopForBridge(bridge);
    monitor?.stop();
    clearInterval(heartbeatTimer);
    clearInterval(recoveryTimer);
    clearInterval(requestsTimer);
    logger.info('正在停止网关会话');
    const errors: unknown[] = [];
    for (const close of [() => realtime.stop(), () => recoveryTask, () => requestsTask, () => httpServer?.stop(), () => wsHub?.stop(), () => browser?.stop(), () => sharedMediaRegistry ? undefined : mediaRegistry.stop()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    console?.detached();
    if (errors.length) throw new SessionCleanupError(errors, 'Gateway session cleanup failed');
  })();

  try {
    browser = await startBrowserRuntime(config, logger, { onNetworkEvent: event => { realtime.enqueue(event); } });
    if (console) { console.browser = browser; console.recover = recover; console.error = undefined; }
    bridge = new DouyinBridge(browser.page, logger, {
      mediaProxy: config.network,
      requestRestart: delay => restart.request(delay),
      actionTimeoutMs: config.runtime.actionTimeoutMs,
      logMessageContent: config.app.logMessageContent,
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
      // Do not let a new authenticated cookie trigger recovery before the
      // login transaction has finished persisting the session.
      probe: () => (console?.login?.inProgress || console?.assisting?.()) && !bridge.loggedIn
        ? Promise.resolve({ loggedIn: false })
        : bridge.refreshSession(),
      isImConnected: () => browser!.isImConnected(),
      recover,
      onHealthChange: (healthy, error) => {
        if (healthy) logger.info('抖音会话检测已恢复');
        else if (error) logger.warn({ error }, '抖音会话检测失败；请检查管理台登录状态及网络');
        else logger.info('抖音会话尚未就绪，请在管理台检查登录状态');
        void wsHub?.emit(heartbeatEvent(config, bridge.getStatus())).catch(error => logger.warn({ error }, 'OneBot 心跳投递失败'));
      }
    });
    await bridge.start();
    monitor.bindAccount(bridge.accountId);
    if (bridge.accountId) config.app.selfId = bridge.accountId;
    const actionRouter = new OneBotActionRouter(config, bridge, mediaRegistry, logger);
    if (console) {
      console.bridge = bridge;
      wsHub = { emit: event => console.channels.emit(event), stop: () => console.channels.detach() };
      await console.channels.attach({ browser, mediaRegistry, realtime, bridge });
      logger.info({ accountId: bridge.accountId }, bridge.loggedIn ? '抖音会话已就绪' : '消息网关已启动，等待抖音账号登录');
    } else {
      const hub = new OneBotWebSocketHub(config, logger, actionRouter);
      const httpPush = config.onebot.reverseHttp.enabled ? new OneBotReverseHttp(config, logger, actionRouter) : undefined;
      wsHub = { emit: async event => { await Promise.all([hub.emit(event), httpPush?.emit(event)]); },
        stop: async () => { await Promise.all([hub.stop(), httpPush?.stop()]); } };
      await hub.start(); await httpPush?.start();
      if (config.onebot.http.enabled) httpServer = await startOneBotHttpServer(config, logger, actionRouter, browser, mediaRegistry, realtime, bridge);
    }
    registerDouyinMessageListener(bridge, async message => {
      if (bridge.accountId) config.app.selfId = bridge.accountId;
      const upload = toOneBotGroupUpload(config, message);
      if (upload) await wsHub!.emit(upload);
      await wsHub!.emit(toOneBotMessageEvent(config, message));
    });
    bridge.onGroupNotice(notice => {
      if (bridge.accountId) config.app.selfId = bridge.accountId;
      return wsHub!.emit(toOneBotGroupNotice(config, notice));
    });
    bridge.onGroupRequest((request, flag) => wsHub!.emit({ time: Math.floor(Number(request.createTime) > 1e12 ? Number(request.createTime) / 1000 : Number(request.createTime) || Date.now() / 1000),
      self_id: bridge.accountId!, post_type: 'request', request_type: 'group', sub_type: 'add', group_id: request.convShortId,
      user_id: request.userId, comment: request.applyReason ?? '', flag, platform: 'douyin' }));
    bridge.onRecall(notice => {
      if (bridge.accountId) config.app.selfId = bridge.accountId;
      return wsHub!.emit(toOneBotRecallEvent(config, notice));
    });
    bridge.onReaction(notice => wsHub!.emit({ time: Math.floor(notice.timestamp / 1000), self_id: bridge.accountId!,
      post_type: 'notice', notice_type: 'douyin_reaction', sub_type: notice.operation,
      event_id: notice.eventId, message_id: notice.messageId, user_id: notice.operatorId, emoji: notice.emoji,
      conversation_id: notice.conversationId, conversation_short_id: notice.conversationShortId,
      ...(notice.conversationType === 'group' ? { group_id: notice.conversationShortId } : {}) }));
    realtime.start();
    const catchUp = () => {
      if (stopping || recoveryTask || !bridge.accountId) return;
      const before = realtime.getStats();
      recoveryTask = bridge.recoverMessages(candidate => realtime.recover(candidate)).then(recovered => {
        if (recovered) realtime.markRecovered(before);
      }).catch(error => {
        logger.warn({ error }, '抖音消息补偿未完成，已保留进度待重试');
      }).finally(() => { recoveryTask = undefined; });
    };
    catchUp();
    recoveryTimer = setInterval(catchUp, config.runtime.sessionCheckIntervalMs);
    const pollRequests = () => {
      if (stopping || requestsTask) return;
      requestsTask = bridge.pollGroupRequests().catch(error => logger.warn({ error }, '入群申请检查未完成'))
        .finally(() => { requestsTask = undefined; });
    };
    pollRequests(); requestsTimer = setInterval(pollRequests, Math.max(60000, config.runtime.sessionCheckIntervalMs));
    monitor.start();
    if (console) console.checkSession = () => monitor!.check();
    if (browser.page.isClosed()) recover('browser closed during startup');
    heartbeatTimer = setInterval(() => {
      void wsHub!.emit(heartbeatEvent(config, bridge.getStatus())).catch(error => logger.warn({ error }, 'OneBot 心跳投递失败'));
    }, config.runtime.heartbeatIntervalMs);
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
