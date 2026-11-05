import pino from 'pino';
import type { AppConfig } from '../config/index.js';

const redactPaths = [
  'cookie',
  '*.cookie',
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'accessToken',
  '*.accessToken',
  'localStorage',
  '*.localStorage'
];

export function createLogger(config: AppConfig) {
  return pino({
    level: config.app.logLevel,
    // Most call sites use { error }; Pino only serializes { err } by default.
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
    redact: {
      paths: redactPaths,
      censor: '[redacted]'
    },
    transport:
      config.app.logFormat === 'json'
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: Boolean(process.stdout.isTTY),
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname'
            }
          }
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
