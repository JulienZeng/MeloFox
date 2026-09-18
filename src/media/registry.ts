import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import type { AppLogger } from '../logger/index.js';

export interface RegisteredMedia {
  id: string;
  sourceUrl: string;
  filePath: string;
  contentType: string;
  createdAt: number;
  size: number;
}

export class MediaRegistry {
  private readonly items = new Map<string, RegisteredMedia>();
  private readonly sourceToId = new Map<string, string>();
  private readonly downloads = new Map<string, Promise<string>>();
  private readonly cacheDir: string;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly logger?: AppLogger
  ) {
    this.cacheDir = resolve(process.cwd(), config.onebot.mediaCache.dir);
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, config.onebot.mediaCache.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  async cacheRemote(
    sourceUrl: string,
    contentType = 'application/octet-stream',
    extension?: string,
    options: { douyinDecryptKeyHex?: string } = {}
  ): Promise<string> {
    const existingId = this.sourceToId.get(sourceUrl);
    if (existingId) {
      const existing = this.items.get(existingId);
      if (existing && (await fileExists(existing.filePath))) {
        return this.publicUrl(existingId);
      }
    }

    const downloading = this.downloads.get(sourceUrl);
    if (downloading) {
      return downloading;
    }

    const promise = this.downloadRemote(sourceUrl, contentType, extension, options).finally(() => {
      this.downloads.delete(sourceUrl);
    });
    this.downloads.set(sourceUrl, promise);
    return promise;
  }

  async serve(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
    const item = this.items.get(request.params.id);
    if (!item) {
      await reply.code(404).send({
        status: 'failed',
        message: 'Media not found'
      });
      return;
    }

    const fileStat = await stat(item.filePath).catch(() => undefined);
    if (!fileStat) {
      this.items.delete(item.id);
      this.sourceToId.delete(item.sourceUrl);
      await reply.code(404).send({
        status: 'failed',
        message: 'Media file not found'
      });
      return;
    }

    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'private, max-age=300');
    reply.header('content-type', item.contentType);

    const range = parseRange(request.headers.range, fileStat.size);
    if (range) {
      reply.code(206);
      reply.header('content-range', `bytes ${range.start}-${range.end}/${fileStat.size}`);
      reply.header('content-length', String(range.end - range.start + 1));
      await reply.send(createReadStream(item.filePath, range));
      return;
    }

    reply.header('content-length', String(fileStat.size));
    await reply.send(createReadStream(item.filePath));
  }

  async cleanupExpired(): Promise<void> {
    const expiresBefore = Date.now() - this.config.onebot.mediaCache.ttlMs;
    for (const item of this.items.values()) {
      if (item.createdAt >= expiresBefore) {
        continue;
      }

      this.items.delete(item.id);
      this.sourceToId.delete(item.sourceUrl);
      await rm(item.filePath, { force: true }).catch(() => undefined);
    }
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  private async downloadRemote(
    sourceUrl: string,
    contentType: string,
    extension: string | undefined,
    options: { douyinDecryptKeyHex?: string }
  ): Promise<string> {
    await mkdir(this.cacheDir, { recursive: true });
    await this.cleanupExpired();

    const upstream = await fetch(sourceUrl, {
      redirect: 'follow',
      headers: buildUpstreamHeaders()
    });
    if (!upstream.ok) {
      throw new Error(`Failed to download media: ${upstream.status}`);
    }

    const upstreamContentType = upstream.headers.get('content-type');
    const resolvedContentType = upstreamContentType && /^(?:audio|image|video)\//i.test(upstreamContentType) ? upstreamContentType : contentType;
    const id = `${randomUUID()}${pickExtension(extension, sourceUrl, resolvedContentType)}`;
    const filePath = resolve(this.cacheDir, id);
    const downloadPath = `${filePath}.download`;
    const buffer = Buffer.from(await upstream.arrayBuffer());
    await writeFile(downloadPath, buffer);
    this.logger?.debug(
      { id, bytes: buffer.length, contentType: resolvedContentType, sourceHost: safeUrlHost(sourceUrl) },
      'downloaded media candidate'
    );

    const isVideo = /video\//i.test(resolvedContentType);
    const shouldProcessVideo = isVideo && (this.config.onebot.mediaCache.transcodeVideoToH264 || Boolean(options.douyinDecryptKeyHex));
    const normalized = await normalizeVideoFile(
      downloadPath,
      filePath,
      resolvedContentType,
      this.config,
      options.douyinDecryptKeyHex
    ).catch(error => ({
      ok: false,
      stderr: stringifyError(error)
    }));
    if (!normalized.ok && shouldProcessVideo) {
      const keptPath = await preserveDebugFile(downloadPath, `${filePath}.normalize.failed`);
      this.logger?.warn(
        { id, keptPath, ffmpeg: truncate(normalized.stderr ?? '', 4000) },
        'failed to normalize cached video media'
      );
      await rm(downloadPath, { force: true }).catch(() => undefined);
      throw new Error('Failed to normalize video media');
    }
    if (!normalized.ok) {
      await rename(downloadPath, filePath);
    }

    const fileStat = await stat(filePath);

    this.items.set(id, {
      id,
      sourceUrl,
      filePath,
      contentType: resolvedContentType,
      createdAt: Date.now(),
      size: fileStat.size
    });
    this.sourceToId.set(sourceUrl, id);
    return this.publicUrl(id);
  }

  private publicUrl(id: string): string {
    const configured = this.config.onebot.http.publicBaseUrl;
    if (configured) {
      return `${configured.replace(/\/$/, '')}/media/${id}`;
    }

    const host = this.config.onebot.http.host === '0.0.0.0' ? '127.0.0.1' : this.config.onebot.http.host;
    return `http://${host}:${this.config.onebot.http.port}/media/${id}`;
  }
}

