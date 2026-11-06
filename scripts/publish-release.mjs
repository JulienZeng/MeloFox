import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { artifactNames, checksum, checksums, command, compareStableTags, dockerImage, json, readChangelog, releaseVersion } from './release-lib.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const apiRoot = process.env.GITHUB_API_URL || 'https://api.github.com';
const image = dockerImage(process.env.DOCKERHUB_IMAGE);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !token)
  throw new Error('发布需要 GITHUB_REPOSITORY 和 GH_TOKEN（工作流自动提供）');
const base = `/repos/${repository}`;
async function api(path, method = 'GET', body, missing = false) {
  const response = await fetch(`${apiRoot}${path}`, {
    method, signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (missing && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub API ${method} ${path} 失败（HTTP ${response.status}）`);
  return response.status === 204 ? undefined : response.json();
}
function inspect(reference) {
  return JSON.parse(command('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}']));
}
const validDigest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
async function check(tag, commit) {
  releaseVersion(tag);
  const existing = await api(`${base}/releases/tags/${tag}`, 'GET', undefined, true);
  if (existing && !existing.draft) throw new Error(`${tag} 已发布；请使用新的版本 tag，或仅重跑尚未成功的后续任务`);
  if (existing && existing.target_commitish !== commit) throw new Error('已有 Release 草稿指向其他提交，拒绝覆盖');
  return existing;
}
async function publish() {
  const info = await json('release/build-info.json');
  const meta = releaseVersion(info.tag);
  if (info.version !== meta.version || info.image !== image || info.commit !== command('git', ['rev-parse', 'HEAD']))
    throw new Error('发布产物、镜像仓库或源码提交不一致');
  const notes = await readChangelog(meta.tag);
  let release = await check(meta.tag, info.commit);
  const files = artifactNames(info.version);
  const sums = new Map((await readFile('release/SHA256SUMS', 'utf8')).trim().split('\n').map(line => {
    const [digest, name] = line.split('  '); return [name, digest];
  }));
  for (const file of files) if (sums.get(file) !== await checksum(`release/${file}`)) throw new Error(`产物校验失败：${file}`);
  const sources = [];
  for (const arch of ['amd64', 'arm64']) {
    const digest = (await readFile(`.release/digests/${arch}.txt`, 'utf8')).trim();
    if (!validDigest(digest)) throw new Error(`无效镜像摘要：${arch}`);
    sources.push(`${image}@${digest}`);
  }
  command('docker', ['buildx', 'imagetools', 'create', '--tag', `${image}:${meta.version}`, '--tag', `${image}:${meta.tag}`,
    '--annotation', `index:org.opencontainers.image.version=${meta.version}`,
    '--annotation', `index:org.opencontainers.image.revision=${info.commit}`, ...sources], { stdio: 'inherit' });
  const manifest = inspect(`${image}:${meta.version}`);
  const platforms = new Set((manifest.manifests ?? []).map(item => `${item.platform?.os}/${item.platform?.architecture}`));
  if (!validDigest(manifest.digest) || !['linux/amd64', 'linux/arm64'].every(platform => platforms.has(platform)))
    throw new Error('多架构镜像校验失败');
  await writeFile('release/image-digest.txt', `${image}@${manifest.digest}\n`);
  files.push('image-digest.txt');
  await checksums('release', files); files.push('SHA256SUMS');
  const generated = await api(`${base}/releases/generate-notes`, 'POST', { tag_name: meta.tag, target_commitish: info.commit });
  const body = `<!-- melofox-release: ${info.commit} -->\n<!-- melofox-image: ${image}@${manifest.digest} -->\n\n` +
    `支持 OneBot 11。版本：\`${meta.version}\`。\n\n` +
    `## 更新说明\n\n${notes}\n\n## 安装与下载\n\n` +
    `Docker（linux/amd64、linux/arm64）：\n\n\`\`\`sh\ndocker pull ${image}:${meta.version}\n\`\`\`\n\n` +
    `固定镜像摘要：\`${image}@${manifest.digest}\`\n\n` +
    `下载 tar.gz / zip 获得编译后的通用 Node.js 包；仍需安装生产依赖、Chromium 及 ffmpeg。Docker 用户可下载 docker-compose.yml 和 melofox.env.example（复制为 .env）。下载后使用 SHA256SUMS 校验。\n\n## GitHub 自动生成的说明\n\n${generated.body}`;
  const record = { tag_name: meta.tag, target_commitish: info.commit, name: `MeloFox ${meta.tag}`, body,
    draft: true, prerelease: meta.prerelease, make_latest: 'false' };
  release = release ? await api(`${base}/releases/${release.id}`, 'PATCH', record) : await api(`${base}/releases`, 'POST', record);
  for (const name of files) {
    const existing = release.assets.find(asset => asset.name === name);
    if (existing) await api(`${base}/releases/assets/${existing.id}`, 'DELETE');
    const upload = new URL(release.upload_url.split('{')[0]); upload.searchParams.set('name', name);
    const response = await fetch(upload, { method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: await readFile(`release/${name}`) });
    if (!response.ok) throw new Error(`上传 ${name} 失败（HTTP ${response.status}），Release 保持草稿，可重试`);
  }
  await api(`${base}/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'false' });
  console.log(`已发布 ${meta.tag}：${release.html_url}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## MeloFox ${meta.tag}\n\n- [GitHub Release](${release.html_url})\n- Docker：\`${image}:${meta.version}\` / \`${image}:${meta.tag}\`\n- 架构：linux/amd64、linux/arm64\n- 摘要：\`${manifest.digest}\`\n`);
}
async function latest() {
  // This job is serialized separately. Select the highest published stable
  // version, even if an older workflow or a coalesced pending job runs last.
  const candidates = [];
  for (let page = 1; ; page++) {
    const releases = await api(`${base}/releases?per_page=100&page=${page}`);
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      try { if (releaseVersion(release.tag_name).prerelease) continue; } catch { continue; }
      const reference = release.body?.match(/<!-- melofox-image: ([^\s]+) -->/)?.[1];
      if (reference?.startsWith(`${image}@`) && validDigest(reference.slice(image.length + 1))) candidates.push({ ...release, reference });
    }
    if (releases.length < 100) break;
  }
  const selected = candidates.sort((a, b) => compareStableTags(b.tag_name, a.tag_name))[0];
  if (!selected) throw new Error('没有可更新 latest 的已发布正式版本');
  command('docker', ['buildx', 'imagetools', 'create', '--tag', `${image}:latest`, selected.reference], { stdio: 'inherit' });
  if (`${image}@${inspect(`${image}:latest`).digest}` !== selected.reference) throw new Error('latest 镜像摘要校验失败');
  await api(`${base}/releases/${selected.id}`, 'PATCH', { make_latest: 'true' });
  console.log(`Docker latest 与 GitHub Latest 已指向 ${selected.tag_name}`);
}
try {
  const [mode, tag] = process.argv.slice(2);
  if (mode === 'check') {
    await readChangelog(tag);
    await check(tag, command('git', ['rev-parse', 'HEAD']));
  }
  else if (mode === 'publish') await publish();
  else if (mode === 'latest') await latest();
  else throw new Error('用法：node scripts/publish-release.mjs check v1.2.3 | publish | latest');
} catch (error) { console.error(error.message); process.exitCode = 1; }
