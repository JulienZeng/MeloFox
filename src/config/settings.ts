import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { ConfigSchema, loadConfig, type AppConfig } from './index.js';
import { loadStartupEnvironment } from './environment.js';
import { settingsGroups, type RuntimeSettings, type SettingsSnapshot } from './settings-contracts.js';

const SettingsSchema = z.object({
  app: ConfigSchema.shape.app.removeDefault().strict(),
  browser: ConfigSchema.shape.browser.removeDefault().pick({ douyinUrl: true }).strict(),
  douyin: ConfigSchema.shape.douyin.removeDefault().strict(),
  onebot: z.object({
    rateLimitIntervalMs: ConfigSchema.shape.onebot.removeDefault().shape.rateLimitIntervalMs,
    mediaCache: ConfigSchema.shape.onebot.removeDefault().shape.mediaCache.removeDefault().omit({ dir: true }).strict(),
  }).strict(),
  network: ConfigSchema.shape.network.removeDefault().strict(),
  runtime: ConfigSchema.shape.runtime.removeDefault().omit({ messageCacheDir: true }).strict(),
}).strict();
const SavedConfigSchema = z.custom<Record<string, unknown>>(value => !!value && typeof value === 'object' &&
  ['web', 'app', 'browser', 'douyin', 'onebot', 'runtime'].every(key => Object.hasOwn(value, key))).pipe(ConfigSchema);
const RecordSchema = z.object({ version: z.literal(1), revision: z.string().uuid(), config: SavedConfigSchema }).strict();
type SettingsRecord = z.infer<typeof RecordSchema>;
const failure = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export function selectSettings(config: AppConfig): RuntimeSettings {
  const { dir: _dir, ...mediaCache } = config.onebot.mediaCache;
  const { messageCacheDir: _messages, ...runtime } = config.runtime;
  return structuredClone({ app: config.app, browser: { douyinUrl: config.browser.douyinUrl }, douyin: config.douyin,
    onebot: { rateLimitIntervalMs: config.onebot.rateLimitIntervalMs, mediaCache }, network: config.network, runtime });
}

export function settingsPath(directory = process.cwd(), environment: NodeJS.ProcessEnv = process.env): string {
  // This locator is the only process-level configuration read on every start. Never read .env to locate saved settings.
  return resolve(directory, environment.MELOFOX_CONFIG_DIR || 'data/config', 'settings.json');
}

async function readRecord(path: string): Promise<SettingsRecord> {
  try { return RecordSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error(`持久化设置无法读取：${path}。请修复或恢复备份，不会用环境变量覆盖。`);
  }
}

async function writeRecord(path: string, record: SettingsRecord, exclusive = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export class RuntimeSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active: string;
  private constructor(readonly path: string, private record: SettingsRecord) {
    // Runtime code mutates selfId and the selected media channel; compare to the original startup settings instead.
    this.active = JSON.stringify(selectSettings(record.config));
  }

  static async fromConfig(config: AppConfig, path: string): Promise<RuntimeSettingsStore> {
    const record = { version: 1 as const, revision: randomUUID(), config: structuredClone(config) };
    try { await writeRecord(path, record, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return new RuntimeSettingsStore(path, await readRecord(path));
  }

  static async load(options: { directory?: string; environment?: NodeJS.ProcessEnv } = {}) {
    const directory = options.directory ?? process.cwd(), environment = { ...(options.environment ?? process.env) };
    const path = settingsPath(directory, environment);
    try { return { store: new RuntimeSettingsStore(path, await readRecord(path)), imported: false }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const environmentFile = loadStartupEnvironment(directory, environment);
    const config = loadConfig(undefined, { directory, environment });
    return { store: await RuntimeSettingsStore.fromConfig(config, path), imported: true, environmentFile };
  }

  config(): AppConfig { return structuredClone(this.record.config); }

  async forgetInitialPassword(): Promise<void> {
    if (!this.record.config.web.token) return;
    const next = structuredClone(this.record);
    next.config.web.token = '';
    next.revision = randomUUID();
    await writeRecord(this.path, next);
    this.record = next;
  }

  snapshot(): SettingsSnapshot {
    const { config } = this.record;
    const values = selectSettings(config);
    return { revision: this.record.revision, values, restartRequired: JSON.stringify(values) !== this.active,
      deployment: { settingsFile: this.path, webEnabled: config.web.enabled, webHost: config.web.host,
        webPort: config.web.port, consoleDirectory: config.web.dataDir, browserDirectory: config.browser.userDataDir,
        browserHeadless: config.browser.headless, mediaDirectory: config.onebot.mediaCache.dir,
        messageDirectory: config.runtime.messageCacheDir } };
  }

  save(input: unknown): Promise<SettingsSnapshot> {
    const operation = this.queue.then(async () => {
      const parsed = z.object({ revision: z.string().uuid(), values: SettingsSchema }).strict().safeParse(input);
      if (!parsed.success) {
        const fields = settingsGroups.flatMap(group => group.fields);
        const messages = parsed.error.issues.map(issue => {
          const path = issue.path.slice(1).join('.');
          const label = fields.find(field => field.path === path)?.label ?? '设置';
          return `${label}格式或范围不正确`;
        });
        throw failure([...new Set(messages)].join('；'), 400);
      }
      const current = await readRecord(this.path);
      if (current.revision !== parsed.data.revision) {
        this.record = current;
        throw failure('设置已被其他页面修改，请重新加载后再保存', 409);
      }
      const values = parsed.data.values, base = current.config;
      const config = ConfigSchema.parse({ ...base, ...values,
        browser: { ...base.browser, ...values.browser },
        onebot: { ...base.onebot, ...values.onebot, mediaCache: { ...base.onebot.mediaCache, ...values.onebot.mediaCache } },
        runtime: { ...base.runtime, ...values.runtime } });
      const next: SettingsRecord = { version: 1, revision: randomUUID(), config };
      await writeRecord(this.path, next);
      this.record = next;
      return this.snapshot();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

/** Health checks must only read committed configuration and must never initialize or import env. */
export async function readSavedConfig(): Promise<AppConfig> { return (await readRecord(settingsPath())).config; }
