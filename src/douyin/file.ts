import type { MediaRegistry } from '../media/registry.js';
import type { FilePayload } from '../media/file.js';
import type { RealtimeMessageCandidate } from './protobuf.js';
import type { DouyinFileResource } from './file-url.js';

export interface DouyinFile extends FilePayload {
  uri: string;
  extension: string;
  contentType: string;
}

export function parseDouyinFile(content: string | undefined): DouyinFile {
  let value: Record<string, unknown>;
  try { value = JSON.parse(content ?? '') as Record<string, unknown>; }
  catch { throw new Error('File message has invalid content'); }
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() ||
      value.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(value.name) ||
      typeof value.data_size !== 'number' || !Number.isSafeInteger(value.data_size) || value.data_size < 0 ||
      typeof value.md5 !== 'string' || !/^[a-f0-9]{32}$/i.test(value.md5) ||
      typeof value.uri !== 'string' || !/^tos-[a-z0-9-]+\/[a-zA-Z0-9/_-]+$/.test(value.uri) ||
      value.skey !== undefined && (typeof value.skey !== 'string' || !/^[a-f0-9]{64}$/i.test(value.skey))) {
    throw new Error('File message has invalid resource metadata');
  }
  const extension = typeof value.format === 'string' && /^[a-z0-9]{1,10}$/i.test(value.format)
    ? value.format.toLowerCase() : value.name.match(/\.([a-z0-9]{1,10})$/i)?.[1].toLowerCase() ?? 'bin';
  const contentTypes: Record<string, string> = {
    doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', zip: 'application/zip'
  };
  return { name: value.name, size: value.data_size, md5: value.md5.toLowerCase(), uri: value.uri,
    keyHex: value.skey as string | undefined, extension, contentType: contentTypes[extension] ?? 'application/octet-stream' };
}

export async function enrichRealtimeFile(
  registry: MediaRegistry, candidate: RealtimeMessageCandidate, signal: AbortSignal,
  resolveUrl: (resource: DouyinFileResource) => Promise<string>
): Promise<RealtimeMessageCandidate> {
  const file = parseDouyinFile(candidate.content);
  registry.assertFileSize(file.size);
  signal.throwIfAborted();
  const url = await resolveUrl({ uri: file.uri, conversationShortId: candidate.conversationShortId ?? '',
    messageId: candidate.serverMessageId ?? '' });
  signal.throwIfAborted();
  const mediaUrl = await registry.cacheRemote(url, file.contentType, file.extension, { filePayload: file, signal });
  return { ...candidate, mediaUrl, mediaUnavailable: false };
}
