import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const ConfigSchema = z.object({
  web: z.object({
    enabled: z.boolean().default(true),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3000),
    token: z.string().default(''),
    dataDir: z.string().min(1).default('./data/console')
  }).default({}),
  app: z.object({
    selfId: z.string().min(1),
    logLevel: z.string().default('info')
  }),
  browser: z.object({
    userDataDir: z.string().min(1),
    headless: z.boolean().default(true),
    douyinUrl: z.string().url()
  }),
  douyin: z.object({
    messagePageUrl: z.string().url(),
    hookMode: z.enum(['network', 'injection', 'dom']).default('network')
  }),
  onebot: z.object({
    rateLimitIntervalMs: z.number().int().min(0).max(60000).default(500),
    accessToken: z.string().default(''),
    http: z.object({
      enabled: z.boolean().default(true),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(3001),
      publicBaseUrl: z.string().url().optional()
    }),
    reverseWs: z.object({
      enabled: z.boolean().default(false),
      url: z.string().url()
    }),
    reverseHttp: z.object({
      enabled: z.boolean().default(false),
      url: z.string().url().refine(value => {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
      }).default('http://127.0.0.1:5701'),
      secret: z.string().max(512).default(''),
      timeoutMs: z.number().int().min(100).max(60000).default(10000)
    }).default({}),
    forwardWs: z.object({
      enabled: z.boolean().default(true),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(3002)
    }),
    mediaCache: z.object({
      dir: z.string().min(1).default('./media-cache'),
      ttlMs: z.number().int().positive().default(7 * 86400000),
      cleanupIntervalMs: z.number().int().positive().default(10 * 60 * 1000),
      maxBytes: z.number().int().positive().safe().default(1024 * 1024 * 1024),
      maxFiles: z.number().int().positive().default(1000),
      maxFileBytes: z.number().int().positive().safe().default(128 * 1024 * 1024),
      transcodeVideoToH264: z.boolean().default(true),
      ffmpegPath: z.string().min(1).default('ffmpeg'),
      ffprobePath: z.string().min(1).default('ffprobe')
    })
  }),
  runtime: z.object({
    reconnectIntervalMs: z.number().int().positive().default(5000),
    actionTimeoutMs: z.number().int().positive().default(15000),
    videoSendTimeoutMs: z.number().int().positive().default(120000),
    fileSendAllowedDirs: z.array(z.string().min(1)).default([]),
    fileSendEnabled: z.boolean().default(false),
    shareAsText: z.boolean().default(false),
    stickerAsText: z.boolean().default(true),
    heartbeatIntervalMs: z.number().int().positive().default(30000),
    sessionCheckIntervalMs: z.number().int().positive().default(30000),
    imDisconnectGraceMs: z.number().int().positive().default(60000),
    messageCacheLimit: z.number().int().positive().default(10000),
    messageCacheTtlMs: z.number().int().positive().default(7 * 86400000),
    messageCachePersist: z.boolean().default(true),
    messageCacheDir: z.string().min(1).default('./message-cache'),
    messageCacheFlushIntervalMs: z.number().int().positive().default(5000),
    realtimeQueueLimit: z.number().int().positive().default(10000),
    realtimeMediaConcurrency: z.number().int().positive().default(2),
    realtimeMediaDetailWaitMs: z.number().int().positive().default(5000),
    realtimeMediaTimeoutMs: z.number().int().positive().default(120000)
  })
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath = process.env.DOUYIN_ONEBOT_CONFIG ?? 'config/config.example.yaml'): AppConfig {
  const absolutePath = resolve(process.cwd(), configPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  const raw = readFileSync(absolutePath, 'utf8');
  const parsed = parseYaml(raw);
  return ConfigSchema.parse(applyEnvOverrides(ConfigSchema.parse(parsed)));
}

function applyEnvOverrides(config: AppConfig): AppConfig {
  return {
    ...config,
    web: {
      ...config.web,
      enabled: envBoolean('WEB_ENABLED') ?? config.web.enabled,
      host: envString('WEB_HOST') ?? config.web.host,
      port: envNumber('WEB_PORT') ?? config.web.port,
      token: envString('WEB_TOKEN') ?? config.web.token,
      dataDir: envString('WEB_DATA_DIR') ?? config.web.dataDir
    },
    app: {
      ...config.app,
      selfId: envString('APP_SELF_ID') ?? config.app.selfId,
      logLevel: envString('APP_LOG_LEVEL') ?? config.app.logLevel
    },
    browser: {
      ...config.browser,
      userDataDir: envString('BROWSER_USER_DATA_DIR') ?? config.browser.userDataDir,
      headless: envBoolean('BROWSER_HEADLESS') ?? config.browser.headless,
      douyinUrl: envString('BROWSER_DOUYIN_URL') ?? config.browser.douyinUrl
    },
    douyin: {
      ...config.douyin,
      messagePageUrl: envString('DOUYIN_MESSAGE_PAGE_URL') ?? config.douyin.messagePageUrl,
      hookMode: (envString('DOUYIN_HOOK_MODE') as AppConfig['douyin']['hookMode'] | undefined) ?? config.douyin.hookMode
    },
    onebot: {
      ...config.onebot,
      rateLimitIntervalMs: envNumber('ONEBOT_RATE_LIMIT_INTERVAL_MS') ?? config.onebot.rateLimitIntervalMs,
      accessToken: envString('ONEBOT_ACCESS_TOKEN', true) ?? config.onebot.accessToken,
      http: {
        ...config.onebot.http,
        enabled: envBoolean('ONEBOT_HTTP_ENABLED') ?? config.onebot.http.enabled,
        host: envString('ONEBOT_HTTP_HOST') ?? config.onebot.http.host,
        port: envNumber('ONEBOT_HTTP_PORT') ?? config.onebot.http.port,
        publicBaseUrl: envString('ONEBOT_HTTP_PUBLIC_BASE_URL', true) || config.onebot.http.publicBaseUrl
      },
      reverseWs: {
        ...config.onebot.reverseWs,
        enabled: envBoolean('ONEBOT_REVERSE_WS_ENABLED') ?? config.onebot.reverseWs.enabled,
        url: envString('ONEBOT_REVERSE_WS_URL') ?? config.onebot.reverseWs.url
      },
      reverseHttp: {
        ...config.onebot.reverseHttp,
        enabled: envBoolean('ONEBOT_REVERSE_HTTP_ENABLED') ?? config.onebot.reverseHttp.enabled,
        url: envString('ONEBOT_REVERSE_HTTP_URL') ?? config.onebot.reverseHttp.url,
        secret: envString('ONEBOT_REVERSE_HTTP_SECRET', true) ?? config.onebot.reverseHttp.secret,
        timeoutMs: envNumber('ONEBOT_REVERSE_HTTP_TIMEOUT_MS') ?? config.onebot.reverseHttp.timeoutMs
      },
      forwardWs: {
        ...config.onebot.forwardWs,
        enabled: envBoolean('ONEBOT_FORWARD_WS_ENABLED') ?? config.onebot.forwardWs.enabled,
        host: envString('ONEBOT_FORWARD_WS_HOST') ?? config.onebot.forwardWs.host,
        port: envNumber('ONEBOT_FORWARD_WS_PORT') ?? config.onebot.forwardWs.port
      },
      mediaCache: {
        ...config.onebot.mediaCache,
        dir: envString('MEDIA_CACHE_DIR') ?? config.onebot.mediaCache.dir,
        ttlMs: envNumber('MEDIA_CACHE_TTL_MS') ?? config.onebot.mediaCache.ttlMs,
        cleanupIntervalMs: envNumber('MEDIA_CACHE_CLEANUP_INTERVAL_MS') ?? config.onebot.mediaCache.cleanupIntervalMs,
        maxBytes: envNumber('MEDIA_CACHE_MAX_BYTES') ?? config.onebot.mediaCache.maxBytes,
        maxFiles: envNumber('MEDIA_CACHE_MAX_FILES') ?? config.onebot.mediaCache.maxFiles,
        maxFileBytes: envNumber('MEDIA_CACHE_MAX_FILE_BYTES') ?? config.onebot.mediaCache.maxFileBytes,
        transcodeVideoToH264:
          envBoolean('MEDIA_TRANSCODE_VIDEO_TO_H264') ?? config.onebot.mediaCache.transcodeVideoToH264,
        ffmpegPath: envString('MEDIA_FFMPEG_PATH') ?? config.onebot.mediaCache.ffmpegPath,
        ffprobePath: envString('MEDIA_FFPROBE_PATH') ?? config.onebot.mediaCache.ffprobePath
      }
    },
    runtime: {
      ...config.runtime,
      reconnectIntervalMs: envNumber('RUNTIME_RECONNECT_INTERVAL_MS') ?? config.runtime.reconnectIntervalMs,
      actionTimeoutMs: envNumber('RUNTIME_ACTION_TIMEOUT_MS') ?? config.runtime.actionTimeoutMs,
      videoSendTimeoutMs: envNumber('RUNTIME_VIDEO_SEND_TIMEOUT_MS') ?? config.runtime.videoSendTimeoutMs,
      fileSendAllowedDirs: envString('RUNTIME_FILE_SEND_ALLOWED_DIRS') === undefined ? config.runtime.fileSendAllowedDirs : JSON.parse(envString('RUNTIME_FILE_SEND_ALLOWED_DIRS')!),
      fileSendEnabled: envBoolean('RUNTIME_FILE_SEND_ENABLED') ?? config.runtime.fileSendEnabled,
      shareAsText: envBoolean('RUNTIME_SHARE_AS_TEXT') ?? config.runtime.shareAsText,
      stickerAsText: envBoolean('RUNTIME_STICKER_AS_TEXT') ?? config.runtime.stickerAsText,
      heartbeatIntervalMs: envNumber('RUNTIME_HEARTBEAT_INTERVAL_MS') ?? config.runtime.heartbeatIntervalMs,
      sessionCheckIntervalMs: envNumber('RUNTIME_SESSION_CHECK_INTERVAL_MS') ?? config.runtime.sessionCheckIntervalMs,
      imDisconnectGraceMs: envNumber('RUNTIME_IM_DISCONNECT_GRACE_MS') ?? config.runtime.imDisconnectGraceMs,
      messageCacheLimit: envNumber('RUNTIME_MESSAGE_CACHE_LIMIT') ?? config.runtime.messageCacheLimit,
      messageCacheTtlMs: envNumber('RUNTIME_MESSAGE_CACHE_TTL_MS') ?? config.runtime.messageCacheTtlMs,
      messageCachePersist: envBoolean('RUNTIME_MESSAGE_CACHE_PERSIST') ?? config.runtime.messageCachePersist,
      messageCacheDir: envString('RUNTIME_MESSAGE_CACHE_DIR') ?? config.runtime.messageCacheDir,
      messageCacheFlushIntervalMs: envNumber('RUNTIME_MESSAGE_CACHE_FLUSH_INTERVAL_MS') ?? config.runtime.messageCacheFlushIntervalMs,
      realtimeQueueLimit: envNumber('RUNTIME_REALTIME_QUEUE_LIMIT') ?? config.runtime.realtimeQueueLimit,
      realtimeMediaConcurrency: envNumber('RUNTIME_REALTIME_MEDIA_CONCURRENCY') ?? config.runtime.realtimeMediaConcurrency,
      realtimeMediaDetailWaitMs: envNumber('RUNTIME_REALTIME_MEDIA_DETAIL_WAIT_MS') ?? config.runtime.realtimeMediaDetailWaitMs,
      realtimeMediaTimeoutMs: envNumber('RUNTIME_REALTIME_MEDIA_TIMEOUT_MS') ?? config.runtime.realtimeMediaTimeoutMs
    }
  };
}

function envString(name: string, allowEmpty = false): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  if (!allowEmpty && value === '') {
    return undefined;
  }
  return value;
}

function envNumber(name: string): number | undefined {
  const value = envString(name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable ${name}: ${value}`);
  }
  return parsed;
}

function envBoolean(name: string): boolean | undefined {
  const value = envString(name)?.toLowerCase();
  if (value === undefined) {
    return undefined;
  }
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) {
    return false;
  }
  throw new Error(`Invalid boolean environment variable ${name}: ${process.env[name]}`);
}
