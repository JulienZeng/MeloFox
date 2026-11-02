import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { Browser, CDPSession } from 'playwright';
import type { ConsoleChromium } from './contracts.js';

const run = promisify(execFile);
interface ProcessInfo { id: number; type: string; cpuTime: number }
interface ProcessSample { time: number; processes: ProcessInfo[]; memory: Map<number, number> }
const empty = (state: ConsoleChromium['state']): ConsoleChromium => ({
  state, sampledAt: null, processCount: 0, measuredMemoryProcesses: 0, cpuUsagePercent: null, rssBytes: null,
});
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;

export function parseRssRows(text: string, unit: number): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match && validPid(Number(match[1])) && Number.isSafeInteger(Number(match[2]) * unit)) {
      result.set(Number(match[1]), Number(match[2]) * unit);
    }
  }
  return result;
}

/** Only PIDs reported by this browser's CDP session are queried, never other Chrome instances. */
export async function readProcessMemory(pids: number[]): Promise<Map<number, number>> {
  if (!pids.length || pids.some(pid => !validPid(pid))) return new Map();
  if (process.platform === 'linux') {
    const rows = await Promise.all(pids.map(async pid => {
      try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
        return match ? [pid, Number(match[1]) * 1024] as const : undefined;
      } catch { return undefined; } // A renderer can exit between CDP and the OS query.
    }));
    return new Map(rows.filter(row => row !== undefined));
  }
  try {
    const options = { timeout: 1500, maxBuffer: 256 * 1024, windowsHide: true };
    if (process.platform === 'win32') {
      // The interpolated list contains validated positive integers only; no shell or user input.
      const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.WorkingSet64 }`;
      const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], options);
      return parseRssRows(stdout, 1);
    }
    const { stdout } = await run('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], options);
    return parseRssRows(stdout, 1024);
  } catch (error) {
    // ps/Get-Process can return partial rows when one of the requested processes exited.
    const stdout = (error as { stdout?: string }).stdout;
    return stdout ? parseRssRows(stdout, process.platform === 'win32' ? 1 : 1024) : new Map();
  }
}

async function collect(browser: Browser): Promise<ProcessSample> {
  let session: CDPSession | undefined, expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    session = await browser.newBrowserCDPSession();
    if (expired) { void session.detach().catch(() => {}); throw new Error('Metrics timed out'); }
    const result = await session.send('SystemInfo.getProcessInfo');
    const time = performance.now();
    const processes = [...new Map(result.processInfo.filter(item => validPid(item.id) && Number.isFinite(item.cpuTime) && item.cpuTime >= 0).map(item => [item.id, item])).values()];
    if (!processes.some(item => item.type === 'browser')) throw new Error('Browser process is unavailable');
    return { time, processes, memory: await readProcessMemory(processes.map(item => item.id)) };
  })();
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Metrics timed out')); }, 1800);
      timer.unref();
    })]);
  } finally {
    clearTimeout(timer);
    void session?.detach().catch(() => {});
  }
}

export class ChromiumMetrics {
  private source: Browser | null = null;
  private previous?: ProcessSample;
  private current = empty('stopped');
  private pending?: Promise<void>;
  private generation = 0;
  private stopped = false;
  constructor(private readonly browser: () => Browser | null, private readonly read = collect) {}

  snapshot(): ConsoleChromium {
    let browser: Browser | null = null;
    try {
      if (!this.stopped) browser = this.browser();
      if (browser && !browser.isConnected()) browser = null;
    } catch { browser = null; /* Browser may be restarting. */ }
    if (browser !== this.source) {
      this.source = browser; this.previous = undefined; this.generation++;
      this.current = empty(browser ? 'sampling' : 'stopped');
    }
    return this.current;
  }

  update(): Promise<void> {
    this.snapshot();
    if (this.pending) return this.pending;
    const browser = this.source, generation = this.generation;
    if (!browser) return Promise.resolve();
    this.pending = (async () => {
      try {
        const next = await this.read(browser);
        this.snapshot();
        if (this.stopped || generation !== this.generation) return;
        const previous = this.previous, elapsed = previous ? next.time - previous.time : 0;
        const old = new Map(previous?.processes.map(item => [item.id, item]) ?? []);
        // Baseline only matching processes. New renderers need one full interval; exited
        // processes have no final counter. Mark such a sample partial instead of spiking CPU.
        let cpuSeconds = 0, measured = 0;
        for (const item of next.processes) {
          const before = old.get(item.id);
          if (before?.type === item.type && item.cpuTime >= before.cpuTime) {
            cpuSeconds += item.cpuTime - before.cpuTime; measured++;
          }
        }
        const memories = next.processes.map(item => next.memory.get(item.id)).filter(value => value !== undefined);
        const cpu = previous && elapsed >= 250 && measured > 0 ? Math.round(cpuSeconds / (elapsed / 1000) * 100 * 100) / 100 : null;
        this.current = {
          state: !previous ? 'sampling' : measured === next.processes.length && measured === previous.processes.length && memories.length === next.processes.length ? 'ready' : 'partial',
          sampledAt: Date.now(), processCount: next.processes.length, measuredMemoryProcesses: memories.length,
          cpuUsagePercent: cpu, rssBytes: memories.length ? memories.reduce((sum, value) => sum + value, 0) : null,
        };
        this.previous = next;
      } catch {
        this.snapshot();
        if (!this.stopped && generation === this.generation) { this.previous = undefined; this.current = empty('unavailable'); }
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async stop(): Promise<void> {
    this.stopped = true; this.snapshot();
    await this.pending;
  }
}
