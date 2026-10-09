import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import type { AppLogger } from '../logger/index.js';
import { decodeDouyinImage, imageFormat } from './image.js';

interface CacheOptions {
  douyinDecryptKeyHex?: string;
  normalizeImage?: boolean;
  douyinImageKeyHex?: string;
  signal?: AbortSignal;
}

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
      void this.cleanupExpired().catch(error => this.logger?.warn({ error }, 'media cache cleanup failed'));
    }, config.onebot.mediaCache.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  async cacheRemote(
    sourceUrl: string,
    contentType = 'application/octet-stream',
    extension?: string,
    options: CacheOptions = {}
  ): Promise<string> {
    options.signal?.throwIfAborted();
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

  async getImage(file: string): Promise<{ size: number; filename: string; file: string; url: string }> {
    const item = [...this.items.values()].find(value =>
      value.id === file || value.sourceUrl === file || value.filePath === file || this.publicUrl(value.id) === file);
    if (!item || !/^image\//i.test(item.contentType)) throw new Error('Image not found in registered media cache');
    if (Date.now() - item.createdAt >= this.config.onebot.mediaCache.ttlMs) {
      await this.cleanupExpired();
      throw new Error('Image cache expired');
    }
    const fileStat = await stat(item.filePath);
    return { size: fileStat.size, filename: item.id, file: item.filePath, url: this.publicUrl(item.id) };
  }

  async cleanCache(): Promise<void> {
    // Snapshot completed registrations only; never remove an active download's output.
    const items = [...this.items.values()];
    for (const item of items) {
      this.items.delete(item.id);
      this.sourceToId.delete(item.sourceUrl);
    }
    await Promise.all(items.map(item => rm(item.filePath, { force: true })));
  }

  async stop(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.allSettled([...this.downloads.values()]);
  }

  private async downloadRemote(
    sourceUrl: string,
    contentType: string,
    extension: string | undefined,
    options: CacheOptions
  ): Promise<string> {
    await mkdir(this.cacheDir, { recursive: true });
    await this.cleanupExpired();

    const upstream = await fetch(sourceUrl, {
      redirect: 'follow',
      signal: options.signal,
      headers: buildUpstreamHeaders()
    });
    if (!upstream.ok) {
      throw new Error(`Failed to download media: ${upstream.status}`);
    }

    const upstreamContentType = upstream.headers.get('content-type');
    let resolvedContentType = upstreamContentType && /^(?:audio|image|video)\//i.test(upstreamContentType) ? upstreamContentType : contentType;
    const cacheId = randomUUID();
    let id = `${cacheId}${pickExtension(extension, sourceUrl, resolvedContentType)}`;
    let filePath = resolve(this.cacheDir, id);
    const downloadPath = `${filePath}.download`;
    let completed = false;
    try {
      let buffer: Buffer = Buffer.from(await upstream.arrayBuffer());
      options.signal?.throwIfAborted();
      let transcodeImage = false;
      if (options.normalizeImage) {
        buffer = decodeDouyinImage(buffer, options.douyinImageKeyHex);
        const format = imageFormat(buffer)!;
        resolvedContentType = format.contentType;
        id = `${cacheId}${format.extension}`;
        filePath = resolve(this.cacheDir, id);
        transcodeImage = Boolean(format.transcode);
      }
      await writeFile(downloadPath, buffer);
      this.logger?.debug(
        { id, bytes: buffer.length, contentType: resolvedContentType, sourceHost: safeUrlHost(sourceUrl) },
        'downloaded media candidate'
      );

      if (transcodeImage) {
        const result = await runFfmpeg(this.config.onebot.mediaCache.ffmpegPath,
          ['-hide_banner', '-loglevel', 'error', '-y', '-i', downloadPath, '-frames:v', '1', filePath], options.signal);
        options.signal?.throwIfAborted();
        if (result.exitCode !== 0) throw new Error('Failed to convert HEIF image to PNG');
        await rm(downloadPath, { force: true });
      } else if (options.normalizeImage) {
        const result = await runFfmpeg(this.config.onebot.mediaCache.ffmpegPath,
          ['-hide_banner', '-loglevel', 'error', '-i', downloadPath, '-frames:v', '1', '-f', 'null', '-'], options.signal);
        options.signal?.throwIfAborted();
        if (result.exitCode !== 0) throw new Error('Image payload cannot be decoded');
      }
      const isVideo = /video\//i.test(resolvedContentType);
      const shouldProcessVideo = isVideo && (this.config.onebot.mediaCache.transcodeVideoToH264 || Boolean(options.douyinDecryptKeyHex));
      const normalized = await normalizeVideoFile(
        downloadPath, filePath, resolvedContentType, this.config, options.douyinDecryptKeyHex, options.signal
      ).catch(error => ({ ok: false, stderr: stringifyError(error) }));
      options.signal?.throwIfAborted();
      if (!normalized.ok && shouldProcessVideo) {
        const keptPath = await preserveDebugFile(downloadPath, `${filePath}.normalize.failed`);
        this.logger?.warn(
          { id, keptPath, ffmpeg: truncate(normalized.stderr ?? '', 4000) },
          'failed to normalize cached video media'
        );
        throw new Error('Failed to normalize video media');
      }
      if (!normalized.ok && !transcodeImage) await rename(downloadPath, filePath);

      const fileStat = await stat(filePath);
      options.signal?.throwIfAborted();
      this.items.set(id, {
        id, sourceUrl, filePath, contentType: resolvedContentType, createdAt: Date.now(), size: fileStat.size
      });
      this.sourceToId.set(sourceUrl, id);
      completed = true;
      return this.publicUrl(id);
    } finally {
      if (!completed) {
        await Promise.allSettled([downloadPath, filePath, `${filePath}.transcoded.mp4`].map(path => rm(path, { force: true })));
      }
    }
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
  decryptionKeyHex?: string,
  signal?: AbortSignal
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
  ], signal);

  if (result.exitCode !== 0) {
    await rm(tempOutputPath, { force: true }).catch(() => undefined);
    return { ok: false, stderr: result.stderr };
  }

  await rename(tempOutputPath, outputPath);
  await rm(inputPath, { force: true }).catch(() => undefined);
  return { ok: true };
}

function runFfmpeg(binary: string, args: string[], signal?: AbortSignal): Promise<{ exitCode: number | null; stderr: string }> {
  signal?.throwIfAborted();
  return new Promise(resolveExit => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal
    });
    let errorText = '';
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    child.stderr?.on('data', chunk => {
      if (capturedBytes >= 65536) return;
      const data = Buffer.from(chunk).subarray(0, Math.max(0, 65536 - capturedBytes));
      stderrChunks.push(data);
      capturedBytes += data.length;
    });
    child.on('error', error => { errorText = stringifyError(error); });
    child.on('close', code => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolveExit({ exitCode: code, stderr: errorText || Buffer.concat(stderrChunks).toString('utf8') });
    });
  });
}
