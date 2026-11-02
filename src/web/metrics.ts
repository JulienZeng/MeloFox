import * as os from 'node:os';
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { getVersionInfo } from '../runtime/version.js';
import type { Browser } from 'playwright';
import { ChromiumMetrics } from './chromium-metrics.js';
import type { ConsoleDisk, ConsoleRuntime } from './contracts.js';

const INTERVAL_MS = 2000;
const safe = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };
const round = (value: number) => Math.round(value * 100) / 100;
const percent = (used: number, total: number) => total > 0 ? round(Math.max(0, Math.min(100, used / total * 100))) : null;
type CpuTimes = os.CpuInfo['times'];
const totalTime = (times: CpuTimes) => times.user + times.nice + times.sys + times.idle + times.irq;

export function cpuUsage(previous: CpuTimes, current: CpuTimes): number | null {
  const total = totalTime(current) - totalTime(previous), idle = current.idle - previous.idle;
  // CPU hotplug/reset and zero-length intervals must not appear as valid 0% samples.
  if (total <= 0 || idle < 0 || idle > total || Object.keys(current).some(key => current[key as keyof CpuTimes] < previous[key as keyof CpuTimes])) return null;
  return percent(total - idle, total);
}

export function readResources() {
  return {
    time: Date.now(), monotonicMs: performance.now(),
    cpus: safe(() => os.cpus(), []),
    processCpu: process.cpuUsage(), processMemory: process.memoryUsage(),
    totalMemory: os.totalmem(), freeMemory: os.freemem(),
    constrainedMemory: safe(() => process.constrainedMemory(), 0),
    heapLimit: getHeapStatistics().heap_size_limit,
    systemUptime: os.uptime(), processUptime: process.uptime(),
    parallelism: safe(() => os.availableParallelism(), 1),
    loadAverage: process.platform === 'win32' ? null : os.loadavg(),
    interfaces: safe(() => os.networkInterfaces(), {}),
  };
}

export async function readDisk(directory: string): Promise<ConsoleDisk | null> {
  try {
    const info = await statfs(directory);
    const totalBytes = info.blocks * info.bsize;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const freeBytes = Math.max(0, Math.min(totalBytes, info.bfree * info.bsize));
    const availableBytes = Math.max(0, Math.min(freeBytes, info.bavail * info.bsize));
    const usedBytes = totalBytes - freeBytes;
    return { totalBytes, usedBytes, freeBytes, availableBytes, usagePercent: percent(usedBytes, totalBytes)! };
  } catch { return null; }
}

/** A single sampler per console, independent of the number and timing of HTTP clients. */
export class RuntimeMetrics {
  private readonly chromium: ChromiumMetrics;
  private previous?: ReturnType<typeof readResources>;
  private current!: ConsoleRuntime;
  private timer?: ReturnType<typeof setInterval>;
  private pendingDisk?: Promise<void>;
  private directory = '';
  private stopped = true;
  private readonly system = {
    version: getVersionInfo().app_version,
    platform: process.platform, arch: process.arch, nodeVersion: process.version, v8Version: process.versions.v8,
    hostname: safe(() => os.hostname(), '未知'),
    osName: safe(() => os.type(), process.platform), osRelease: safe(() => os.release(), '未知'),
    osVersion: safe(() => os.version(), '未知'), machine: safe(() => os.machine(), process.arch),
    pid: process.pid, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    workingDirectory: safe(() => process.cwd(), ''), sampleIntervalMs: INTERVAL_MS,
  };
  constructor(
    private readonly read = readResources,
    private readonly diskReader = readDisk,
    browser: () => Browser | null = () => null,
  ) { this.chromium = new ChromiumMetrics(browser); this.sample(); }

  snapshot(): ConsoleRuntime {
    const chromium = this.chromium.snapshot();
    if (chromium !== this.current.chromium) this.current = { ...this.current, chromium };
    return this.current;
  }

