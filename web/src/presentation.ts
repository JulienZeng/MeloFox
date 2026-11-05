import type { ChannelInput, ConsoleChannel } from "./types";
export const views = {
  overview: { label: "概览", title: "运行概览", icon: "◫" },
  account: { label: "抖音账号", title: "抖音账号", icon: "◎" },
  channels: { label: "网络配置", title: "网络配置", icon: "⇄" },
  logs: { label: "日志", title: "日志", icon: "≡" },
  settings: { label: "设置", title: "设置", icon: "⚙" },
};
export type ViewName = keyof typeof views;
export const channelTypes = {
  http: "HTTP",
  "forward-ws": "正向 WebSocket",
  "reverse-ws": "反向 WebSocket",
  "reverse-http": "反向 HTTP",
};
export const statuses: Record<string, string> = {
  disabled: "已停用",
  waiting: "等待会话",
  error: "启动失败",
  listening: "监听中",
  connected: "已连接",
  connecting: "连接中",
};
export const healthy = (status: string) =>
  ["listening", "connected"].includes(status);
export function channelSummary(channels: ConsoleChannel[]) {
  const counts = { ready: 0, waiting: 0, error: 0, disabled: 0 };
  for (const channel of channels) {
    if (!channel.enabled) counts.disabled++;
    else if (healthy(channel.status.state)) counts.ready++;
    else if (channel.status.state === 'error') counts.error++;
    else counts.waiting++;
  }
  return counts;
}
export function endpoint(channel: ChannelInput) {
  if (channel.type.startsWith("reverse-")) {
    try {
      const url = new URL(channel.url);
      url.search = "";
      return url.toString();
    } catch {
      return channel.url;
    }
  }
  const host = channel.host.includes(":") ? `[${channel.host}]` : channel.host;
  return `${channel.type === "http" ? "http" : "ws"}://${host}:${channel.port}`;
}
export function elapsed(start: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - start) / 60000));
  return minutes < 60
    ? `${minutes} 分钟`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
      : `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 时`;
}
