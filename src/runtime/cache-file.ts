import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const MAX_CACHE_INDEX_BYTES = 64 * 1024 * 1024;

export async function readCacheJson(path: string): Promise<unknown | undefined> {
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile()) throw new Error('Cache index is not a regular file');
  if (info.size > MAX_CACHE_INDEX_BYTES) throw new Error('Cache index exceeds size limit');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function cleanupCacheTemps(path: string): Promise<void> {
  const entries = await readdir(dirname(path), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const prefix = `${basename(path)}.`;
  for (const entry of entries) {
    if (!entry.isDirectory() && entry.name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/.test(entry.name.slice(prefix.length))) {
      await rm(join(dirname(path), entry.name), { force: true });
    }
  }
}

export async function writeCacheJson(path: string, json: string): Promise<void> {
  if (Buffer.byteLength(json) > MAX_CACHE_INDEX_BYTES) throw new Error('Cache index exceeds size limit');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(json);
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
