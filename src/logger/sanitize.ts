import { stripVTControlCharacters } from 'node:util';

const secretKeys = /^(?:.*token|.*password|.*secret|cookie|setcookie|authorization|proxyauthorization|passwd|sessionid|sessionidss|sessionkey|signingkey|signature|localstorage|storagestate|encryptuid|verifyticket|ticket|verificationcode|verifycode|smscode|tkey|abogus|xbogus)$/i;
const normalizeKey = (key: string) => key.replace(/[-_]/g, '');
export function sanitizeLogText(value: string, secrets: readonly string[] = []): string {
  let text = stripVTControlCharacters(value)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, '[redacted]')
    .replace(/\b(?:https?|wss?):\/\/[^\s/]+@/gi, prefix => prefix.slice(0, prefix.indexOf('://') + 3) + '[redacted]@')
    .replace(/((?:["']?)\b(?:[\w-]*token|[\w-]*password|secret|signing[_-]?key|signature|session[_-]?id(?:_ss)?|encrypt[_-]?uid|(?:verify[_-]?)?ticket|(?:sms|verify|verification)[_-]?code|tkey|a_bogus|x_bogus|cookie|set-cookie|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s&;,<>]+)/gi, '$1[redacted]')
    .replace(/((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/(?:data:[^;,\s]+;base64,|base64:\/\/)[A-Za-z0-9+/=]+/gi, '[二进制数据]');
  for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join('[redacted]');
  return text;
}
export function sanitizeLogValue(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (typeof value === 'string') {
    const clean = sanitizeLogText(value, secrets);
    return clean.length > 8192 ? clean.slice(0, 8192) + '…[已截断]' : clean;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[嵌套内容已省略]';
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeLogValue(item, secrets, depth + 1));
  if ('type' in value && value.type === 'Buffer') return '[二进制数据]';
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
    sanitizeLogText(key).replace(/[\r\n]/g, ' ').slice(0, 100),
    secretKeys.test(normalizeKey(key)) ? '[redacted]' : sanitizeLogValue(item, secrets, depth + 1),
  ]));
}
