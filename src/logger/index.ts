import pino, { type Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { LogBuffer } from './buffer.js';
import { formatLogEntry, logLevels, type LogEntry } from './contracts.js';
import { sanitizeLogValue } from './sanitize.js';

const buffers = new WeakMap<Logger, LogBuffer>();
const pad = (value: number, width = 2) => String(value).padStart(width, '0');
function timestamp(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
const colors = { trace: 90, debug: 36, info: 32, warn: 33, error: 31, fatal: 35 };
const detailLabels: Record<string, string> = { messageId: '消息ID', conversationShortId: '会话ID', conversationId: '会话',
  senderId: '发送者', accountId: '账号', retryMs: '重试间隔(ms)', attempts: '尝试次数', endpoint: '地址', url: '地址',
  messages: '消息数', recalls: '撤回数', channel: '通道', retcode: '返回码' };
function details(fields: Record<string, unknown>): string | undefined {
  const lines = Object.entries(fields).map(([key, value]) => {
    if (value && typeof value === 'object' && ('stack' in value || 'message' in value)) {
      const error = value as { stack?: unknown; message?: unknown; code?: unknown };
      return `${key}${error.code ? ` (${error.code})` : ''}: ${error.stack || error.message}`;
    }
    return `${detailLabels[key] ?? key}=${typeof value === 'string' ? value.replace(/[\r\n]/g, ' ↵ ') : JSON.stringify(value)}`;
  }).join('\n');
  return lines ? lines.slice(0, 12000) + (lines.length > 12000 ? '\n…[已截断]' : '') : undefined;
}

export function createLogger(config: AppConfig, output: { write(text: string): unknown; isTTY?: boolean } = process.stdout): Logger {
  const buffer = new LogBuffer();
  const secrets = [config.web.token, config.onebot.accessToken, config.onebot.reverseHttp.secret].filter(Boolean);
  const logger = pino({
    level: config.app.logLevel,
    base: { scope: 'MeloFox' },
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  }, {
    write(line: string) {
      // Serialize errors first, then redact recursively before any destination sees the record.
      const record = sanitizeLogValue(JSON.parse(line), secrets) as Record<string, unknown>;
      const { level, time, scope, msg, pid: _pid, hostname: _hostname, ...fields } = record;
      const entry: LogEntry = buffer.append({
        time: timestamp(Number(time)),
        level: logLevels[Math.max(0, Math.min(5, Number(level) / 10 - 1))] ?? 'info',
        scope: String(scope ?? 'MeloFox').replace(/[\r\n]/g, ' ').slice(0, 80),
        message: String(msg ?? '').replace(/[\r\n]/g, ' ↵ ').slice(0, 4096),
        details: details(fields),
      });
      if (config.app.logFormat === 'json') output.write(JSON.stringify(record) + '\n');
      else {
        const text = formatLogEntry(entry);
        output.write((output.isTTY ? text.replace(`[${entry.level.toUpperCase()}]`, `\x1b[${colors[entry.level]}m[${entry.level.toUpperCase()}]\x1b[0m`) : text) + '\n');
      }
    },
  });
  buffers.set(logger, buffer);
  return logger;
}
export type AppLogger = Logger;
export function loggerBuffer(logger: AppLogger): LogBuffer {
  let buffer = buffers.get(logger);
  if (!buffer) { buffer = new LogBuffer(); buffers.set(logger, buffer); }
  return buffer;
}
export function scopedLogger(logger: AppLogger, scope: string, fields: Record<string, unknown> = {}): AppLogger {
  // Lightweight loggers used by embedders and offline tests may not implement child().
  if (!logger.child) return logger;
  const child = logger.child({ scope, ...fields });
  buffers.set(child, loggerBuffer(logger));
  return child;
}
