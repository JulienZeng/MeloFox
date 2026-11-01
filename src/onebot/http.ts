import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { BrowserRuntime } from '../browser/chromium.js';
import type { DouyinBridge } from '../douyin/bridge.js';
import type { AppConfig } from '../config/index.js';
import { decodeNetworkResponseBodies, extractRealtimeMessageCandidates } from '../douyin/protobuf.js';
import type { AppLogger } from '../logger/index.js';
import type { RealtimeMessageProcessor } from '../douyin/realtime.js';
import type { MediaRegistry } from '../media/registry.js';
import type { OneBotActionRouter } from './actions.js';
import type { OneBotActionRequest } from './types.js';
import { parseOneBotJson, stringifyOneBotJson } from './json.js';

export interface HttpServerRuntime {
  server: FastifyInstance;
  stop(): Promise<void>;
}

export async function startOneBotHttpServer(
  config: AppConfig,
  logger: AppLogger,
  router: OneBotActionRouter,
  browser?: BrowserRuntime,
  mediaRegistry?: MediaRegistry,
  realtime?: RealtimeMessageProcessor,
  bridge?: DouyinBridge
): Promise<HttpServerRuntime> {
  const server = Fastify();
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, parseOneBotJson(String(body)));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      done(Object.assign(failure, { statusCode: 400 }), undefined);
    }
  });
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(String(body)))); }
    catch (error) { done(Object.assign(new Error('Invalid form body', { cause: error }), { statusCode: 400 })); }
  });

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

  server.get('/_debug/realtime', async () => ({
    ok: Boolean(realtime),
    realtime: realtime?.getStats()
  }));

  server.get('/_debug/cache', async () => ({
    messages: bridge?.getCacheStats(),
    media: await mediaRegistry?.getStats()
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

  server.get('/_debug/dom', async () => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    return {
      ok: true,
      dom: await browser.inspectDom()
    };
  });

  server.get('/_debug/messages', async () => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    return {
      ok: true,
      dom: await browser.inspectMessages()
    };
  });

  server.post('/_debug/reply-message-text', async (request: FastifyRequest<{ Body: { text?: string; reply?: string } }>) => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    if (!request.body.text || !request.body.reply) {
      return {
        ok: false,
        message: 'Missing text or reply'
      };
    }

    return {
      ok: true,
      result: await browser.replyToMessageText(request.body.text, request.body.reply)
    };
  });

  server.post('/_debug/message-controls', async (request: FastifyRequest<{ Body: { text?: string } }>) => {
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
      result: await browser.inspectMessageControls(request.body.text)
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

  server.post('/_debug/send-image-dom', async (request: FastifyRequest<{ Body: { file?: string } }>) => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    if (!request.body.file) {
      return {
        ok: false,
        message: 'Missing file'
      };
    }

    return {
      ok: true,
      result: await browser.sendImageFromFile(request.body.file)
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

  server.get('/_debug/network/set-property', async () => {
    if (!browser) {
      return {
        ok: false,
        message: 'Browser runtime is not attached'
      };
    }

    return {
      ok: true,
      events: browser.listSetPropertyNetworkEvents()
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

  server.post('/', async (request: FastifyRequest<{ Body: OneBotActionRequest }>, reply) => {
    return reply.serializer(stringifyOneBotJson).send(await router.handle(request.body));
  });

  server.post('/:action', async (request: FastifyRequest<{ Params: { action: string }; Body: Record<string, unknown> }>, reply) => {
    return reply.serializer(stringifyOneBotJson).send(await router.handle({
      action: request.params.action,
      params: normalizeHttpParams({ ...(request.query as object), ...request.body })
    }));
  });
  server.get('/:action', async (request: FastifyRequest<{ Params: { action: string }; Querystring: Record<string, unknown> }>, reply) => {
    return reply.serializer(stringifyOneBotJson).send(await router.handle({ action: request.params.action, params: normalizeHttpParams(request.query) }));
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

export function normalizeHttpParams(params: Record<string, unknown>): Record<string, unknown> {
  const result = { ...params };
  delete result.access_token;
  for (const key of ['auto_escape', 'no_cache', 'is_add', 'set', 'reverse_order', 'reverseOrder', 'disable_get_url', 'parse_mult_msg', 'quick_reply', 'reject_add_request', 'is_dismiss', 'enable', 'approve']) {
    if (result[key] === 'true') result[key] = true;
    else if (result[key] === 'false') result[key] = false;
  }
  if (typeof result.message === 'string' && result.message.trim().startsWith('[')) {
    try { const message = parseOneBotJson(result.message); if (Array.isArray(message)) result.message = message; } catch { /* Plain text / CQ remains text. */ }
  }
  return result;
}

function isAuthorized(config: AppConfig, request: FastifyRequest): boolean {
  if (!config.onebot.accessToken) {
    return true;
  }

  const authorization = request.headers.authorization ?? '';
  const queryToken = typeof request.query === 'object' && request.query !== null ? (request.query as Record<string, unknown>).access_token : undefined;
  return authorization === `Bearer ${config.onebot.accessToken}` || queryToken === config.onebot.accessToken;
}
