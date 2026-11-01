import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import type { AppLogger } from '../logger/index.js';
import { z } from 'zod';
import { readCacheJson, writeCacheJson } from '../runtime/cache-file.js';
import { decodeDouyinImage, imageFormat, type ImageFormat } from './image.js';
import { decodeDouyinFile, type FilePayload } from './file.js';
import { audioFormat } from './audio.js';

interface CacheOptions {
  validateAudio?: boolean;
  filePayload?: FilePayload;
  douyinDecryptKeyHex?: string;
  normalizeImage?: boolean;
  validateImage?: (bytes: Buffer, format: ImageFormat, signal?: AbortSignal) => Promise<void>;
  douyinImageKeyHex?: string;
  signal?: AbortSignal;
}

export interface RegisteredMedia {
  audioValidated?: boolean;
  fileName?: string;
  fileMd5?: string;
  id: string;
  sourceUrl: string;
  filePath: string;
  contentType: string;
  createdAt: number;
  size: number;
}

const mediaIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-zA-Z0-9]{1,10}$/;
const ownedFilePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-zA-Z0-9]{1,10}(?:\.download|\.transcoded\.mp4|\.normalize\.failed)?$/;
const mediaIndexSchema = z.object({ version: z.literal(1), items: z.array(z.object({
  audioValidated: z.boolean().optional(),
  id: z.string().regex(mediaIdPattern), sourceUrl: z.string().url(),
  contentType: z.string().regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:;[^\r\n]*)?$/),
  createdAt: z.number().finite().nonnegative(), size: z.number().int().nonnegative().safe(),
  fileName: z.string().min(1).max(255).regex(/^[^\x00-\x1f\x7f/\\]+$/).optional(),
  fileMd5: z.string().regex(/^[a-f0-9]{32}$/).optional()
})) });

export class MediaRegistry {
  private readonly items = new Map<string, RegisteredMedia>();
  private readonly sourceToId = new Map<string, string>();
  private readonly downloads = new Map<string, Promise<string>>();
  private readonly cacheDir: string;
  private readonly cleanupTimer: NodeJS.Timeout;
  private ready?: Promise<void>;
  private maintenance: Promise<unknown> = Promise.resolve();
  private readonly activeIds = new Set<string>();
  private readonly readers = new Map<string, number>();
  private readonly retired = new Map<string, RegisteredMedia>();
  private readonly shutdown = new AbortController();
  private stopPromise?: Promise<void>;

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

  initialize(): Promise<void> {
    return this.ready ??= this.restoreIndex();
  }

  private async restoreIndex(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    try {
      const raw = await readCacheJson(resolve(this.cacheDir, '.index.json'));
      if (raw !== undefined) {
        const index = mediaIndexSchema.parse(raw);
        for (const saved of index.items) {
          const filePath = resolve(this.cacheDir, saved.id);
          const info = await lstat(filePath).catch(() => undefined);
          if (!info?.isFile() || info.size !== saved.size || saved.createdAt > Date.now()) continue;
          await chmod(filePath, 0o600);
          this.items.set(saved.id, { ...saved, filePath });
          this.sourceToId.set(saved.sourceUrl, saved.id);
        }
      } else {
        // Pre-index releases already used UUID names. Preserve their URLs without renewing TTL.
        for (const entry of await readdir(this.cacheDir)) {
          if (!mediaIdPattern.test(entry)) continue;
          const filePath = resolve(this.cacheDir, entry);
          const info = await lstat(filePath).catch(() => undefined);
          if (!info?.isFile()) continue;
          await chmod(filePath, 0o600);
          const item = { id: entry, sourceUrl: `legacy-cache:///${entry}`, filePath,
            contentType: legacyContentType(extname(entry)), createdAt: info.mtimeMs, size: info.size };
          this.items.set(entry, item);
          this.sourceToId.set(item.sourceUrl, entry);
        }
      }
    } catch (error) {
      this.logger?.warn({ error }, 'media index cannot be restored; cleaning owned orphan files');
    }
    await this.pruneCompleted();
    await this.sweepOrphans();
    await this.persistIndex();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.maintenance.catch(() => undefined).then(operation);
    this.maintenance = pending;
    return pending;
  }

