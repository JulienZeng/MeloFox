import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const number = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const tagPattern = new RegExp(`^v(${number}\\.${number}\\.${number})(?:-(${identifier}(?:\\.${identifier})*))?$`);
export function releaseVersion(tag) {
  const match = typeof tag === 'string' && tagPattern.exec(tag);
  if (!match || match[0] !== tag || tag.length > 128) throw new Error('版本 tag 须为 v1.2.3 或 v1.2.3-beta.1，不接受前导零或 + 构建元数据');
  return { tag, version: tag.slice(1), prerelease: Boolean(match[2]) };
}

/** Read one level-two version section; examples inside fenced code are not headings. */
export function changelogNotes(markdown, tag) {
  const { version } = releaseVersion(tag);
  const sections = [];
  let current, fence;
  for (const line of markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = undefined;
      current?.push(line);
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      current?.push(line);
      continue;
    }
    const heading = line.match(/^ {0,3}##[ \t]+(.+)/);
    if (heading) {
      current = undefined;
      const label = heading[1].match(/^(?:\[v?([^\]]+)\]|v?([^\s]+))(?:\s|$)/);
      if ((label?.[1] ?? label?.[2]) === version) {
        current = [];
        sections.push(current);
      }
    } else current?.push(line);
  }
  if (!sections.length) throw new Error(`CHANGELOG.md 缺少 ${version} 的说明，请添加标题 ## [${version}]`);
  if (sections.length > 1) throw new Error(`CHANGELOG.md 中 ${version} 的版本标题重复`);
  const notes = sections[0].join('\n').trim();
  if (!notes.replace(/<!--[\s\S]*?-->/g, '').trim()) throw new Error(`CHANGELOG.md 中 ${version} 的说明为空`);
  return notes;
}

export async function readChangelog(tag) {
  let markdown;
  try { markdown = await readFile('CHANGELOG.md', 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('缺少 CHANGELOG.md，请先提交本版本的发布说明');
    throw error;
  }
  return changelogNotes(markdown, tag);
}

export function dockerImage(value) {
  if (typeof value !== 'string' || value.trim() !== value || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(value) || value.length > 200)
    throw new Error('请设置 DOCKERHUB_IMAGE，格式为 Docker Hub 命名空间/仓库名（小写，不含 tag）');
  return value;
}
export function compareStableTags(a, b) {
  const left = releaseVersion(a), right = releaseVersion(b);
  if (left.prerelease || right.prerelease) throw new Error('仅比较正式版本');
  const l = left.version.split('.').map(BigInt), r = right.version.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (l[i] !== r[i]) return l[i] > r[i] ? 1 : -1;
  return 0;
}
export function command(program, args, options = {}) {
  const output = execFileSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  return output?.trim() ?? '';
}
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function writeJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
export async function checksum(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
export async function checksums(directory, names) {
  const lines = await Promise.all([...names].sort().map(async name => `${await checksum(`${directory}/${name}`)}  ${name}`));
  await writeFile(`${directory}/SHA256SUMS`, lines.join('\n') + '\n');
}
export function artifactNames(version) {
  return [`melofox-${version}.tar.gz`, `melofox-${version}.zip`, 'docker-compose.yml', 'melofox.env.example', 'build-info.json'];
}
