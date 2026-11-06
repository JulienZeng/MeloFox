import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';

// Only a fully cleaned-up worker may request a replacement process.
export const SERVICE_RESTART_EXIT_CODE = 75;

/** Keep the launcher (and Docker PID 1) alive while replacing the application. */
export async function superviseServiceProcess(entry: string, args: string[] = []): Promise<number> {
  let child: ChildProcess | undefined;
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    stopping = true;
    child?.kill(signal);
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    while (!stopping) {
      child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
        stdio: 'inherit',
        // Inherit cwd, environment and the TS loader used by pnpm dev.
        // No shell or detached process: terminal/container signals stay controllable.
      });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('close', (code, signal) => resolve({ code, signal }));
      });
      child = undefined;
      if (stopping) return 0;
      if (result.code === SERVICE_RESTART_EXIT_CODE) continue;
      return result.code ?? (128 + (result.signal ? constants.signals[result.signal] ?? 0 : 0));
    }
    return 0;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
