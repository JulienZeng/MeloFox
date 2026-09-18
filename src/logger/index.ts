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
    redact: {
      paths: redactPaths,
      censor: '[redacted]'
    },
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard'
            }
          }
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