function buildUpstreamHeaders(): HeadersInit {
  return {
    accept: '*/*',
    referer: 'https://www.douyin.com/',
    origin: 'https://www.douyin.com',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
  };
}

function parseRange(rangeHeader: string | undefined, size: number): { start: number; end: number } | undefined {
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return undefined;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return undefined;
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

function pickExtension(preferred: string | undefined, sourceUrl: string, contentType: string): string {
  if (preferred) {
    return preferred.startsWith('.') ? preferred : `.${preferred}`;
  }

  const pathExt = extname(new URL(sourceUrl).pathname);
  if (pathExt) {
    return pathExt;
  }

  if (/video\/mp4/i.test(contentType)) {
    return '.mp4';
  }
  if (/image\/jpeg/i.test(contentType)) {
    return '.jpg';
  }
  if (/image\/png/i.test(contentType)) {
    return '.png';
  }
  if (/image\/webp/i.test(contentType)) {
    return '.webp';
  }

  return '.bin';
}

async function fileExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => undefined));
}

async function preserveDebugFile(inputPath: string, outputPath: string): Promise<string | undefined> {
  const exists = await fileExists(inputPath);
  if (!exists) {
    return undefined;
  }

  await copyFile(inputPath, outputPath).catch(() => undefined);
  return (await fileExists(outputPath)) ? outputPath : undefined;
}

function safeUrlHost(sourceUrl: string): string | undefined {
  try {
    return new URL(sourceUrl).host;
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function normalizeVideoFile(
  inputPath: string,
  outputPath: string,
  contentType: string,
  config: AppConfig,
  decryptionKeyHex?: string
): Promise<{ ok: boolean; stderr?: string }> {
  const shouldTranscode = config.onebot.mediaCache.transcodeVideoToH264;
  if ((!shouldTranscode && !decryptionKeyHex) || !/video\//i.test(contentType)) {
    return { ok: false };
  }

  const tempOutputPath = `${outputPath}.transcoded.mp4`;
  const inputArgs = decryptionKeyHex ? ['-decryption_key', decryptionKeyHex] : [];
  const outputArgs = shouldTranscode
    ? [
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'main',
        '-level',
        '4.0',
        '-c:a',
        'aac',
        '-b:a',
        '128k'
      ]
    : ['-c', 'copy'];

  const result = await runFfmpeg(config.onebot.mediaCache.ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputArgs,
    '-i',
    inputPath,
    ...outputArgs,
    '-movflags',
    '+faststart',
    tempOutputPath
  ]);

  if (result.exitCode !== 0) {
    await rm(tempOutputPath, { force: true }).catch(() => undefined);
    return { ok: false, stderr: result.stderr };
  }

  await rename(tempOutputPath, outputPath);
  await rm(inputPath, { force: true }).catch(() => undefined);
  return { ok: true };
}

function runFfmpeg(binary: string, args: string[]): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise(resolveExit => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', chunk => {
      stderrChunks.push(Buffer.from(chunk));
    });

    child.on('error', error => resolveExit({ exitCode: null, stderr: stringifyError(error) }));
    child.on('close', code => resolveExit({ exitCode: code, stderr: Buffer.concat(stderrChunks).toString('utf8') }));
  });
}
