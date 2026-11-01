import type { MediaDownloadOptions, OutgoingMediaCache } from '../media/outgoing.js';
import { z } from 'zod';
import type { Page } from 'playwright';
import { imageFormat } from '../media/image.js';
import { ActionDeadline } from '../runtime/deadline.js';
import { loadOutgoingFile } from './file-upload.js';
import { validateStickerImage } from './sticker.js';
import { uploadResource } from './video-upload.js';
import type { DouyinUploadedImage } from './send-protocol.js';
import type { UploadCredentials } from './upload-signing.js';

export interface LoadedImageData { base64: string; mimeType: string; name: string }

export async function loadImageData(file: string, signal = AbortSignal.timeout(15000),
  maxBytes = 128 * 1024 * 1024, allowedDirs: string[] = [], options: MediaDownloadOptions = {}, cache?: OutgoingMediaCache): Promise<LoadedImageData> {
  const data = file.match(/^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i);
  const loaded = await loadOutgoingFile({ file: data ? `base64://${data[1]}` : file, name: 'onebot-image' }, maxBytes, signal, allowedDirs, options, cache);
  const format = imageFormat(loaded.bytes);
  if (!format || format.transcode) throw new Error('Image source must be a PNG, JPEG, GIF or WebP image');
  return { base64: loaded.bytes.toString('base64'), mimeType: format.contentType, name: `onebot-image${format.extension}` };
}

const token = z.string().min(1).max(16384).refine(value => !/[\x00-\x20\x7f]/.test(value));
const credentialsSchema = z.object({ access_key_id: token, secret_access_key: token, session_token: token,
  space_name: token, expire_at: z.number().positive().optional() });
export function imageUploadCredentials(value: unknown): UploadCredentials {
  const root = z.object({ status_code: z.literal(0).optional(), public_image_config: credentialsSchema.optional(),
    public_image_config_v2: credentialsSchema.optional() }).parse(value);
  const c = root.public_image_config ?? root.public_image_config_v2;
  if (!c) throw new Error('Image upload credentials missing');
  if (c.expire_at && c.expire_at * (c.expire_at > 1e11 ? 1 : 1000) <= Date.now()) throw new Error('Image upload credentials expired');
  return { accessKeyId: c.access_key_id, secretAccessKey: c.secret_access_key, sessionToken: c.session_token, spaceName: c.space_name };
}

export async function uploadOutgoingImage(image: LoadedImageData, config: unknown, deadline: ActionDeadline): Promise<DouyinUploadedImage> {
  const bytes = Buffer.from(image.base64, 'base64');
  const animated = image.mimeType === 'image/gif';
  const result = await uploadResource(bytes, 'image', imageUploadCredentials(config), [{ name: 'Encryption', input: {
    Config: { copies: 'cipher_v2' }, PolicyParams: animated ?
      { 'policy-set': 'still', 'still-width': '480', 'still-height': '480' } : { 'policy-set': 'check,thumb,medium,large' }
  } }], deadline, true);
  const e = result.Encryption, extra = e?.Extra;
  const metadata = z.object({ oid: token, skey: z.string().regex(/^[a-f0-9]{64}$/i), md5: z.string().regex(/^[a-f0-9]{32}$/i),
    size: z.number().int().positive(), width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384) })
    .parse({ oid: e?.Uri, skey: e?.SecretKey, md5: e?.SourceMd5, size: Number(extra?.img_size ?? bytes.length),
      width: Number(extra?.img_width), height: Number(extra?.img_height) });
  return { ...metadata, animated };
}

export async function validateOutgoingImage(page: Page, image: LoadedImageData, signal: AbortSignal): Promise<void> {
  const bytes = Buffer.from(image.base64, 'base64'), format = imageFormat(bytes);
  if (!format || format.transcode) throw new Error('Unsupported image format');
  await validateStickerImage(page, bytes, format, signal);
}
