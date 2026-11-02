import { inject, reactive, type InjectionKey } from "vue";
import { ApiError, createApi, errorMessage, isCancelled } from "./api";
import type {
  ChannelInput,
  ConsoleChannel,
  ConsoleLogin,
  ConsoleStatus,
  ConsoleAuthSession,
} from "./types";

export function channelInput(channel: ConsoleChannel): ChannelInput {
  const { id: _id, status: _status, ...input } = channel;
  return input;
}
export function createConsole() {
  const state = reactive({
    ready: false,
    authenticated: false,
    auth: undefined as ConsoleAuthSession | undefined,
    authBusy: false,
    refreshBusy: false,
    data: undefined as ConsoleStatus | undefined,
    connectionError: "",
    lastUpdated: 0,
    login: undefined as ConsoleLogin | undefined,
    loginBusy: false,
    loginError: "",
    pollStopped: false,
    editor: undefined as { id?: string; initial?: ChannelInput } | undefined,
    deleting: undefined as ConsoleChannel | undefined,
    assist: false,
    pendingChannels: new Set<string>(),
    toast: undefined as { message: string; error: boolean } | undefined,
  });
  let refreshId = 0,
    loginVersion = 0;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const api = createApi(invalidate, fetch, requirePasswordChange);
  function requirePasswordChange() {
    api.reset();
    refreshId++;
    loginVersion++;
    state.authenticated = true;
    state.auth = { username: state.auth?.username || "melofox", mustChangePassword: true };
    state.data = undefined;
    state.login = undefined;
    state.refreshBusy = false;
    state.loginBusy = false;
    closeDialogs();
  }
  function closeDialogs() {
    state.editor = undefined;
    state.deleting = undefined;
    state.assist = false;
  }
  function invalidate() {
    api.reset();
    refreshId++;
    loginVersion++;
    state.authenticated = false;
    state.auth = undefined;
    state.data = undefined;
    state.login = undefined;
    state.refreshBusy = false;
    state.loginBusy = false;
    state.pollStopped = false;
    state.connectionError = "";
    state.loginError = "";
    state.lastUpdated = 0;
    state.pendingChannels.clear();
    state.toast = undefined;
    clearTimeout(toastTimer);
    closeDialogs();
  }
  function toast(message: string, error = false) {
    state.toast = { message, error };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      state.toast = undefined;
    }, 4000);
  }
  async function refresh() {
    if (!state.authenticated || state.auth?.mustChangePassword) return false;
    const id = ++refreshId,
      loginAtStart = loginVersion;
    state.refreshBusy = true;
    try {
      const data = await api.request<ConsoleStatus>("/api/status");
      if (id !== refreshId) return false;
      state.data = data;
      state.authenticated = true;
      state.connectionError = "";
      state.lastUpdated = Date.now();
      // A poll started before a QR/SMS/logout action may contain an older attempt.
      if (loginAtStart === loginVersion && !state.loginBusy) {
        if (state.login?.id !== data.login?.id) {
          state.pollStopped = false;
          state.loginError = "";
        }
        state.login = data.login;
      }
      return true;
    } catch (error) {
      if (id === refreshId && !isCancelled(error) && state.authenticated && !state.auth?.mustChangePassword)
        state.connectionError = `管理服务连接中断：${errorMessage(error)}。显示的是上次获取的数据。`;
      return false;
    } finally {
      if (id === refreshId) {
        state.refreshBusy = false;
        state.ready = true;
      }
    }
  }
  async function restoreSession() {
    try {
      state.auth = await api.request<ConsoleAuthSession>("/api/auth/session");
      state.authenticated = true;
      if (!state.auth.mustChangePassword) await refresh();
    } catch (error) {
      if (!isCancelled(error) && !(error instanceof ApiError && error.status === 401))
        state.connectionError = errorMessage(error);
    } finally { state.ready = true; }
  }
  async function authenticate(username: string, password: string) {
    if (state.authBusy) return;
    state.authBusy = true;
    invalidate();
    try {
      state.auth = await api.request<ConsoleAuthSession>("/api/auth/login", {
        method: "POST", body: JSON.stringify({ username, password }),
      });
      state.authenticated = true;
      if (!state.auth.mustChangePassword && !(await refresh()))
        throw new Error(state.connectionError || "无法读取管理状态，请重试");
    } finally {
      state.authBusy = false;
      state.ready = true;
    }
  }
  async function updateCredentials(input: { username?: string; currentPassword?: string; newPassword: string; confirmPassword: string }) {
    if (state.authBusy) return;
    state.authBusy = true;
    try {
      const auth = await api.request<ConsoleAuthSession>("/api/auth/credentials", {
        method: "POST", body: JSON.stringify(input),
      });
      // The server rotates this cookie and revokes every other session.
      api.reset(); refreshId++; loginVersion++;
      state.auth = auth;
      state.authenticated = true;
      state.refreshBusy = false;
      state.loginBusy = false;
      closeDialogs();
      await refresh();
      toast("管理账号已更新，其他会话已退出");
    } finally { state.authBusy = false; }
  }
  async function logout() {
    if (state.authBusy) return;
    state.authBusy = true;
    invalidate();
    state.ready = true;
    try {
      await api.request("/api/auth/logout", { method: "POST" });
    } catch (error) {
      if (!isCancelled(error))
        toast(`退出请求未确认：${errorMessage(error)}`, true);
    } finally {
      state.authBusy = false;
    }
  }
  async function loginAction(path: string, method = "POST", body?: object) {
    if (state.loginBusy || !state.authenticated) return;
    state.loginBusy = true;
    state.loginError = "";
    const version = ++loginVersion;
    try {
      state.login = await api.request<ConsoleLogin>(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      state.pollStopped = false;
      if (state.login.state === "saved") {
        toast(state.login.message);
        await refresh();
      }
    } catch (error) {
      if (!isCancelled(error)) {
        state.loginError = errorMessage(error);
        if (
          error instanceof ApiError &&
          (error.code || [404, 410].includes(error.status))
        )
          state.pollStopped = true;
      }
    } finally {
      // Any status request concurrent with this action must not overwrite its result.
      if (version === loginVersion) {
        loginVersion++;
        state.loginBusy = false;
      }
    }
  }
  async function pollLogin(manual = false) {
    if (
      !state.login ||
      state.loginBusy ||
      !state.authenticated ||
      (!manual && state.pollStopped) ||
      !["waiting", "scanned", "confirmed"].includes(state.login.state)
    )
      return;
    await loginAction(`/api/douyin/login/${state.login.id}`, "GET");
  }
  async function loginStep(step: string, body?: object) {
    if (state.login)
      await loginAction(
        `/api/douyin/login/${state.login.id}/${step}`,
        "POST",
        body,
      );
  }
  async function logoutDouyin() {
    if (state.loginBusy) return;
    state.loginBusy = true;
    const version = ++loginVersion;
    try {
      await api.request("/api/douyin/logout", { method: "POST" });
      state.login = undefined;
      state.loginError = "";
      state.pollStopped = true;
      toast("已清除抖音登录状态");
      await refresh();
    } catch (error) {
      if (!isCancelled(error)) toast(errorMessage(error), true);
    } finally {
      if (version === loginVersion) {
        loginVersion++;
        state.loginBusy = false;
      }
    }
  }
  async function toggleChannel(channel: ConsoleChannel) {
    if (state.pendingChannels.has(channel.id)) return;
    state.pendingChannels.add(channel.id);
    try {
      await api.request(`/api/channels/${channel.id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...channelInput(channel),
          enabled: !channel.enabled,
        }),
      });
      await refresh();
      toast(channel.enabled ? "通道已停用" : "通道已启用");
    } catch (error) {
      if (!isCancelled(error)) toast(errorMessage(error), true);
    } finally {
      state.pendingChannels.delete(channel.id);
    }
  }
  function openChannel(channel?: ConsoleChannel) {
    state.editor = channel
      ? { id: channel.id, initial: channelInput(channel) }
      : {};
  }
  function start(isAccountView: () => boolean) {
    void restoreSession();
    const statusTimer = setInterval(() => {
      if (state.authenticated && !state.auth?.mustChangePassword && !document.hidden && !state.refreshBusy)
        void refresh();
    }, 4000);
    const loginTimer = setInterval(() => {
      if (!document.hidden && isAccountView()) void pollLogin();
    }, 2500);
    const visible = () => {
      if (!document.hidden && state.authenticated) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(statusTimer);
      clearInterval(loginTimer);
      document.removeEventListener("visibilitychange", visible);
      invalidate();
    };
  }
  return {
    state,
    api,
    refresh,
    authenticate,
    updateCredentials,
    logout,
    toast,
    loginAction,
    loginStep,
    pollLogin,
    logoutDouyin,
    toggleChannel,
    openChannel,
    closeDialogs,
    start,
  };
}
export type ConsoleStore = ReturnType<typeof createConsole>;
export const consoleKey: InjectionKey<ConsoleStore> = Symbol("console");
export function useConsole() {
  const store = inject(consoleKey);
  if (!store) throw new Error("Console provider is missing");
  return store;
}
