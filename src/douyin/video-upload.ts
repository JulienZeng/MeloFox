import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActionDeadline } from '../runtime/deadline.js';
import { loadOutgoingFile } from './file-upload.js';
import { crc32Hex, signVodRequest, type UploadCredentials } from './upload-signing.js';

export interface LoadedVideo { bytes: Buffer; thumbnail: Buffer }
const resource = z.string().min(1).max(1024).refine(value => !/[\x00-\x20\x7f]/.test(value));
const credential = z.string().min(1).max(16384).refine(value => !/[\x00-\x20\x7f]/.test(value));
const secret = z.string().regex(/^[a-f0-9]{64}$/i);
const md5 = z.string().regex(/^[a-f0-9]{32}$/i);
export const uploadedVideoSchema = z.object({
  video: z.object({ tkey: resource, md5, skey: z.string().regex(/^[a-f0-9]{32}$/i) }),
  poster: z.object({ oid: resource, md5, skey: secret }),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  check_pics: z.array(resource).length(1)
});
export type UploadedVideo = z.infer<typeof uploadedVideoSchema>;

function runTool(binary: string, args: string[], signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const parts: Buffer[] = [];
    let size = 0, failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', (part: Buffer) => {
      size += part.length;
      if (size > 1024 * 1024) { failure = new Error('Video metadata exceeds size limit'); stop(); }
      else parts.push(part);
    });
    // Decoder diagnostics can contain input metadata; keep them out of OneBot responses.
    child.stderr.resume();
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(new Error('Video preparation timed out or was cancelled'));
      else if (failure) reject(new Error('Video preparation tool failed', { cause: failure }));
      else if (code !== 0) reject(new Error('Video is not readable by the video preparation tool'));
      else resolve(Buffer.concat(parts));
    });
  });
}

export async function prepareOutgoingVideo(input: { file: string }, options: {
  maxBytes: number; allowedDirs: string[]; ffmpegPath: string; ffprobePath: string
}, deadline: ActionDeadline): Promise<LoadedVideo> {
  const file = await loadOutgoingFile({ file: input.file, name: 'onebot-video.mp4' }, options.maxBytes, deadline.signal, options.allowedDirs);
  if (file.bytes.length < 16 || file.bytes.subarray(4, 8).toString('ascii') !== 'ftyp') throw new Error('Video source must be an MP4 file');
  const dir = await mkdtemp(join(tmpdir(), 'douyin-send-video-'));
  try {
    const path = join(dir, 'input.mp4'), thumbnail = join(dir, 'cover.jpg');
    await writeFile(path, file.bytes, { mode: 0o600 });
    deadline.remainingMs();
    const metadata = JSON.parse((await runTool(options.ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path], deadline.signal)).toString());
    const stream = metadata.streams?.find((item: { codec_type?: string }) => item.codec_type === 'video');
    if (!Number.isSafeInteger(stream?.width) || !Number.isSafeInteger(stream?.height) || stream.width < 1 || stream.height < 1 ||
        stream.width > 16384 || stream.height > 16384 || !Number.isFinite(Number(metadata.format?.duration)) || Number(metadata.format?.duration) <= 0) {
      throw new Error('Video source has no valid video stream or duration');
    }
    deadline.remainingMs();
    await runTool(options.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
      '-i', path, '-map', '0:v:0', '-frames:v', '1', '-vf', "scale=w='min(480,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease",
      '-q:v', '3', thumbnail], deadline.signal);
    const cover = await readFile(thumbnail);
    if (cover.length > 1024 * 1024 || cover[0] !== 0xff || cover[1] !== 0xd8) throw new Error('Video thumbnail could not be generated');
    deadline.remainingMs();
    return { bytes: file.bytes, thumbnail: cover };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const configSchema = z.object({
  status_code: z.literal(0).optional(),
  public_image_config: z.object({ access_key_id: resource, secret_access_key: resource,
    session_token: credential,
    space_name: resource, expire_at: z.number().positive() }),
  inner_image_config: z.object({ space_name: resource })
});
export function videoUploadCredentials(value: unknown): { credentials: UploadCredentials; reviewSpace: string } {
  const config = configSchema.parse(value);
  const c = config.public_image_config;
  if (c.expire_at * 1000 <= Date.now()) throw new Error('Video upload credentials expired');
  return { credentials: { accessKeyId: c.access_key_id, secretAccessKey: c.secret_access_key,
    sessionToken: c.session_token, spaceName: c.space_name }, reviewSpace: config.inner_image_config.space_name };
}

async function jsonResponse(response: Response, stage: string): Promise<Record<string, any>> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Video ${stage} failed: HTTP ${response.status}`); }
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error(`Video ${stage} response exceeds size limit`);
      parts.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString()); } catch { throw new Error(`Video ${stage} returned invalid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ResponseMetadata?.Error) throw new Error(`Video ${stage} rejected by upload service`);
  return value;
}

