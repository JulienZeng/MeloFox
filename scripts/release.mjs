import { appendFile, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactNames, checksums, command, dockerImage, json, releaseVersion, writeJson } from './release-lib.mjs';

async function prepare(tag, verifyTag) {
  const meta = releaseVersion(tag);
  const image = process.env.DOCKERHUB_IMAGE ? dockerImage(process.env.DOCKERHUB_IMAGE) : undefined;
  const commit = command('git', ['rev-parse', 'HEAD']);
  if (verifyTag) {
    if (!image) throw new Error('发布前须设置 DOCKERHUB_IMAGE');
    const tagged = command('git', ['rev-parse', '--verify', `refs/tags/${meta.tag}^{commit}`]);
    if (tagged !== commit) throw new Error('检出的提交与发布 tag 不一致');
  }
  const manifest = await json('package.json');
  if (manifest.name !== 'melofox') throw new Error('请在 MeloFox 项目根目录运行');
  manifest.version = meta.version;
  await writeJson('package.json', manifest);
  const info = { ...meta, commit, created: command('git', ['show', '-s', '--format=%cI', 'HEAD']), ...(image ? { image } : {}) };
  await mkdir('.release', { recursive: true });
  await writeJson('.release/build-info.json', info);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(info).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  }
  console.log(`MeloFox ${meta.version} · ${commit.slice(0, 12)}${meta.prerelease ? ' · 预发布' : ''}`);
}

// Release files are copied from an allowlist; never archive the working tree.
async function copyTree(source, target, allowed) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`发布目录不能包含符号链接：${source}`);
  if (stat.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of (await readdir(source)).sort()) await copyTree(join(source, name), join(target, name), allowed);
  } else if (stat.isFile() && allowed(source)) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } else throw new Error(`发布目录存在非预期文件：${source}`);
}

async function pack() {
  const info = await json('.release/build-info.json');
  const meta = releaseVersion(info.tag);
  const manifest = await json('package.json');
  if (meta.version !== info.version || manifest.version !== info.version || command('git', ['rev-parse', 'HEAD']) !== info.commit)
    throw new Error('源码版本发生变化，请重新执行 release:prepare 并构建');
  const built = await import(pathToFileURL(resolve('dist/runtime/version.js')).href);
  if (built.getVersionInfo().app_version !== info.version) throw new Error('编译产物版本不一致');
  for (const required of ['dist/index.js', 'dist/application.js', 'dist/web/public/index.html']) await lstat(required);
  const temporary = await mkdtemp(join(tmpdir(), 'melofox-package-'));
  const name = `melofox-${info.version}`, root = join(temporary, name), output = resolve('release');
  try {
    await mkdir(root); await mkdir(output, { recursive: true });
    await copyTree('dist', join(root, 'dist'), path => /\.(js|json|html|css|svg|png|ico|woff2?)$/.test(path));
    await copyTree('proto', join(root, 'proto'), path => path.endsWith('.proto'));
    for (const file of ['LICENSE', 'CHANGELOG.md', 'package.json', 'pnpm-lock.yaml', 'config/config.example.yaml']) {
      await mkdir(dirname(join(root, file)), { recursive: true }); await copyFile(file, join(root, file));
    }
    const deployment = (await readFile('.env.example', 'utf8'))
      .replace(/^IMAGE_NAME=.*$/m, `IMAGE_NAME=${info.image ?? 'melofox'}`)
      .replace(/^IMAGE_TAG=.*$/m, `IMAGE_TAG=${info.version}`);
    // Release Compose runs the published image and never tries to build missing source.
    const compose = (await readFile('docker-compose.yml', 'utf8'))
      .replace(/^    # 本地单架构.*\n    build:\n      context: \.\n      dockerfile: Dockerfile\n/m, '')
      .replace('${IMAGE_NAME:-melofox}', '${IMAGE_NAME:-' + (info.image ?? 'melofox') + '}')
      .replace('${IMAGE_TAG:-latest}', '${IMAGE_TAG:-' + info.version + '}');
    if (/^    build:/m.test(compose)) throw new Error('无法移除发布 Compose 的本机构建配置');
    await writeFile(join(root, '.env.example'), deployment);
    await writeFile(join(root, 'docker-compose.yml'), compose);
    await writeJson(join(root, 'build-info.json'), info);
    await writeFile(join(root, 'README.md'), `# MeloFox ${info.version}\n\n支持 OneBot 11。此包包含编译后的服务、管理台和协议文件，适用于各平台 Node.js，不包含 Node.js、依赖包或 Chromium。\n\n## 本机运行\n\n安装 Node.js 20.12+（推荐 24）、pnpm 9.15.3，以及 ffmpeg/ffprobe 后执行：\n\n\`\`\`sh\npnpm install --prod --frozen-lockfile\npnpm exec playwright install chromium\npnpm start\n\`\`\`\n\nLinux 可将浏览器安装命令换为 \`pnpm exec playwright install --with-deps chromium\`。无需执行 build。\n\n## Docker 运行\n\n\`\`\`sh\ncp .env.example .env\ndocker compose pull\ndocker compose up -d --no-build\n\`\`\`\n\n端口可在 .env 中配置；所有持久化状态绑定到 Compose 同目录的 ./data，目录自动创建，无需手动修改权限。运行参数首次导入后在管理台设置。默认仅映射管理台 3000 和媒体服务 3001。在设置中配置接收端可达的媒体公开地址；OneBot 通道初始为空，地址、端口和令牌在网络配置中按需添加。HTTP / 正向 WebSocket 如需从宿主机或外部访问，另行添加 Compose 端口映射。升级时以已保存或迁移后的端口为准，同步调整映射和反向代理，并保留已有通道的映射。打开 http://127.0.0.1:3000，默认管理账号 melofox，初始密码从服务端 data/console/admin-token 读取（Docker 为 /data/console/admin-token）。首次登录须修改密码。升级前备份并保留原登录资料和数据目录。\n\n构建提交：${info.commit}\n`);
    const env = { ...process.env, COPYFILE_DISABLE: '1' };
    command('tar', ['-czf', join(output, `${name}.tar.gz`), '-C', temporary, name], { env });
    // Remove a previous zip first: zip otherwise retains entries removed since the previous run.
    await rm(join(output, `${name}.zip`), { force: true });
    command('zip', ['-qr', join(output, `${name}.zip`), name], { cwd: temporary, env });
    await writeFile(join(output, 'docker-compose.yml'), compose);
    await writeFile(join(output, 'melofox.env.example'), deployment);
    await writeJson(join(output, 'build-info.json'), info);
    await checksums(output, artifactNames(info.version));
    console.log(`发布文件已生成：${output}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try {
  const [mode, tag, flag] = process.argv.slice(2);
  if (mode === 'prepare') await prepare(tag, flag === '--verify-tag');
  else if (mode === 'package' && !tag) await pack();
  else throw new Error('用法：node scripts/release.mjs prepare v1.2.3 [--verify-tag] | package');
} catch (error) { console.error(error.message); process.exitCode = 1; }
