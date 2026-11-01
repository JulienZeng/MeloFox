import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadMedia, type MediaDownloadOptions, type OutgoingMediaCache } from '../media/outgoing.js';
import { ActionDeadline } from '../runtime/deadline.js';
import { crc32Hex, signVodRequest, type UploadCredentials } from './upload-signing.js';

export interface OutgoingFile { file: string; name?: string }
export interface LoadedFile { bytes: Buffer; name: string; format: string; md5: string }
export interface UploadedFile { name: string; format: string; size: number; md5: string; uri: string; skey: string }

function fileName(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255) {
    throw new Error('Invalid file name; use a basename without paths or control characters');
  }
  return name;
}

export async function loadOutgoingFile(input: OutgoingFile, maxBytes: number, signal: AbortSignal, allowedDirs: string[] = [], options: MediaDownloadOptions = {}, cache?: OutgoingMediaCache): Promise<LoadedFile> {
  signal.throwIfAborted();
  const checkSize = (size: number) => {
    if (size > maxBytes) throw new Error(`File exceeds maximum size of ${maxBytes} bytes`);
  };
  let name = input.name;
  let bytes: Buffer;
  if (input.file.startsWith('base64://')) {
    const encoded = input.file.slice(9);
    checkSize(Math.floor(encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0));
    if (!encoded || encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('Invalid Base64 file data');
    }
    if (!name) throw new Error('Base64 file requires an original file name');
    fileName(name);
    bytes = Buffer.from(encoded, 'base64');
  } else {
    let stream: AsyncIterable<Uint8Array>;
    let close: () => void;
    if (/^https?:\/\//i.test(input.file)) {
      const url = new URL(input.file);
      if (url.username || url.password) throw new Error('File URL must not contain credentials');
      name ??= decodeURIComponent(basename(url.pathname));
      fileName(name);
      const downloaded = await (cache ? cache.download(url, options, maxBytes, signal) : downloadMedia(url, options, maxBytes, signal));
      stream = { async *[Symbol.asyncIterator]() { yield downloaded; } };
      close = () => {};
    } else {
      if (/^[a-z][a-z0-9+.-]*:/i.test(input.file) && !input.file.startsWith('file://')) throw new Error('Unsupported file source scheme');
      const path = input.file.startsWith('file://') ? fileURLToPath(input.file) : input.file;
      name ??= basename(path);
      fileName(name);
      const resolved = await realpath(path);
      let allowed = false;
      for (const dir of allowedDirs) {
        const root = await realpath(dir).catch(() => undefined);
        if (!root) continue;
        const child = relative(root, resolved);
        if (child && child !== '..' && !child.startsWith('../') && !isAbsolute(child)) { allowed = true; break; }
      }
      if (!allowed) throw new Error('Local file is outside allowed directories; use a reachable HTTP URL, Base64, or configure RUNTIME_FILE_SEND_ALLOWED_DIRS');
      const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('File source must be a regular file');
        checkSize(stat.size);
        signal.throwIfAborted();
      } catch (error) { await handle.close(); throw error; }
      const reader = handle.createReadStream({ signal, autoClose: true });
      stream = reader;
      close = () => reader.destroy();
    }
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const part of stream) {
        signal.throwIfAborted();
        size += part.byteLength;
        checkSize(size);
        parts.push(Buffer.from(part));
      }
      bytes = Buffer.concat(parts, size);
    } finally { close(); }
  }
  checkSize(bytes.byteLength);
  if (!bytes.length) throw new Error('Empty files are not supported');
  return { bytes, name: fileName(name!), format: extname(name!).slice(1).toLowerCase(), md5: createHash('md5').update(bytes).digest('hex') };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing file upload field: ${label}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) throw new Error(`Invalid file upload field: ${label}`);
  return value;
}

export function fileUploadCredentials(value: unknown): UploadCredentials {
  const root = object(value, 'config');
  if (root.status_code !== undefined && root.status_code !== 0) throw new Error('File upload config was rejected');
  const config = object(root.public_file_config, 'public_file_config');
  const expires = Number(config.expire_at);
  if (!Number.isFinite(expires) || expires * (expires > 1e11 ? 1 : 1000) <= Date.now()) throw new Error('File upload credentials expired');
  return { accessKeyId: string(config.access_key_id, 'access_key_id'), secretAccessKey: string(config.secret_access_key, 'secret_access_key'),
    sessionToken: string(config.session_token, 'session_token'), spaceName: string(config.space_name, 'space_name') };
}

async function jsonResponse(response: Response, stage: string): Promise<Record<string, unknown>> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`File ${stage} failed: HTTP ${response.status}`); }
  if (!response.body) throw new Error(`File ${stage} returned no response`);
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error(`File ${stage} response is too large`);
      parts.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error(`File ${stage} returned invalid JSON`); }
  const result = object(parsed, stage);
  const metadata = result.ResponseMetadata as Record<string, unknown> | undefined;
  if (metadata?.Error) throw new Error(`File ${stage} was rejected by upload service`);
  return result;
}

