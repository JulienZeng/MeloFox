import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Preserve shell/container overrides while loading the existing local deployment profile. */
export function loadStartupEnvironment(
  directory = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const explicit = environment.DOUYIN_ONEBOT_ENV_FILE;
  const candidates = explicit
    ? [resolve(directory, explicit)]
    : [resolve(directory, '.env'), resolve(directory, '.env.astrbot')];
  const path = candidates.find(candidate => existsSync(candidate));
  if (!path) {
    if (explicit) throw new Error(`Environment file not found: ${candidates[0]}`);
    return undefined;
  }
  const values = parseEnv(readFileSync(path, 'utf8'));
  for (const [name, value] of Object.entries(values)) {
    if (environment[name] === undefined) environment[name] = value;
  }
  return path;
}
