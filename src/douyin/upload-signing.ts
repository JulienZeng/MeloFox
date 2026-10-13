import { createHash, createHmac } from 'node:crypto';

export interface UploadCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  spaceName: string;
}

export function signVodRequest(
  method: 'GET' | 'POST',
  url: URL,
  body: Buffer,
  credentials: UploadCredentials
): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const baseHeaders: Record<string, string> = {
    'x-amz-date': amzDate,
    'x-amz-security-token': credentials.sessionToken
  };
  if (method === 'POST') {
    baseHeaders['x-amz-content-sha256'] = payloadHash;
  }

  const signedHeaderNames = Object.keys(baseHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map(key => `${key}:${baseHeaders[key].trim()}\n`).join('');
  const canonicalRequest = [
    method,
    url.pathname || '/',
    canonicalQueryString(url.searchParams),
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash
  ].join('\n');
  const credentialScope = `${date}/cn-north-1/vod/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8'))
  ].join('\n');

  const signingKey = hmac(
    hmac(
      hmac(hmac(Buffer.from(`AWS4${credentials.secretAccessKey}`, 'utf8'), date), 'cn-north-1'),
      'vod'
    ),
    'aws4_request'
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    ...baseHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`
  };
}

function hmac(key: Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalQueryString(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      }
      return leftKey < rightKey ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function crc32Hex(buffer: Buffer): string {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

const CRC32_TABLE = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();
