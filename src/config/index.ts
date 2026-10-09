import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const ConfigSchema = z.object({
  app: z.object({
    selfId: z.string().min(1),
    logLevel: z.string().default('info')
  }),
  browser: z.object({
    userDataDir: z.string().min(1),
    headless: z.boolean().default(false),
    douyinUrl: z.string().url()
  }),
  douyin: z.object({
    messagePageUrl: z.string().url(),
    hookMode: z.enum(['network', 'injection', 'dom']).default('network')
  }),
  onebot: z.object({
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
    forwardWs: z.object({
      enabled: z.boolean().default(true),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(3002)
    }),
    mediaCache: z.object({
      dir: z.string().min(1).default('./media-cache'),
      ttlMs: z.number().int().positive().default(60 * 60 * 1000),
      cleanupIntervalMs: z.number().int().positive().default(10 * 60 * 1000),
      transcodeVideoToH264: z.boolean().default(true),
      ffmpegPath: z.string().min(1).default('ffmpeg')
    })
  }),
  runtime: z.object({
    reconnectIntervalMs: z.number().int().positive().default(5000),
    actionTimeoutMs: z.number().int().positive().default(15000),
    heartbeatIntervalMs: z.number().int().positive().default(30000),
    sessionCheckIntervalMs: z.number().int().positive().default(30000),
    imDisconnectGraceMs: z.number().int().positive().default(60000),
    messageCacheLimit: z.number().int().positive().default(10000),
    messageCacheTtlMs: z.number().int().positive().default(86400000),
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
        transcodeVideoToH264:
          envBoolean('MEDIA_TRANSCODE_VIDEO_TO_H264') ?? config.onebot.mediaCache.transcodeVideoToH264,
        ffmpegPath: envString('MEDIA_FFMPEG_PATH') ?? config.onebot.mediaCache.ffmpegPath
      }
    },
    runtime: {
      ...config.runtime,
      reconnectIntervalMs: envNumber('RUNTIME_RECONNECT_INTERVAL_MS') ?? config.runtime.reconnectIntervalMs,
      actionTimeoutMs: envNumber('RUNTIME_ACTION_TIMEOUT_MS') ?? config.runtime.actionTimeoutMs,
      heartbeatIntervalMs: envNumber('RUNTIME_HEARTBEAT_INTERVAL_MS') ?? config.runtime.heartbeatIntervalMs,
      sessionCheckIntervalMs: envNumber('RUNTIME_SESSION_CHECK_INTERVAL_MS') ?? config.runtime.sessionCheckIntervalMs,
      imDisconnectGraceMs: envNumber('RUNTIME_IM_DISCONNECT_GRACE_MS') ?? config.runtime.imDisconnectGraceMs,
      messageCacheLimit: envNumber('RUNTIME_MESSAGE_CACHE_LIMIT') ?? config.runtime.messageCacheLimit,
      messageCacheTtlMs: envNumber('RUNTIME_MESSAGE_CACHE_TTL_MS') ?? config.runtime.messageCacheTtlMs,
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
