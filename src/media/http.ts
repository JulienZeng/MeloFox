import Fastify from 'fastify';
import type { AppConfig } from '../config/schema.js';
import { scopedLogger, type AppLogger } from '../logger/index.js';
import type { MediaRegistry } from './registry.js';
import { mediaBaseUrl, validMediaSignature } from './url.js';

/** Owns only media routes; no OneBot actions or console sessions are attached. */
export function createMediaHttpServer(config: AppConfig, registry: MediaRegistry) {
  const server = Fastify();
  server.get('/health', async () => ({ ok: true, service: 'media' }));
  server.get<{ Params: { id: string }; Querystring: { signature?: string } }>('/media/:id', async (request, reply) => {
    if (!validMediaSignature(config, request.params.id, request.query.signature))
      return reply.code(403).send({ message: '媒体下载签名无效' });
    await registry.serve(request, reply);
  });
  return server;
}

export async function startMediaHttpServer(config: AppConfig, registry: MediaRegistry, logger: AppLogger) {
  if (!config.media.enabled) return undefined;
  const server = createMediaHttpServer(config, registry);
  try { await server.listen({ host: config.media.host, port: config.media.port }); }
  catch (error) { await server.close(); throw error; }
  scopedLogger(logger, '媒体服务').info({ host: config.media.host, port: config.media.port, publicUrl: mediaBaseUrl(config),
    signed: Boolean(config.media.signingKey) }, '独立媒体下载服务已启动');
  return server;
}
