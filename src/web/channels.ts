import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import type { AppLogger } from "../logger/index.js";
import { OneBotActionRouter } from "../onebot/actions.js";
import type { OneBotEvent } from "../onebot/types.js";
import { OneBotReverseHttp } from "../onebot/reverse-http.js";
import { OneBotWebSocketHub } from "../onebot/websocket.js";
import { startOneBotHttpServer } from "../onebot/http.js";
import type { BrowserRuntime } from "../browser/chromium.js";
import type { DouyinBridge } from "../douyin/bridge.js";
import type { MediaRegistry } from "../media/registry.js";
import type { RealtimeMessageProcessor } from "../douyin/realtime.js";

const port = z.number().int().min(1).max(65535);
export const ChannelSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(60),
    type: z.enum(["http", "forward-ws", "reverse-ws", "reverse-http"]),
    enabled: z.boolean(),
    host: z.string().trim().min(1).max(253).default("127.0.0.1"),
    port: port.default(3002),
    url: z.string().max(2048).default(""),
    secret: z.string().max(512).default(""),
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
    accessToken: z.string().max(512).default(""),
    publicBaseUrl: z
      .union([
        z.literal(""),
        z
          .string()
          .url()
          .refine((v) => /^https?:\/\//.test(v), "媒体地址须使用 HTTP(S)"),
      ])
      .default(""),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "reverse-ws" || value.type === "reverse-http") {
      try {
        const url = new URL(value.url);
        if (
          !(value.type === "reverse-http" ? ["http:", "https:"] : ["ws:", "wss:"]).includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "请输入与通道类型匹配的有效地址，不含用户名、密码或片段",
        });
      }
    }
  });
export type Channel = z.infer<typeof ChannelSchema>;
export interface ChannelSession {
  browser: BrowserRuntime;
  bridge: DouyinBridge;
  mediaRegistry: MediaRegistry;
  realtime: RealtimeMessageProcessor;
}
interface RunningChannel {
  emit?(event: OneBotEvent): Promise<void>;
  stop(): Promise<void>;
  status(): { state: string; clients?: number; error?: string };
}