export async function uploadOutgoingFile(file: LoadedFile, config: unknown, deadline: ActionDeadline): Promise<UploadedFile> {
  deadline.remainingMs();
  const credentials = fileUploadCredentials(config);
  const applyUrl = new URL('https://vas-lf-x.douyin.com/');
  for (const [key, value] of Object.entries({ Action: 'ApplyUploadInner', Version: '2020-11-19', SpaceName: credentials.spaceName,
    FileType: 'object', UploadNum: '1', device_platform: 'douyin_pc', OpenGcmEnc: '1' })) applyUrl.searchParams.set(key, value);
  const apply = object((await jsonResponse(await fetch(applyUrl, { signal: deadline.signal, redirect: 'error', headers: signVodRequest('GET', applyUrl, Buffer.alloc(0), credentials) }), 'apply')).Result, 'Result');
  const address = object(apply.UploadAddress, 'UploadAddress');
  const stores = address.StoreInfos;
  const hosts = address.UploadHosts;
  if (!Array.isArray(stores) || stores.length !== 1 || !Array.isArray(hosts)) throw new Error('File upload did not return a single upload target');
  const store = object(stores[0], 'StoreInfos');
  const host = string(hosts[0], 'UploadHost');
  if (!/^(?:[a-z0-9.-]+\.(?:bytedancevod\.com|snssdk\.com)|tos-[a-z0-9-]+\.douyin\.com)$/i.test(host)) throw new Error('Untrusted file upload host');
  const uri = string(store.StoreUri, 'StoreUri');
  if (!/^[a-z0-9_-]+\/[a-z0-9/_-]+$/i.test(uri) || uri.includes('..')) throw new Error('Invalid file upload URI');
  const mode = object(apply.SDKParam, 'SDKParam').server_gcm_encryption_mode;
  if (mode !== 3) throw new Error('Unsupported file upload encryption mode');
  const key = string(object(address.AdvanceOption, 'AdvanceOption').EncryptionKey, 'EncryptionKey');
  const sessionKey = string(address.SessionKey, 'SessionKey');
  const crc = crc32Hex(file.bytes);
  const headers: Record<string, string> = {};
  for (const supplied of [store.StorageHeader, address.UploadHeader, store.UploadHeader]) {
    if (supplied === null || supplied === undefined) continue;
    for (const [name, value] of Object.entries(object(supplied, 'UploadHeader'))) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || /^(host|authorization|content-length|transfer-encoding)$/i.test(name)) throw new Error('Unsafe file upload header');
      headers[name] = string(value, 'UploadHeader');
    }
  }
  deadline.remainingMs();
  const upload = await jsonResponse(await fetch(`https://${host}/upload/v1/${uri}`, { signal: deadline.signal, redirect: 'error', method: 'POST',
    headers: { ...headers, authorization: string(store.Auth, 'Auth'), 'content-type': 'application/octet-stream',
      'content-crc32': crc, 'X-Upload-Content-CRC32': crc, 'X-Upload-Server-Gcm-Encryption-Mode': String(mode), 'X-Upload-Server-Gcm-Encryption-Key': key }, body: new Uint8Array(file.bytes) }), 'upload');
  if (upload.code !== 2000 || object(upload.data, 'upload.data').crc32 !== crc) throw new Error('File upload checksum/status mismatch');
  // Object uploads commit GCM parameters directly, not image Encryption/thumbnail functions.
  const commitUrl = new URL('https://vas-lf-x.douyin.com/');
  for (const [name, value] of Object.entries({ Action: 'CommitUploadInner', Version: '2020-11-19', SpaceName: credentials.spaceName, device_platform: 'douyin_pc' })) commitUrl.searchParams.set(name, value);
  const body = Buffer.from(JSON.stringify({ SessionKey: sessionKey, EncryptionMode: String(mode), EncryptionKey: key }));
  deadline.remainingMs();
  const commit = object((await jsonResponse(await fetch(commitUrl, { signal: deadline.signal, redirect: 'error', method: 'POST',
    headers: { ...signVodRequest('POST', commitUrl, body, credentials), 'content-type': 'application/json' }, body }), 'commit')).Result, 'commit.Result');
  if (!Array.isArray(commit.Results) || commit.Results.length !== 1) throw new Error('File commit did not return a single resource');
  const result = object(commit.Results[0], 'commit.Results');
  if (result.UriStatus !== 2000) throw new Error('File commit resource was rejected');
  const encryption = object(result.Encryption, 'Encryption');
  const skey = string(encryption.SecretKey, 'SecretKey');
  const encryptedUri = string(encryption.Uri, 'Encryption.Uri');
  if (!/^[a-f0-9]{64}$/i.test(skey) || encryption.Algorithm !== 'aes-256-gcm-chunks' || !/^tos-[a-z0-9-]+\/[a-z0-9/_-]+$/i.test(encryptedUri)) {
    throw new Error('File commit returned invalid encryption metadata');
  }
  deadline.remainingMs();
  // FileContent.md5 describes original bytes; upload SourceMd5 may describe the encrypted object.
  return { name: file.name, format: file.format, size: file.bytes.byteLength, md5: file.md5, uri: encryptedUri, skey };
}
