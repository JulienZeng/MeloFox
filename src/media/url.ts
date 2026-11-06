import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/schema.js';

export function mediaBaseUrl(config: AppConfig): string {
  if (config.media.publicBaseUrl) return config.media.publicBaseUrl.replace(/\/$/, '');
  let host = ['0.0.0.0', '::'].includes(config.media.host) ? '127.0.0.1' : config.media.host;
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `http://${host}:${config.media.port}`;
}

function signature(id: string, key: string): string {
  return createHmac('sha256', key).update(`melofox-media:${id}`).digest('hex');
}

export function mediaUrl(config: AppConfig, id: string): string {
  const url = `${mediaBaseUrl(config)}/media/${id}`;
  // The signature is scoped to one cached resource; its lifetime is the cache lifetime.
  return id && config.media.signingKey ? `${url}?signature=${signature(id, config.media.signingKey)}` : url;
}

export function validMediaSignature(config: AppConfig, id: string, provided: unknown): boolean {
  if (!config.media.signingKey) return true;
  if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(signature(id, config.media.signingKey), 'hex'));
}
