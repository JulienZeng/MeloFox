import { createDecipheriv, createHash } from 'node:crypto';

export interface FilePayload {
  name: string;
  size: number;
  md5: string;
  keyHex?: string;
}

export function decodeDouyinFile(bytes: Buffer, file: FilePayload): Buffer {
  const valid = (value: Buffer): boolean => value.length === file.size &&
    createHash('md5').update(value).digest('hex') === file.md5.toLowerCase();
  if (valid(bytes)) return bytes;
  if (!file.keyHex || !/^[a-f0-9]{64}$/i.test(file.keyHex) || bytes.length <= 28) {
    throw new Error('File size/checksum mismatch; no valid decryption key');
  }
  const decrypt = (chunk: Buffer): Buffer => {
    if (chunk.length <= 28) throw new Error('Encrypted file chunk is truncated');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(file.keyHex!, 'hex'), chunk.subarray(0, 12));
    decipher.setAuthTag(chunk.subarray(-16));
    return Buffer.concat([decipher.update(chunk.subarray(12, -16)), decipher.final()]);
  };
  let plain: Buffer;
  if (bytes.subarray(0, 16).toString('ascii') === 'aes256gcm-chunks') {
    // Android file format: 256-byte header, LE plaintext chunk size at offset 24,
    // then independently authenticated IV/ciphertext/tag chunks (12 + size + 16).
    if (bytes.length < 256) throw new Error('Encrypted file header is truncated');
    const size = bytes.readBigUInt64LE(24);
    if (size < 1n || size > 2147483619n) throw new Error('Invalid encrypted file chunk size');
    const chunkBytes = Number(size) + 28;
    const parts: Buffer[] = [];
    let decodedSize = 0;
    for (let offset = 256; offset < bytes.length; offset += chunkBytes) {
      const part = decrypt(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)));
      decodedSize += part.length;
      if (decodedSize > file.size) throw new Error('Decrypted file exceeds declared size');
      parts.push(part);
    }
    plain = Buffer.concat(parts, decodedSize);
  } else plain = decrypt(bytes);
  if (!valid(plain)) throw new Error('Decrypted file size/checksum mismatch');
  return plain;
}
