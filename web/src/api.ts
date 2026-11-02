export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number | string,
  ) {
    super(message);
  }
}
export class StaleRequestError extends Error {}
export const isCancelled = (error: unknown) =>
  error instanceof StaleRequestError;
const isChineseMessage = (message: unknown): message is string =>
  typeof message === "string" && /\p{Script=Han}/u.test(message);
export const errorMessage = (error: unknown) =>
  error instanceof Error && isChineseMessage(error.message)
    ? error.message : "请求失败，请稍后重试";

function httpErrorMessage(status: number, path: string): string {
  if (status === 401)
    return path === "/api/auth/login" ? "账号或密码不正确" : "登录已失效，请重新登录";
  const messages: Record<number, string> = {
    400: "请求参数有误，请检查输入内容",
    403: "无法执行此操作，请刷新页面或重新登录",
    404: "管理接口不可用，请重启服务并刷新页面",
    409: "操作发生冲突，请刷新页面后重试",
    413: "提交的内容过长，请减少输入",
    415: "请求格式不正确，请刷新页面重试",
    429: "尝试过于频繁，请稍后重试",
  };
  return messages[status] || (status >= 500
    ? "服务暂时不可用，请稍后重试" : `请求失败（HTTP ${status}），请稍后重试`);
}

export function createApi(
  onUnauthorized: () => void,
  fetcher: typeof fetch = fetch,
  onPasswordChangeRequired?: () => void,
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
        let response: Response;
        try {
          response = await fetcher(path, { ...options, headers, signal: controller.signal });
        } catch {
          throw new Error("无法连接管理服务，请检查网络或服务状态");
        }
        // Proxies and older services may return HTML or an English framework error.
        // Never render JSON parser errors or raw response bodies in the login form.
        let body: { message?: unknown; code?: number | string } | undefined;
        try { body = await response.json(); } catch { /* Use the localized HTTP fallback below. */ }
        // Check before processing even a 401: an old session must not log out a new one.
        if (started !== generation) throw new StaleRequestError();
        if (!response.ok) {
          if (response.status === 401 && path !== "/api/auth/login")
            onUnauthorized();
          if (response.status === 403 && body?.code === "PASSWORD_CHANGE_REQUIRED")
            onPasswordChangeRequired?.();
          throw new ApiError(
            isChineseMessage(body?.message) ? body.message : httpErrorMessage(response.status, path),
            response.status,
            body?.code,
          );
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new ApiError("管理服务返回了无效响应，请刷新页面重试", response.status);
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
