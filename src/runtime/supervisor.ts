import { setTimeout as delay } from 'node:timers/promises';

export interface ManagedSession {
  stop(): Promise<void>;
}

export class SessionCleanupError extends AggregateError {}

export async function superviseSessions(options: {
  signal: AbortSignal;
  retryMs: number;
  start(recover: (reason: string) => void): Promise<ManagedSession>;
  onRetry(reason: unknown): void;
}): Promise<void> {
  while (!options.signal.aborted) {
    let session: ManagedSession | undefined;
    let recover!: (reason: string) => void;
    const failure = new Promise<string>(resolve => { recover = resolve; });
    let stop!: () => void;
    const shutdown = new Promise<void>(resolve => {
      stop = resolve;
      options.signal.addEventListener('abort', stop, { once: true });
      if (options.signal.aborted) stop();
    });
    let reason: unknown;
    try {
      session = await options.start(recover);
      reason = await Promise.race([failure, shutdown]);
    } catch (error) {
      if (error instanceof SessionCleanupError) throw error;
      reason = error;
    } finally {
      options.signal.removeEventListener('abort', stop);
      // A failed teardown must not overlap a new browser/profile or listening socket.
      await session?.stop();
    }
    if (options.signal.aborted) break;
    options.onRetry(reason);
    await delay(options.retryMs, undefined, { signal: options.signal }).catch(error => {
      if (!options.signal.aborted) throw error;
    });
  }
}