const uploadHost = resource.refine(host => /^(?:[a-z0-9.-]+\.(?:bytedancevod\.com|snssdk\.com)|tos-[a-z0-9-]+\.douyin\.com)$/i.test(host));
const suppliedHeaders = z.record(credential).nullish();
const uploadAddressSchema = z.object({
  StoreInfos: z.array(z.object({ StoreUri: resource.refine(uri => /^[a-z0-9/_-]+$/i.test(uri) && !uri.includes('..')),
    Auth: credential, StorageHeader: suppliedHeaders })).length(1),
  UploadHosts: z.array(uploadHost).min(1), SessionKey: credential, UploadHeader: suppliedHeaders
});
const applySchema = z.object({ Result: z.object({
  UploadAddress: uploadAddressSchema.nullish(),
  InnerUploadAddress: z.object({ UploadNodes: z.array(uploadAddressSchema.omit({ UploadHosts: true }).extend({
    UploadHost: uploadHost
  })).min(1) }).nullish()
}) });

async function uploadResource(bytes: Buffer, type: 'image' | 'video', credentials: UploadCredentials,
  functions: unknown[], deadline: ActionDeadline): Promise<Record<string, any>> {
  deadline.remainingMs();
  const applyUrl = new URL('https://vod.bytedanceapi.com/');
  for (const [key, value] of Object.entries({ Action: 'ApplyUploadInner', Version: '2020-11-19', SpaceName: credentials.spaceName,
    FileType: type, IsInner: '1', NeedFallback: 'true', FileSize: String(bytes.length), s: randomUUID().replaceAll('-', '') })) applyUrl.searchParams.set(key, value);
  const applied = applySchema.parse(await jsonResponse(await fetch(applyUrl, { signal: deadline.signal, redirect: 'error',
    headers: signVodRequest('GET', applyUrl, Buffer.alloc(0), credentials) }), `${type} apply`));
  const inner = applied.Result.InnerUploadAddress?.UploadNodes[0];
  const address = inner ? { ...inner, UploadHosts: [inner.UploadHost] } : applied.Result.UploadAddress;
  if (!address) throw new Error(`Video ${type} apply returned no upload address`);
  const store = address.StoreInfos[0], crc = crc32Hex(bytes);
  const headers: Record<string, string> = {};
  for (const supplied of [store.StorageHeader, address.UploadHeader]) {
    for (const [name, value] of Object.entries(supplied ?? {})) {
      if (!/^[a-z0-9_-]+$/i.test(name) || /^(host|authorization|content-length|transfer-encoding|connection)$/i.test(name)) throw new Error('Unsafe video upload header');
      headers[name.toLowerCase()] = value;
    }
  }
  deadline.remainingMs();
  const uploaded = await jsonResponse(await fetch(`https://${address.UploadHosts[0]}/upload/v1/${store.StoreUri}`, {
    method: 'POST', signal: deadline.signal, redirect: 'error', headers: { ...headers, authorization: store.Auth,
      'content-type': 'application/octet-stream', 'content-crc32': crc }, body: new Uint8Array(bytes)
  }), `${type} upload`);
  if (uploaded.code !== 2000 || uploaded.data?.crc32 !== crc) throw new Error(`Video ${type} upload checksum/status mismatch`);
  const commitUrl = new URL('https://vod.bytedanceapi.com/');
  for (const [key, value] of Object.entries({ Action: 'CommitUploadInner', Version: '2020-11-19', SpaceName: credentials.spaceName })) commitUrl.searchParams.set(key, value);
  const body = Buffer.from(JSON.stringify({ SessionKey: address.SessionKey, Functions: functions }));
  deadline.remainingMs();
  const committed = await jsonResponse(await fetch(commitUrl, { method: 'POST', signal: deadline.signal, redirect: 'error',
    headers: { ...signVodRequest('POST', commitUrl, body, credentials), 'content-type': 'text/plain;charset=UTF-8' }, body: new Uint8Array(body)
  }), `${type} commit`);
  const result = committed.Result?.Results?.[0];
  if (!result || (type === 'image' ? result.UriStatus !== 2000 : result.UriStatus !== undefined && result.UriStatus !== 2000)) {
    throw new Error(`Video ${type} commit did not succeed`);
  }
  return result;
}

export async function uploadOutgoingVideo(video: LoadedVideo, config: unknown, deadline: ActionDeadline): Promise<UploadedVideo> {
  const { credentials, reviewSpace } = videoUploadCredentials(config);
  // The official Web uploader uses public credentials for the review-image space as well.
  const review = await uploadResource(video.thumbnail, 'image', { ...credentials, spaceName: reviewSpace }, [], deadline);
  const checkUri = resource.parse(review.Uri);
  const result = await uploadResource(video.bytes, 'video', credentials, [{ name: 'Encryption', input: {
    Config: { copies: 'cipher_v2', aes_chunk_size: '524288' }, PolicyParams: { 'policy-set': 'medium' }
  } }], deadline);
  const e = result.Encryption, extra = e?.Extra, metadata = result.VideoMeta;
  return uploadedVideoSchema.parse({ video: { tkey: e?.Uri, md5: e?.SourceMd5, skey: e?.SecretKey },
    poster: { oid: extra?.thumb_uri, md5: extra?.thumb_md5, skey: extra?.thumb_secret },
    width: Number(metadata?.Width), height: Number(metadata?.Height), check_pics: [checkUri] });
}
