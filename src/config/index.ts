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
    heartbeatIntervalMs: z.number().int().positive().default(30000)
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
  return ConfigSchema.parse(parsed);
}
