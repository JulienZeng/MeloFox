export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}
export class StaleRequestError extends Error {}
export const isCancelled = (error: unknown) =>
  error instanceof StaleRequestError;
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败，请稍后重试";

export function createApi(
  onUnauthorized: () => void,
  fetcher: typeof fetch = fetch,
) {
  let generation = 0;
  const controllers = new Set<AbortController>();
  return {
    reset() {
      generation++;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
    async request<T = { ok: boolean }>(
      path: string,
      options: RequestInit = {},
    ): Promise<T> {
      const started = generation;
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const headers = new Headers(options.headers);
        if (
          typeof options.body === "string" &&
          options.body.length &&
          !headers.has("Content-Type")
        )
          headers.set("Content-Type", "application/json");
        const response = await fetcher(path, {
          ...options,
          headers,
          signal: controller.signal,
        });
        const body = await response.json();
        // Check before processing even a 401: an old session must not log out a new one.
        if (started !== generation) throw new StaleRequestError();
        if (!response.ok) {
          if (response.status === 401 && path !== "/api/auth/login")
            onUnauthorized();
          throw new ApiError(
            body.message || "请求失败，请稍后重试",
            response.status,
            body.code,
          );
        }
        return body as T;
      } catch (error) {
        if (started !== generation) throw new StaleRequestError();
        if (controller.signal.aborted)
          throw new Error("请求超时，请检查服务连接后重试");
        throw error;
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
    },
  };
}
