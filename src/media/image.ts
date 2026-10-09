import { createDecipheriv } from 'node:crypto';

export interface ImageFormat {
  contentType: string;
  extension: string;
  transcode?: boolean;
}

export function imageFormat(bytes: Buffer): ImageFormat | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { contentType: 'image/png', extension: '.png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { contentType: 'image/jpeg', extension: '.jpg' };
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return { contentType: 'image/gif', extension: '.gif' };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { contentType: 'image/webp', extension: '.webp' };
  if (bytes.length >= 16 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/.test(bytes.subarray(8, 12).toString('ascii'))) {
    return { contentType: 'image/png', extension: '.png', transcode: true };
  }
  return undefined;
}

export function decodeDouyinImage(bytes: Buffer, keyHex?: string): Buffer {
  if (imageFormat(bytes)) return bytes;
  if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('Encrypted image requires a valid 256-bit key');
  if (bytes.length <= 28) throw new Error('Encrypted image is truncated');
  // Official Web crypto layout: 12-byte IV, ciphertext, 16-byte GCM authentication tag.
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const plain = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  if (!imageFormat(plain)) throw new Error('Decrypted data is not a supported image');
  return plain;
}
