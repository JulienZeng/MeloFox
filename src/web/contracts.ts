import type { LogEntry } from '../logger/contracts.js';
// JSON contracts shared by the console server and the bundled browser client.
export type ChannelType = "http" | "forward-ws" | "reverse-ws" | "reverse-http";
export interface ChannelInput {
  name: string;
  type: ChannelType;
  enabled: boolean;
  host: string;
  port: number;
  url: string;
  accessToken: string;
  secret: string;
  timeoutMs: number;
  publicBaseUrl: string;
}
export interface ConsoleChannel extends ChannelInput {
  id: string;
  status: { state: string; clients?: number; error?: string };
}
export interface ConsoleLogin {
  id: string;
  state:
    | "waiting"
    | "scanned"
    | "verifying"
    | "choose_trust"
    | "confirmed"
    | "saved"
    | "expired"
    | "refused"
    | "error";
  expiresAt: number;
  message: string;
  verification?: { smsAvailable: boolean; resendAt: number };
}
export interface ConsoleAuthSession {
  username: string;
  mustChangePassword: boolean;
}
export interface ConsoleDisk {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
  usagePercent: number;
}
export interface ConsoleChromium {
  state: 'stopped' | 'sampling' | 'ready' | 'partial' | 'unavailable';
  sampledAt: number | null;
  processCount: number;
  measuredMemoryProcesses: number;
  cpuUsagePercent: number | null;
  rssBytes: number | null;
}
export interface ConsoleRuntime {
  version: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  v8Version: string;
  chromiumVersion?: string;
  chromium: ConsoleChromium;
  memoryBytes: number;
  sampledAt: number;
  sampleIntervalMs: number;
  hostname: string;
  osName: string;
  osRelease: string;
  osVersion: string;
  machine: string;
  systemUptimeSeconds: number;
  processUptimeSeconds: number;
  pid: number;
  timezone: string;
  workingDirectory: string;
  dataDirectory: string;
  cpu: {
    model: string | null;
    logicalCores: number;
    availableParallelism: number;
    frequencyMHz: { min: number; max: number } | null;
    usagePercent: number | null;
    processUsagePercent: number | null;
    coreUsagePercent: Array<number | null>;
    loadAverage: number[] | null;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number | null;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    heapLimitBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    constrainedBytes: number | null;
  };
  disk: ConsoleDisk | null;
  diskSampledAt: number | null;
  network: Array<{ name: string; addresses: Array<{ address: string; family: string; cidr: string | null }> }>;
}
export interface ConsoleStatus {
  runtime: ConsoleRuntime;
  serverTime: number;
  startedAt: number;
  account: { loggedIn: boolean; id?: string; name?: string; avatar?: string; online?: boolean; good?: boolean };
  browser: "ready" | "error" | "starting";
  error?: string;
  channels: ConsoleChannel[];
  logs: LogEntry[];
  login?: ConsoleLogin;
}
