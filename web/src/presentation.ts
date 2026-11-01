import type { ChannelInput } from "./types";
export const views = {
  overview: {
    label: "概览",
    title: "连接，从这里开始",
    description: "管理你的抖音账号与 OneBot 通道，让每一次连接清晰可见。",
    icon: "◫",
  },
  account: {
    label: "账号登录",
    title: "你的账号，连接起点",
    description: "登录抖音账号，为消息搭起第一座桥。",
    icon: "◎",
  },
  channels: {
    label: "连接通道",
    title: "每个通道，都是一种可能",
    description: "连接 AstrBot 或其他 OneBot 应用，按你的方式收发消息。",
    icon: "⇄",
  },
  activity: {
    label: "运行记录",
    title: "连接的每一步，都有迹可循",
    description: "查看本次运行中的会话恢复与通道变更记录。",
    icon: "≡",
  },
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
