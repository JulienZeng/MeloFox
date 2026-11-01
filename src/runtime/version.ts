import { createRequire } from 'node:module';

const { name, version } = createRequire(import.meta.url)('../../package.json') as { name: string; version: string };

export function getVersionInfo(): { app_name: string; app_version: string; protocol_version: string } {
  return { app_name: name, app_version: version, protocol_version: '11' };
}
