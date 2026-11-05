export const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = typeof logLevels[number];
export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  details?: string;
}
export interface LogBatch {
  streamId: string;
  entries: LogEntry[];
  cursor: number;
  capacity: number;
  truncated: boolean;
  reset: boolean;
}
export function formatLogEntry(entry: LogEntry): string {
  return `${entry.time} [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}${entry.details ? '\n' + entry.details.split('\n').map(line => '  ' + line).join('\n') : ''}`;
}
