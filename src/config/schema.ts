import { z } from 'zod';

function proxyUrl() {
  return z.string().max(2048).refine(value => {
    if (!value) return true;
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.hash; }
    catch { return false; }
  }, '代理地址须为有效的 HTTP(S) URL').default('');
}

export const ConfigSchema = z.object({
  web: z.object({
    enabled: z.boolean().default(true),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3000),
    token: z.string().default(''),
    dataDir: z.string().min(1).default('./data/console')
  }).default({}),
  app: z.object({
    selfId: z.string().min(1).max(128).default('douyin_bot_001'),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    logFormat: z.enum(['pretty', 'json']).default('pretty'),
    logMessageContent: z.boolean().default(true)
  }).default({}),
  browser: z.object({
    userDataDir: z.string().min(1).default('./douyin-profile'),
    headless: z.boolean().default(true),
    douyinUrl: z.string().url().default('https://www.douyin.com/')
  }).default({}),
  douyin: z.object({
    messagePageUrl: z.string().url().default('https://www.douyin.com/chat'),
    hookMode: z.enum(['network', 'injection', 'dom']).default('network')
  }).default({}),
  onebot: z.object({
    rateLimitIntervalMs: z.number().int().min(0).max(60000).default(500),
    accessToken: z.string().default(''),
    http: z.object({
      enabled: z.boolean().default(true),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(3001),
      publicBaseUrl: z.string().url().optional()
    }).default({}),
    reverseWs: z.object({
      enabled: z.boolean().default(false),
      url: z.string().url().default('ws://127.0.0.1:6700/onebot/v11/ws')
    }).default({}),
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
      port: z.number().int().min(1).max(65535).default(3002)
    }).default({}),
    mediaCache: z.object({
      dir: z.string().min(1).default('./media-cache'),
      ttlMs: z.number().int().positive().safe().default(7 * 86400000),
      cleanupIntervalMs: z.number().int().positive().max(2147483647).default(10 * 60 * 1000),
      maxBytes: z.number().int().positive().safe().default(1024 * 1024 * 1024),
      maxFiles: z.number().int().positive().max(2147483647).default(1000),
      maxFileBytes: z.number().int().positive().safe().default(128 * 1024 * 1024),
      transcodeVideoToH264: z.boolean().default(true),
      ffmpegPath: z.string().min(1).max(1024).default('ffmpeg'),
      ffprobePath: z.string().min(1).max(1024).default('ffprobe')
    }).default({})
  }).default({}),
  network: z.object({
    httpProxy: proxyUrl(),
    httpsProxy: proxyUrl(),
    noProxy: z.string().max(4096).default('localhost,127.0.0.1,::1')
  }).default({}),
  runtime: z.object({
    reconnectIntervalMs: z.number().int().positive().max(2147483647).default(5000),
    actionTimeoutMs: z.number().int().positive().max(2147483647).default(15000),
    videoSendTimeoutMs: z.number().int().positive().max(2147483647).default(120000),
    fileSendAllowedDirs: z.array(z.string().min(1).max(4096)).max(100).default([]),
    fileSendEnabled: z.boolean().default(false),
    shareAsText: z.boolean().default(false),
    stickerAsText: z.boolean().default(true),
    heartbeatIntervalMs: z.number().int().positive().max(2147483647).default(30000),
    sessionCheckIntervalMs: z.number().int().positive().max(2147483647).default(30000),
    imDisconnectGraceMs: z.number().int().positive().max(2147483647).default(60000),
    messageCacheLimit: z.number().int().positive().max(2147483647).default(10000),
    messageCacheTtlMs: z.number().int().positive().safe().default(7 * 86400000),
    messageCachePersist: z.boolean().default(true),
    messageCacheDir: z.string().min(1).default('./message-cache'),
    messageCacheFlushIntervalMs: z.number().int().positive().max(2147483647).default(5000),
    realtimeQueueLimit: z.number().int().positive().max(2147483647).default(10000),
    realtimeMediaConcurrency: z.number().int().positive().max(2147483647).default(2),
    realtimeMediaDetailWaitMs: z.number().int().positive().max(2147483647).default(5000),
    realtimeMediaTimeoutMs: z.number().int().positive().max(2147483647).default(120000)
  }).default({})
});

export type AppConfig = z.infer<typeof ConfigSchema>;

