interface ServiceHealth { instanceId: string; status: string }

export function isServiceHealth(value: unknown): value is ServiceHealth {
  return !!value && typeof value === 'object' &&
    typeof (value as ServiceHealth).instanceId === 'string' &&
    !!(value as ServiceHealth).instanceId &&
    ['ready', 'restarting'].includes((value as ServiceHealth).status);
}

/** A 200 from the draining process is not a completed restart. */
export async function waitForServiceRestart(previousId: string, signal: AbortSignal, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(2500, deadline - Date.now()));
    try {
      const response = await fetch('/healthz', { cache: 'no-store', signal: request.signal });
      const value: unknown = response.ok ? await response.json() : undefined;
      if (!signal.aborted && isServiceHealth(value) && value.instanceId !== previousId && value.status === 'ready') return;
    } catch { /* Closing and rebinding the listener temporarily interrupts requests. */ }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    if (!signal.aborted && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(pause); signal.removeEventListener('abort', done); resolve(); };
        const pause = setTimeout(done, Math.min(1000, deadline - Date.now()));
        signal.addEventListener('abort', done, { once: true });
      });
    }
  }
  if (signal.aborted) throw new Error('已取消等待');
  throw new Error('尚未检测到服务恢复，请查看终端或容器日志；可以继续等待连接。');
}
