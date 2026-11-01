import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Loaded only by the development entry point; production needs no Vite dependency. */
export async function registerConsoleDevAssets(
  server: FastifyInstance,
  root = join(projectRoot, 'web')
): Promise<string> {
  root = await realpath(root);
  const nonce = randomBytes(24).toString('base64');
  const vite = await createServer({
    configFile: join(projectRoot, 'web/vite.config.ts'),
    root,
    appType: 'custom',
    html: { cspNonce: nonce },
    server: {
      middlewareMode: true,
      hmr: { server: server.server, path: '/__vite_hmr' },
      // The workspace also contains login credentials and persistent gateway data.
      fs: { allow: [root, join(projectRoot, 'node_modules')] }
    }
  });
  try {
    // Close upgraded HMR sockets before Fastify waits for the HTTP server to close.
    server.addHook('preClose', async () => { await vite.close(); });
    server.addHook('onRequest', async (request, reply) => {
      if (!['GET', 'HEAD'].includes(request.method) || request.url.startsWith('/api/')) return;
      // Vite writes to the raw response, so copy Fastify's security headers first.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          reply.raw.off('finish', finished);
          reply.raw.off('close', finished);
        };
        const finished = () => {
          cleanup();
          reply.hijack();
          resolve();
        };
        reply.raw.once('finish', finished);
        reply.raw.once('close', finished);
        vite.middlewares(request.raw, reply.raw, (error?: unknown) => {
          cleanup();
          if (error) reject(error);
          else resolve();
        });
      });
    });
    server.get('/', async (request, reply) => {
      const html = await readFile(join(root, 'index.html'), 'utf8');
      return reply.type('text/html; charset=utf-8').send(await vite.transformIndexHtml(request.url, html));
    });
  } catch (error) {
    await vite.close();
    throw error;
  }
  return nonce;
}