  private async persistIndex(): Promise<void> {
    const path = resolve(this.cacheDir, '.index.json');
    await writeCacheJson(path, JSON.stringify({ version: 1, items: [...this.items.values()].map(({ filePath: _path, ...item }) => item) }));
  }

  private expired(item: RegisteredMedia): boolean {
    return Date.now() - item.createdAt >= this.config.onebot.mediaCache.ttlMs;
  }

  private async removeItem(item: RegisteredMedia): Promise<void> {
    this.items.delete(item.id);
    if (this.sourceToId.get(item.sourceUrl) === item.id) this.sourceToId.delete(item.sourceUrl);
    if (this.readers.has(item.id)) this.retired.set(item.id, item);
    else await rm(item.filePath, { force: true });
  }

  private usage(): { files: number; bytes: number } {
    const all = [...this.items.values(), ...this.retired.values()];
    return { files: all.length, bytes: all.reduce((sum, item) => sum + item.size, 0) };
  }

  private async pruneCompleted(reserveBytes = 0, reserveFiles = 0): Promise<void> {
    for (const item of [...this.items.values()]) {
      const info = await lstat(item.filePath).catch(() => undefined);
      if (this.expired(item) || !info?.isFile() || info.size !== item.size || item.size > this.config.onebot.mediaCache.maxFileBytes) {
        await this.removeItem(item);
      }
    }
    const ordered = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
    const { maxBytes, maxFiles } = this.config.onebot.mediaCache;
    for (const item of ordered) {
      const usage = this.usage();
      if (usage.bytes + reserveBytes <= maxBytes && usage.files + reserveFiles <= maxFiles) break;
      if (!this.readers.has(item.id)) await this.removeItem(item);
    }
    const usage = this.usage();
    if (reserveFiles && (usage.bytes + reserveBytes > maxBytes || usage.files + reserveFiles > maxFiles)) {
      throw new Error('Media cache capacity exhausted by active readers');
    }
  }

  private async sweepOrphans(): Promise<void> {
    for (const entry of await readdir(this.cacheDir, { withFileTypes: true })) {
      const name = entry.name;
      const owned = ownedFilePattern.test(name) || /^\.index\.json\.[0-9a-f-]+\.tmp$/.test(name);
      if (!owned || entry.isDirectory() || this.items.has(name) || this.retired.has(name) ||
        [...this.activeIds].some(id => name.startsWith(`${id}.`))) continue;
      await rm(resolve(this.cacheDir, name), { force: true });
    }
  }

  async getStats(): Promise<{ files: number; bytes: number; activeDownloads: number; activeReaders: number; maxBytes: number; maxFiles: number }> {
    await this.initialize();
    return { ...this.usage(), activeDownloads: this.downloads.size,
      activeReaders: [...this.readers.values()].reduce((sum, count) => sum + count, 0),
      maxBytes: this.config.onebot.mediaCache.maxBytes, maxFiles: this.config.onebot.mediaCache.maxFiles };
  }

  async cacheRemote(
    sourceUrl: string,
    contentType = 'application/octet-stream',
    extension?: string,
    options: CacheOptions = {}
  ): Promise<string> {
    const signal = options.signal ? AbortSignal.any([options.signal, this.shutdown.signal]) : this.shutdown.signal;
    signal.throwIfAborted();
    if (extension) pickExtension(extension, sourceUrl, contentType);
    await this.initialize();
    const reused = await this.exclusive(async () => {
      const existingId = this.sourceToId.get(sourceUrl);
      const existing = existingId ? this.items.get(existingId) : undefined;
      if (!existing) return undefined;
      const info = await lstat(existing.filePath).catch(() => undefined);
      if (!this.expired(existing) && info?.isFile() && info.size === existing.size && (!options.validateAudio || existing.audioValidated)) return this.publicUrl(existing.id);
      await this.removeItem(existing);
      await this.persistIndex();
      return undefined;
    });
    signal.throwIfAborted();
    if (reused) return this.validateFileCache(reused, options.filePayload);

    const downloading = this.downloads.get(sourceUrl);
    if (downloading) {
      const url = await downloading;
      if (options.validateAudio && !this.findItem(url)?.audioValidated) throw new Error('Voice cache has no verified audio resource');
      return this.validateFileCache(url, options.filePayload);
    }

    const promise = this.downloadRemote(sourceUrl, contentType, extension, { ...options, signal }).finally(() => {
      this.downloads.delete(sourceUrl);
    });
    this.downloads.set(sourceUrl, promise);
    return this.validateFileCache(await promise, options.filePayload);
  }

  assertFileSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.config.onebot.mediaCache.maxFileBytes ||
        size > this.config.onebot.mediaCache.maxBytes) throw new Error('File exceeds cache size limit');
  }

  private async validateFileCache(url: string, file?: FilePayload): Promise<string> {
    if (file) {
      const cached = await this.getFile(url);
      if (cached.size !== file.size || cached.md5 !== file.md5.toLowerCase()) throw new Error('Cached file integrity metadata mismatch');
    }
    return url;
  }

  async getFile(file: string): Promise<{ size: number; file_name: string; file: string; url: string; md5: string }> {
    await this.initialize();
    return this.exclusive(async () => {
      const item = this.findItem(file);
      if (!item?.fileName || !item.fileMd5) throw new Error('File not found in verified media cache');
      const info = await lstat(item.filePath).catch(() => undefined);
      if (this.expired(item) || !info?.isFile() || info.size !== item.size) {
        await this.removeItem(item);
        await this.persistIndex();
        throw new Error('File cache expired or missing');
      }
      return { size: item.size, file_name: item.fileName, file: item.filePath, url: this.publicUrl(item.id), md5: item.fileMd5 };
    });
  }

  async serve(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
    await this.initialize();
    const served = await this.exclusive(async () => {
      const item = this.items.get(request.params.id);
      if (!item) return undefined;
      const info = await lstat(item.filePath).catch(() => undefined);
      if (this.expired(item) || !info?.isFile() || info.size !== item.size) {
        await this.removeItem(item);
        await this.persistIndex();
        return undefined;
      }
      const range = parseRange(request.headers.range, info.size);
      this.readers.set(item.id, (this.readers.get(item.id) ?? 0) + 1);
      const stream = createReadStream(item.filePath, range);
      stream.once('close', () => {
        void this.exclusive(async () => {
          const count = (this.readers.get(item.id) ?? 1) - 1;
          if (count) this.readers.set(item.id, count);
          else {
            this.readers.delete(item.id);
            if (this.retired.delete(item.id)) await rm(item.filePath, { force: true });
          }
        }).catch(error => this.logger?.warn({ error }, 'media reader cleanup failed'));
      });
      return { item, size: info.size, range, stream };
    });
    if (!served) { await reply.code(404).send({ status: 'failed', message: 'Media not found or expired' }); return; }
    const { item, size, range, stream } = served;

    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'private, no-store');
    reply.header('content-type', item.contentType);
    if (item.fileName) {
      reply.header('content-disposition', `attachment; filename="file.${extname(item.id).slice(1)}"; filename*=UTF-8''${encodeURIComponent(item.fileName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`);
      reply.header('x-content-type-options', 'nosniff');
    }

    if (range) {
      reply.code(206);
      reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
      reply.header('content-length', String(range.end - range.start + 1));
      await reply.send(stream);
      return;
    }

    reply.header('content-length', String(size));
    await reply.send(stream);
  }

  async cleanupExpired(): Promise<void> {
    await this.initialize();
    await this.exclusive(async () => {
      await this.pruneCompleted();
      await this.sweepOrphans();
      await this.persistIndex();
    });
  }

  async getImage(file: string): Promise<{ size: number; filename: string; file: string; url: string }> {
    await this.initialize();
    return this.exclusive(async () => {
      const item = this.findItem(file);
      if (!item || !/^image\//i.test(item.contentType)) throw new Error('Image not found in registered media cache');
      if (this.expired(item)) {
        await this.removeItem(item);
        await this.persistIndex();
        throw new Error('Image cache expired');
      }
      const fileStat = await lstat(item.filePath).catch(() => undefined);
      if (!fileStat?.isFile() || fileStat.size !== item.size) {
        await this.removeItem(item);
        await this.persistIndex();
        throw new Error('Image cache file is missing or invalid');
      }
      return { size: fileStat.size, filename: item.id, file: item.filePath, url: this.publicUrl(item.id) };
    });
  }

  async getRecord(file: string, format: string): Promise<{ file: string; url: string }> {
    const codecs: Record<string, [string, string]> = { wav: ['pcm_s16le', 'audio/wav'], mp3: ['libmp3lame', 'audio/mpeg'],
      ogg: ['libvorbis', 'audio/ogg'], flac: ['flac', 'audio/flac'], spx: ['libspeex', 'audio/ogg'],
      amr: ['libopencore_amrnb', 'audio/amr'], wma: ['wmav2', 'audio/x-ms-wma'], m4a: ['aac', 'audio/mp4'] };
    if (!Object.hasOwn(codecs, format)) throw new Error('Unsupported audio output format');
    await this.initialize();
    const signal = AbortSignal.any([AbortSignal.timeout(this.config.runtime.actionTimeoutMs), this.shutdown.signal]);
    return this.exclusive(async () => {
      signal.throwIfAborted();
      const original = this.findItem(file);
      if (!original?.audioValidated || this.expired(original)) throw new Error('Record not found in verified audio cache');
      const info = await lstat(original.filePath).catch(() => undefined);
      if (!info?.isFile() || info.size !== original.size) throw new Error('Record cache file is missing or invalid');
      if (extname(original.filePath) === `.${format}`) return { file: original.filePath, url: this.publicUrl(original.id) };
      const sourceUrl = `record-convert:${original.id}:${format}`;
      const existing = this.findItem(sourceUrl);
      if (existing && !this.expired(existing)) {
        const info = await lstat(existing.filePath).catch(() => undefined);
        if (info?.isFile() && info.size === existing.size) return { file: existing.filePath, url: this.publicUrl(existing.id) };
      }
      const id = `${randomUUID()}.${format}`, output = resolve(this.cacheDir, id);
      try {
        const result = await runFfmpeg(this.config.onebot.mediaCache.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-protocol_whitelist', 'file,pipe', '-i', original.filePath, '-map', '0:a:0', '-vn', '-c:a', codecs[format][0],
          ...(format === 'amr' ? ['-ar', '8000', '-ac', '1'] : []), '-fs', String(this.config.onebot.mediaCache.maxFileBytes + 1), output], signal);
        signal.throwIfAborted();
        if (result.exitCode !== 0) throw new Error(`Audio conversion to ${format} failed; check the configured ffmpeg encoder`);
        const info = await stat(output); this.assertFileSize(info.size);
        if (info.size >= this.config.onebot.mediaCache.maxFileBytes) throw new Error('Converted audio exceeds cache size limit');
        await chmod(output, 0o600);
        await this.pruneCompleted(info.size, 1);
        this.items.set(id, { id, sourceUrl, filePath: output, contentType: codecs[format][1], size: info.size,
          createdAt: original.createdAt, audioValidated: true });
        this.sourceToId.set(sourceUrl, id);
        await this.persistIndex();
        return { file: output, url: this.publicUrl(id) };
      } catch (error) {
        this.items.delete(id); this.sourceToId.delete(sourceUrl);
        await rm(output, { force: true }); throw error;
      }
    });
  }

  async resolveCachedUrl(file: string): Promise<string | undefined> {
    await this.initialize();
    return this.exclusive(async () => {
      const item = this.findItem(file);
      if (!item) return undefined;
      const info = await lstat(item.filePath).catch(() => undefined);
      if (this.expired(item) || !info?.isFile() || info.size !== item.size) {
        await this.removeItem(item);
        await this.persistIndex();
        return undefined;
      }
      return this.publicUrl(item.id);
    });
  }

  /** Reuse only registered media; ordinary local files still go through the send allowlist. */
  async resolveOutgoingMedia(file: string, kind: 'image' | 'video', signal: AbortSignal): Promise<string> {
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    signal.throwIfAborted();
    let reference = file, cacheReference = mediaIdPattern.test(file);
    if (/^https?:\/\//i.test(file)) {
      const url = new URL(file), base = new URL(this.publicUrl(''));
      // An upstream URL must retain its normal proxy/cache/timeout download semantics.
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return file;
      reference = url.pathname.slice(base.pathname.length);
      if (!mediaIdPattern.test(reference)) return file;
      cacheReference = true;
    } else if (file.startsWith('file://')) reference = fileURLToPath(file);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return file;
    await this.initialize();
    return this.exclusive(async () => {
      signal.throwIfAborted();
      const item = [...this.items.values()].find(item => item.id === reference || item.filePath === reference);
      if (!item) {
        if (cacheReference) throw new Error(`${kind} cache expired or missing`);
        return file;
      }
      if (!item.contentType.toLowerCase().startsWith(`${kind}/`)) throw new Error(`Cached media is not ${kind}`);
      if (this.expired(item)) {
        await this.removeItem(item); await this.persistIndex();
        throw new Error(`${kind} cache expired`);
      }
      const handle = await open(item.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size !== item.size) throw new Error('Cached media file is missing or invalid');
        this.assertFileSize(info.size);
        const bytes = await handle.readFile({ signal });
        signal.throwIfAborted();
        if (bytes.length !== item.size) throw new Error('Cached media changed while reading');
        return `base64://${bytes.toString('base64')}`;
      } finally { await handle.close(); }
    });
  }

  private findItem(file: string): RegisteredMedia | undefined {
    const exact = [...this.items.values()].find(value => value.id === file || value.sourceUrl === file || value.filePath === file);
    if (exact) return exact;
    try {
      const path = new URL(file).pathname;
      const prefix = new URL(this.publicUrl('')).pathname;
      const id = path.startsWith(prefix) ? path.slice(prefix.length) : path.startsWith('/media/') ? path.slice('/media/'.length) : '';
      return mediaIdPattern.test(id) ? this.items.get(id) : undefined;
    } catch { return undefined; }
  }

  async cleanCache(): Promise<void> {
    await this.initialize();
    await this.exclusive(async () => {
      for (const item of [...this.items.values()]) await this.removeItem(item);
      await this.sweepOrphans();
      await this.persistIndex();
    });
  }

  stop(): Promise<void> {
    return this.stopPromise ??= this.close();
  }

  private async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    this.shutdown.abort(new Error('Media registry stopped'));
    await Promise.allSettled([...this.downloads.values()]);
    await this.maintenance.catch(() => undefined);
    if (this.ready) {
      await this.ready;
      await this.exclusive(() => this.persistIndex());
    }
  }

  private async downloadRemote(
    sourceUrl: string,
    contentType: string,
    extension: string | undefined,
    options: CacheOptions
  ): Promise<string> {
    await this.cleanupExpired();
    if (options.filePayload) this.assertFileSize(options.filePayload.size);

    const upstream = await fetch(sourceUrl, {
      redirect: 'follow',
      signal: options.signal,
      headers: buildUpstreamHeaders()
    });
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new Error(`Failed to download media: ${upstream.status}`);
    }

    const upstreamContentType = upstream.headers.get('content-type');
    let resolvedContentType = !options.filePayload && upstreamContentType && /^(?:audio|image|video)\//i.test(upstreamContentType) ? upstreamContentType : contentType;
    const cacheId = randomUUID();
    let id = `${cacheId}${pickExtension(extension, sourceUrl, resolvedContentType)}`;
    let filePath = resolve(this.cacheDir, id);
    const downloadPath = `${filePath}.download`;
    let completed = false;
    this.activeIds.add(cacheId);
    try {
      const fileLimit = Math.min(this.config.onebot.mediaCache.maxFileBytes, this.config.onebot.mediaCache.maxBytes);
      let buffer = await readBoundedMedia(upstream, options.filePayload ? fileLimit * 2 + 256 : fileLimit, options.signal);
      options.signal?.throwIfAborted();
      if (options.filePayload) buffer = decodeDouyinFile(buffer, options.filePayload);
      let transcodeImage = false;
      if (options.normalizeImage) {
        buffer = decodeDouyinImage(buffer, options.douyinImageKeyHex);
        const format = imageFormat(buffer)!;
        resolvedContentType = format.contentType;
        id = `${cacheId}${format.extension}`;
        filePath = resolve(this.cacheDir, id);
        transcodeImage = Boolean(format.transcode);
        if (transcodeImage && options.validateImage) throw new Error('Sticker format requires conversion that could discard animation');
      }
      if (options.validateAudio) {
        const format = audioFormat(buffer);
        resolvedContentType = format.contentType;
        id = `${cacheId}${format.extension}`;
        filePath = resolve(this.cacheDir, id);
      }
      await writeFile(downloadPath, buffer, { mode: 0o600 });
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
        if (options.validateImage) await options.validateImage(buffer, imageFormat(buffer)!, options.signal);
        else {
          const result = await runFfmpeg(this.config.onebot.mediaCache.ffmpegPath,
            ['-hide_banner', '-loglevel', 'error', '-i', downloadPath, '-frames:v', '1', '-f', 'null', '-'], options.signal);
          if (result.exitCode !== 0) throw new Error('Image payload cannot be decoded');
        }
        options.signal?.throwIfAborted();
      }
      if (options.validateAudio) {
        const result = await runFfmpeg(this.config.onebot.mediaCache.ffmpegPath,
          ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', downloadPath, '-map', '0:a:0', '-f', 'null', '-'], options.signal);
        options.signal?.throwIfAborted();
        if (result.exitCode !== 0) throw new Error('Voice audio payload cannot be decoded');
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
      await chmod(filePath, 0o600);
      options.signal?.throwIfAborted();
      if (fileStat.size > this.config.onebot.mediaCache.maxFileBytes || fileStat.size > this.config.onebot.mediaCache.maxBytes) {
        throw new Error('Normalized media exceeds cache size limit');
      }
      await this.exclusive(async () => {
        options.signal?.throwIfAborted();
        await this.pruneCompleted(fileStat.size, 1);
        this.items.set(id, { id, sourceUrl, filePath, contentType: resolvedContentType, createdAt: Date.now(), size: fileStat.size,
          audioValidated: options.validateAudio || undefined,
          fileName: options.filePayload?.name, fileMd5: options.filePayload?.md5.toLowerCase() });
        this.sourceToId.set(sourceUrl, id);
        try { await this.persistIndex(); }
        catch (error) {
          this.items.delete(id);
          if (this.sourceToId.get(sourceUrl) === id) this.sourceToId.delete(sourceUrl);
          throw error;
        }
      });
      completed = true;
      return this.publicUrl(id);
    } finally {
      if (!completed) {
        await Promise.allSettled([downloadPath, filePath, `${filePath}.transcoded.mp4`].map(path => rm(path, { force: true })));
      }
      this.activeIds.delete(cacheId);
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
    if (!/^\.?[a-zA-Z0-9]{1,10}$/.test(preferred)) throw new Error('Invalid media extension');
    return preferred.startsWith('.') ? preferred : `.${preferred}`;
  }

  const pathExt = extname(new URL(sourceUrl).pathname);
  if (/^\.[a-zA-Z0-9]{1,10}$/.test(pathExt)) {
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

function legacyContentType(extension: string): string {
  const known: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  return known[extension.toLowerCase()] ?? 'application/octet-stream';
}

async function readBoundedMedia(response: Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'));
  if (length > limit) {
    await response.body?.cancel();
    throw new Error('Media download exceeds cache size limit');
  }
  if (!response.body) throw new Error('Media download has no body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('Media download exceeds cache size limit');
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
