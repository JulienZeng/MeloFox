import { fileURLToPath } from 'node:url';
import { superviseServiceProcess } from './runtime/service-process.js';
import { sanitizeLogText } from './logger/sanitize.js';

// tsx runs the source entry in development; production runs the compiled entry.
const worker = new URL(import.meta.url.endsWith('.ts') ? './application.ts' : './application.js', import.meta.url);
try {
  process.exitCode = await superviseServiceProcess(fileURLToPath(worker), process.argv.slice(2));
} catch (error) {
  console.error('[FATAL] [MeloFox] 服务进程无法启动：' + sanitizeLogText(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