  sample(): void {
    const next = this.read(), previous = this.previous;
    const elapsed = previous ? next.monotonicMs - previous.monotonicMs : 0;
    const compatible = previous && elapsed >= 250 && next.cpus.length === previous.cpus.length;
    const cores = next.cpus.map((core, index) => compatible ? cpuUsage(previous.cpus[index].times, core.times) : null);
    const aggregate = (cpus: os.CpuInfo[]) => cpus.reduce((sum, core) => ({
      user: sum.user + core.times.user, nice: sum.nice + core.times.nice, sys: sum.sys + core.times.sys,
      idle: sum.idle + core.times.idle, irq: sum.irq + core.times.irq,
    }), { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });
    const processDelta = previous ? next.processCpu.user + next.processCpu.system - previous.processCpu.user - previous.processCpu.system : -1;
    const frequencies = next.cpus.map(cpu => cpu.speed).filter(speed => speed > 0 && Number.isFinite(speed));
    const free = Math.max(0, Math.min(next.totalMemory, next.freeMemory));
    const used = next.totalMemory - free;
    this.current = {
      ...this.system, sampledAt: next.time, dataDirectory: this.directory,
      chromium: this.chromium.snapshot(),
      memoryBytes: next.processMemory.rss,
      systemUptimeSeconds: next.systemUptime, processUptimeSeconds: next.processUptime,
      cpu: {
        model: [...new Set(next.cpus.map(cpu => cpu.model).filter(Boolean))].join(' / ') || null,
        logicalCores: next.cpus.length, availableParallelism: next.parallelism,
        frequencyMHz: frequencies.length ? { min: Math.min(...frequencies), max: Math.max(...frequencies) } : null,
        usagePercent: compatible && cores.length && cores.every(value => value !== null)
          ? cpuUsage(aggregate(previous.cpus), aggregate(next.cpus)) : null,
        // One fully occupied logical core equals 100%; a multithreaded process can exceed 100%.
        processUsagePercent: elapsed >= 250 && processDelta >= 0 ? round(processDelta / (elapsed * 1000) * 100) : null,
        coreUsagePercent: cores, loadAverage: next.loadAverage,
      },
      memory: {
        totalBytes: next.totalMemory, usedBytes: used, freeBytes: free, usagePercent: percent(used, next.totalMemory),
        rssBytes: next.processMemory.rss, heapUsedBytes: next.processMemory.heapUsed, heapTotalBytes: next.processMemory.heapTotal,
        heapLimitBytes: next.heapLimit, externalBytes: next.processMemory.external, arrayBuffersBytes: next.processMemory.arrayBuffers,
        constrainedBytes: Number.isFinite(next.constrainedMemory) && next.constrainedMemory > 0 ? next.constrainedMemory : null,
      },
      disk: this.current?.disk ?? null, diskSampledAt: this.current?.diskSampledAt ?? null,
      network: Object.entries(next.interfaces).flatMap(([name, entries]) => {
        const addresses = (entries || []).filter(entry => !entry.internal).map(({ address, family, cidr }) => ({ address, family, cidr }));
        return addresses.length ? [{ name, addresses }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name)),
    };
    this.previous = next;
  }

  async start(directory: string): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.directory = resolve(directory);
    this.current = { ...this.current, dataDirectory: this.directory };
    await Promise.all([this.updateDisk(), this.chromium.update()]);
    if (this.stopped) return;
    this.timer = setInterval(() => {
      try { this.sample(); } catch { /* Keep the last timestamp so the client can identify a stale sample. */ }
      void this.updateDisk();
      void this.chromium.update();
    }, INTERVAL_MS);
    this.timer.unref();
  }

  private updateDisk(): Promise<void> {
    if (this.pendingDisk) return this.pendingDisk;
    this.pendingDisk = (async () => {
      let disk: ConsoleDisk | null = null;
      try { disk = await this.diskReader(this.directory); } catch { /* Metrics cannot block management operations. */ }
      if (!this.stopped) this.current = { ...this.current, disk, diskSampledAt: Date.now() };
    })().finally(() => { this.pendingDisk = undefined; });
    return this.pendingDisk;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([this.pendingDisk, this.chromium.stop()]);
  }
}