export class ChannelManager {
  private channels: Channel[] = [];
  private readonly running = new Map<string, RunningChannel>();
  private readonly errors = new Map<string, string>();
  private session?: ChannelSession;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {
    this.path = join(config.web.dataDir, "channels.json");
  }
  async initialize(): Promise<void> {
    try {
      this.channels = z
        .array(ChannelSchema)
        .max(32)
        .parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const base = {
        enabled: true,
        host: "127.0.0.1",
        port: 3002,
        url: "",
        accessToken: this.config.onebot.accessToken,
        publicBaseUrl: "",
      };
      if (this.config.onebot.http.enabled)
        this.channels.push(
          ChannelSchema.parse({
            ...base,
            ...this.config.onebot.http,
            id: randomUUID(),
            name: "OneBot HTTP",
            type: "http",
          }),
        );
      if (this.config.onebot.forwardWs.enabled)
        this.channels.push(
          ChannelSchema.parse({
            ...base,
            ...this.config.onebot.forwardWs,
            id: randomUUID(),
            name: "正向 WebSocket",
            type: "forward-ws",
          }),
        );
      if (this.config.onebot.reverseWs.enabled)
        this.channels.push(
          ChannelSchema.parse({
            ...base,
            ...this.config.onebot.reverseWs,
            id: randomUUID(),
            name: "反向 WebSocket",
            type: "reverse-ws",
          }),
        );
      if (this.config.onebot.reverseHttp.enabled) this.channels.push(ChannelSchema.parse({
        ...base, ...this.config.onebot.reverseHttp, id: randomUUID(), name: "反向 HTTP", type: "reverse-http"
      }));
      await this.persist(this.channels);
    }
    this.validate(this.channels);
    this.syncMediaConfig();
  }
  list() {
    return this.channels.map((channel) => ({
      ...channel,
      status: !channel.enabled
        ? { state: "disabled" }
        : this.errors.has(channel.id)
          ? { state: "error", error: this.errors.get(channel.id) }
          : (this.running.get(channel.id)?.status() ?? { state: "waiting" }),
    }));
  }
  attach(session: ChannelSession): Promise<void> {
    return this.serial(async () => {
      this.session = session;
      for (const channel of this.channels.filter((c) => c.enabled)) {
        try {
          this.running.set(channel.id, await this.start(channel));
          this.errors.delete(channel.id);
        } catch (error) {
          this.errors.set(channel.id, this.describe(error));
          this.logger.warn(
            { channel: channel.name },
            "channel could not start; repair it in web console",
          );
        }
      }
    });
  }
  detach(): Promise<void> {
    return this.serial(async () => {
      this.session = undefined;
      const results = await Promise.allSettled(
        [...this.running.values()].map((runtime) => runtime.stop()),
      );
      this.running.clear();
      this.errors.clear();
      const errors = results.filter((r) => r.status === "rejected");
      if (errors.length)
        throw new AggregateError(
          errors.map((r) => r.reason),
          "Channel cleanup failed",
        );
    });
  }
  async emit(event: OneBotEvent): Promise<void> {
    const missing = this.channels.some(channel => channel.enabled && channel.type !== "http" && !this.running.has(channel.id));
    if (missing && event.post_type !== 'meta_event') throw new Error('An event channel is unavailable; repair it before advancing the recovery cursor');
    await Promise.all([...this.running.values()].map(runtime => runtime.emit?.(event)));
  }
  save(input: unknown, id?: string): Promise<void> {
    return this.serial(async () => {
      const old = id ? this.channels.find((c) => c.id === id) : undefined;
      if (id && !old)
        throw Object.assign(new Error("通道不存在"), { statusCode: 404 });
      const channel = ChannelSchema.parse({
        ...(input as object),
        id: id ?? randomUUID(),
      });
      const next = old
        ? this.channels.map((c) => (c.id === id ? channel : c))
        : [...this.channels, channel];
      this.validate(next);
      await this.replace(old, channel, next);
    });
  }
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const old = this.channels.find((c) => c.id === id);
      if (!old)
        throw Object.assign(new Error("通道不存在"), { statusCode: 404 });
      await this.replace(
        old,
        undefined,
        this.channels.filter((c) => c.id !== id),
      );
    });
  }
  private async replace(
    old: Channel | undefined,
    channel: Channel | undefined,
    next: Channel[],
  ): Promise<void> {
    if (old) {
      await this.running.get(old.id)?.stop();
      this.running.delete(old.id);
    }
    let runtime: RunningChannel | undefined;
    try {
      if (channel?.enabled && this.session) runtime = await this.start(channel);
      await this.persist(next);
    } catch (error) {
      await runtime?.stop();
      if (old?.enabled && this.session) {
        try {
          this.running.set(old.id, await this.start(old));
        } catch (rollbackError) {
          this.errors.set(old.id, this.describe(rollbackError));
        }
      }
      throw Object.assign(new Error(`通道未保存：${this.describe(error)}`), {
        statusCode: 409,
      });
    }
    this.channels = next;
    this.syncMediaConfig();
    if (channel && runtime) this.running.set(channel.id, runtime);
    if (old) this.errors.delete(old.id);
    if (channel) this.errors.delete(channel.id);
  }
  private async start(channel: Channel): Promise<RunningChannel> {
    const config = structuredClone(this.config);
    config.onebot.accessToken = channel.accessToken;
    config.onebot.forwardWs.enabled = channel.type === "forward-ws";
    config.onebot.reverseWs.enabled = channel.type === "reverse-ws";
    config.onebot.forwardWs.host = channel.host;
    config.onebot.forwardWs.port = channel.port;
    config.onebot.reverseWs.url = channel.url;
    const session = this.session!;
    if (channel.type === "http") {
      config.onebot.http = {
        enabled: true,
        host: channel.host,
        port: channel.port,
        publicBaseUrl: channel.publicBaseUrl || undefined,
      };
      // Each channel needs its own token/config, while sharing the same bridge and media cache.
      const runtime = await startOneBotHttpServer(
        config,
        this.logger,
        new OneBotActionRouter(config, session.bridge, session.mediaRegistry),
        session.browser,
        session.mediaRegistry,
        session.realtime,
        session.bridge,
      );
      return {
        stop: () => runtime.stop(),
        status: () => ({ state: "listening" }),
      };
    }
    if (channel.type === "reverse-http") {
      config.onebot.reverseHttp = { enabled: true, url: channel.url, secret: channel.secret, timeoutMs: channel.timeoutMs };
      const runtime = new OneBotReverseHttp(config, this.logger, new OneBotActionRouter(config, session.bridge, session.mediaRegistry));
      await runtime.start(); return runtime;
    }
    const hub = new OneBotWebSocketHub(
      config,
      this.logger,
      new OneBotActionRouter(config, session.bridge, session.mediaRegistry),
    );
    try {
      await hub.start();
      return hub;
    } catch (error) {
      await hub.stop();
      throw error;
    }
  }
  private validate(channels: Channel[]): void {
    if (channels.length > 32)
      throw Object.assign(new Error("最多创建 32 个通道"), { statusCode: 400 });
    if (new Set(channels.map((c) => c.id)).size !== channels.length)
      throw new Error("通道 ID 重复");
    const destinations = channels.filter(c => c.enabled && c.type.startsWith("reverse-")).map(c => `${c.type}:${new URL(c.url).href}`);
    if (new Set(destinations).size !== destinations.length)
      throw Object.assign(new Error("同类型反向通道的地址不能重复"), { statusCode: 409 });
    const ports = new Set<number>();
    for (const c of channels.filter(
      (c) => c.enabled && ["http", "forward-ws"].includes(c.type),
    )) {
      if (ports.has(c.port) || c.port === this.config.web.port)
        throw Object.assign(
          new Error(`端口 ${c.port} 与其他通道或管理台冲突`),
          { statusCode: 409 },
        );
      ports.add(c.port);
    }
  }
  private syncMediaConfig(): void {
    const channel = this.channels.find((c) => c.enabled && c.type === "http");
    if (channel)
      this.config.onebot.http = {
        enabled: true,
        host: channel.host,
        port: channel.port,
        publicBaseUrl: channel.publicBaseUrl || undefined,
      };
    else this.config.onebot.http.enabled = false;
  }
  private async persist(channels: Channel[]): Promise<void> {
    await mkdir(this.config.web.dataDir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(channels, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temp, this.path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  private describe(error: unknown): string {
    // Connection error messages can contain tokens embedded in a URL.
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "EADDRINUSE"
      ? "端口已被占用，请更换端口"
      : code === "EACCES"
        ? "没有监听端口或写入配置的权限"
        : error instanceof z.ZodError
          ? "通道配置不合法"
          : "启动或写入失败，请检查监听地址及配置目录";
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
