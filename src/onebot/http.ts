import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { BrowserRuntime } from '../browser/chromium.js';
import type { AppConfig } from '../config/index.js';
import { decodeNetworkResponseBodies, extractRealtimeMessageCandidates } from '../douyin/protobuf.js';
import type { AppLogger } from '../logger/index.js';
import type { MediaRegistry } from '../media/registry.js';
import type { OneBotActionRouter } from './actions.js';
import type { OneBotActionRequest } from './types.js';

export interface HttpServerRuntime {
  server: FastifyInstance;
  stop(): Promise<void>;
}

export async function startOneBotHttpServer(
  config: AppConfig,
  logger: AppLogger,
  router: OneBotActionRouter,
  browser?: BrowserRuntime,
  mediaRegistry?: MediaRegistry
): Promise<HttpServerRuntime> {
  const server = Fastify();

  server.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/media/') && !isAuthorized(config, request)) {
      await reply.code(401).send({
        status: 'failed',
        retcode: 10001,
        data: null,
        message: 'Unauthorized'
      });
    }
  });

  server.get('/health', async () => ({
    ok: true,
    app: 'douyin-onebot'
  }));

  server.get('/media/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!mediaRegistry) {
      await reply.code(404).send({
        status: 'failed',
        message: 'Media registry is not attached'
      });
      return;
    }

    await mediaRegistry.serve(request, reply);
  });

  server.get('/_debug/page', async () => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    return {
      ok: true,
      page: await browser.inspect()
    };
  });

  server.post('/_debug/navigate', async (request: FastifyRequest<{ Body: { url?: string } }>) => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    if (!request.body.url) {
      return {
        ok: false,
        message: 'Missing url'
      };
    }

    return {
      ok: true,
      page: await browser.navigate(request.body.url)
    };
  });

  server.post('/_debug/click-text', async (request: FastifyRequest<{ Body: { text?: string } }>) => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    if (!request.body.text) {
      return {
        ok: false,
        message: 'Missing text'
      };
    }

    return {
      ok: true,
      page: await browser.clickText(request.body.text)
    };
  });

  server.get('/_debug/network', async () => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    return {
      ok: true,
      events: browser.listNetworkEvents()
    };
  });

  server.get('/_debug/network/decode', async () => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    return {
      ok: true,
      decoded: await decodeNetworkResponseBodies(browser.listNetworkEvents())
    };
  });

  server.get('/_debug/realtime-candidates', async () => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    return {
      ok: true,
      messages: await extractRealtimeMessageCandidates(browser.listNetworkEvents())
    };
  });

  server.post('/_debug/network/clear', async () => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    browser.clearNetworkEvents();
    return {
      ok: true
    };
  });

  server.post('/', async (request: FastifyRequest<{ Body: OneBotActionRequest }>) => {
    return router.handle(request.body);
  });

  server.post('/:action', async (request: FastifyRequest<{ Params: { action: string }; Body: Record<string, unknown> }>) => {
    return router.handle({
      action: request.params.action,
      params: request.body
    });
  });

  await server.listen({
    host: config.onebot.http.host,
    port: config.onebot.http.port
  });

  logger.info(
    {
      host: config.onebot.http.host,
      port: config.onebot.http.port
    },
    'onebot http server started'
  );

  return {
    server,
    async stop() {
      await server.close();
    }
  };
}

function isAuthorized(config: AppConfig, request: FastifyRequest): boolean {
  if (!config.onebot.accessToken) {
    return true;
  }

  const authorization = request.headers.authorization ?? '';
  const queryToken = typeof request.query === 'object' && request.query !== null ? (request.query as Record<string, unknown>).access_token : undefined;
  return authorization === `Bearer ${config.onebot.accessToken}` || queryToken === config.onebot.accessToken;
}
