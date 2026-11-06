import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, type AppConfig } from './schema.js';
import { migrateMediaConfig } from './media-migration.js';
export { ConfigSchema, type AppConfig } from './schema.js';

/** Read legacy YAML/env only when importing a new installation. */
export function loadConfig(configPath?: string, options: { environment?: NodeJS.ProcessEnv; directory?: string } = {}): AppConfig {
  const environment = options.environment ?? process.env;
  const selected = configPath ?? environment.DOUYIN_ONEBOT_CONFIG;
  const absolutePath = resolve(options.directory ?? process.cwd(), selected || 'config/config.example.yaml');
  if (selected && !existsSync(absolutePath)) throw new Error(`Config file not found: ${absolutePath}`);
  const parsed = existsSync(absolutePath) ? parseYaml(readFileSync(absolutePath, 'utf8')) : {};
  return ConfigSchema.parse(applyEnvOverrides(ConfigSchema.parse(migrateMediaConfig(parsed)), environment));
}

function applyEnvOverrides(config: AppConfig, environment: NodeJS.ProcessEnv): AppConfig {
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
      logLevel: (envString('APP_LOG_LEVEL') as AppConfig['app']['logLevel'] | undefined) ?? config.app.logLevel,
      logFormat: (envString('APP_LOG_FORMAT') as AppConfig['app']['logFormat'] | undefined) ?? config.app.logFormat,
      logMessageContent: envBoolean('APP_LOG_MESSAGE_CONTENT') ?? config.app.logMessageContent
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
        port: envNumber('ONEBOT_HTTP_PORT') ?? config.onebot.http.port
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
      }
    },
    media: {
      ...config.media,
      enabled: envBoolean('MEDIA_ENABLED') ?? config.media.enabled,
      host: envString('MEDIA_HOST') ?? config.media.host,
      port: envNumber('MEDIA_PORT') ?? config.media.port,
      publicBaseUrl: envString('MEDIA_PUBLIC_BASE_URL', true) ?? legacyMediaUrl() ?? config.media.publicBaseUrl,
      signingKey: envString('MEDIA_SIGNING_KEY', true) ?? config.media.signingKey,
      cache: {
        ...config.media.cache,
        dir: envString('MEDIA_CACHE_DIR') ?? config.media.cache.dir,
        ttlMs: envNumber('MEDIA_CACHE_TTL_MS') ?? config.media.cache.ttlMs,
        cleanupIntervalMs: envNumber('MEDIA_CACHE_CLEANUP_INTERVAL_MS') ?? config.media.cache.cleanupIntervalMs,
        maxBytes: envNumber('MEDIA_CACHE_MAX_BYTES') ?? config.media.cache.maxBytes,
        maxFiles: envNumber('MEDIA_CACHE_MAX_FILES') ?? config.media.cache.maxFiles,
        maxFileBytes: envNumber('MEDIA_CACHE_MAX_FILE_BYTES') ?? config.media.cache.maxFileBytes,
        transcodeVideoToH264:
          envBoolean('MEDIA_TRANSCODE_VIDEO_TO_H264') ?? config.media.cache.transcodeVideoToH264,
        ffmpegPath: envString('MEDIA_FFMPEG_PATH') ?? config.media.cache.ffmpegPath,
        ffprobePath: envString('MEDIA_FFPROBE_PATH') ?? config.media.cache.ffprobePath
      }
    },
    network: {
      httpProxy: envString('http_proxy', true) ?? envString('HTTP_PROXY', true) ?? config.network.httpProxy,
      httpsProxy: envString('https_proxy', true) ?? envString('HTTPS_PROXY', true) ?? config.network.httpsProxy,
      noProxy: envString('no_proxy', true) ?? envString('NO_PROXY', true) ?? config.network.noProxy
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

  function legacyMediaUrl(): string | undefined {
    const old = envString('ONEBOT_HTTP_PUBLIC_BASE_URL', true);
    if (old === undefined || old === '') return old;
    const url = new URL(old);
    const oldPort = envNumber('ONEBOT_HTTP_PORT') ?? config.onebot.http.port ?? 3001;
    if (Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === oldPort)
      url.port = String(envNumber('MEDIA_PORT') ?? config.media.port);
    return url.href.replace(/\/$/, '');
  }

  function envString(name: string, allowEmpty = false): string | undefined {
    const value = environment[name];
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
    throw new Error(`Invalid boolean environment variable ${name}: ${environment[name]}`);
  }
}
