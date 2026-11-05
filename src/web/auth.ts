import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import type { AppLogger } from '../logger/index.js';
import type { ConsoleAuthSession } from './contracts.js';

const textField = (label: string) => z.string({ required_error: `请输入${label}`, invalid_type_error: `${label}必须是文本` });
const usernameSchema = textField('账号').regex(/^[A-Za-z0-9_.-]{3,32}$/, '账号需为 3–32 位字母、数字、下划线、点或短横线');
const passwordSchema = textField('新密码').min(8, '新密码至少 8 位').max(128, '新密码最多 128 位').refine(value => /\S/u.test(value), '密码不能全为空格');
const loginSchema = z.object({
  username: textField('账号').min(1, '请输入账号').max(32, '账号最多 32 位'),
  password: textField('密码').min(1, '请输入密码').max(1024, '密码最多 1024 位')
}, { required_error: '请填写账号和密码', invalid_type_error: '登录信息格式不正确' }).strict('登录信息包含未知字段');
const recordSchema = z.object({
  version: z.literal(1), algorithm: z.literal('scrypt'), username: usernameSchema,
  salt: z.string().regex(/^[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{128}$/),
  mustChangePassword: z.boolean(), revision: z.string().uuid()
}).strict();
type CredentialRecord = z.infer<typeof recordSchema>;
const changeSchema = z.object({
  username: usernameSchema.optional(), currentPassword: textField('当前密码').max(1024, '当前密码最多 1024 位').optional(),
  newPassword: passwordSchema, confirmPassword: textField('确认密码').min(1, '请再次输入新密码').max(128, '确认密码最多 128 位')
}, { required_error: '请填写新的账号密码信息', invalid_type_error: '账号密码信息格式不正确' })
  .strict('账号密码信息包含未知字段')
  .refine(input => input.newPassword === input.confirmPassword, { message: '两次输入的新密码不一致', path: ['confirmPassword'] });
const failure = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
let activeHashes = 0;
async function hash(password: string, salt: string): Promise<Buffer> {
  if (activeHashes >= 4) throw failure('登录请求繁忙，请稍后重试', 429);
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolveHash, reject) => {
      scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => error ? reject(error) : resolveHash(key));
    });
  } finally { activeHashes--; }
}
const revision = () => randomUUID();

export class ConsoleCredentials {
  private record!: CredentialRecord;
  private changing: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(private readonly directory: string) { this.path = join(directory, 'admin-credentials.json'); }
  get currentRevision() { return this.record.revision; }
  session(): ConsoleAuthSession {
    return { username: this.record.username, mustChangePassword: this.record.mustChangePassword };
  }
  async initialize(initialToken: string | undefined, logger: AppLogger) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.record = recordSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      await chmod(this.path, 0o600);
      return;
    } catch (error) {
      // A damaged credentials file must never silently restore the initial password.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let password = initialToken;
    if (!password) {
      const tokenFile = join(this.directory, 'admin-token');
      try { password = (await readFile(tokenFile, 'utf8')).trim(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        password = randomBytes(24).toString('base64url');
        try { await writeFile(tokenFile, `${password}\n`, { mode: 0o600, flag: 'wx' }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          password = (await readFile(tokenFile, 'utf8')).trim();
        }
      }
      if (!password) throw new Error('初始管理密码为空，请检查 admin-token 或 WEB_TOKEN');
      await chmod(tokenFile, 0o600);
      logger.info({ tokenFile }, '管理台初始账号为 melofox，初始密码已写入文件');
    }
    const salt = randomBytes(16).toString('hex');
    const record: CredentialRecord = { version: 1, algorithm: 'scrypt', username: 'melofox', salt,
      hash: (await hash(password, salt)).toString('hex'), mustChangePassword: true, revision: revision() };
    try { await writeFile(this.path, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); this.record = record; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      this.record = recordSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    }
  }
  async verify(username: string, password: string): Promise<string | undefined> {
    const record = this.record;
    const valid = timingSafeEqual(await hash(password, record.salt), Buffer.from(record.hash, 'hex'));
    return valid && username === record.username && this.record === record ? record.revision : undefined;
  }
  change(input: unknown, expectedRevision: string): Promise<void> {
    const body = changeSchema.parse(input);
    const operation = this.changing.then(async () => {
      const record = this.record;
      if (record.revision !== expectedRevision) throw failure('登录已失效，请重新登录', 401);
      if (!record.mustChangePassword && (!body.currentPassword ||
        !await this.verify(record.username, body.currentPassword))) throw failure('当前密码不正确', 400);
      if (await this.verify(record.username, body.newPassword)) throw failure('新密码不能与当前密码相同', 400);
      const salt = randomBytes(16).toString('hex');
      const next: CredentialRecord = { ...record, username: body.username ?? record.username,
        salt, hash: (await hash(body.newPassword, salt)).toString('hex'), mustChangePassword: false, revision: revision() };
      const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
        this.record = next;
      } finally { await rm(temporary, { force: true }); }
    });
    this.changing = operation.catch(() => {});
    return operation;
  }
}

export async function registerConsoleAuthentication(server: FastifyInstance, config: AppConfig, logger: AppLogger) {
  const credentials = new ConsoleCredentials(resolve(config.web.dataDir));
  await credentials.initialize(config.web.token, logger);
  const sessions = new Map<string, { expires: number; revision: string }>();
  const attempts = new Map<string, { count: number; until: number }>();
  const sessionOf = (request: FastifyRequest) => request.headers.cookie?.match(/(?:^|;\s*)dy_console=([\w-]+)/)?.[1];
  const issue = (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now(), seconds = credentials.session().mustChangePassword ? 600 : 43200;
    for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
    if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, { expires: now + seconds * 1000, revision: credentials.currentRevision });
    reply.header('Set-Cookie', `dy_console=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${request.protocol === 'https' ? '; Secure' : ''}`);
    return credentials.session();
  };
  const limit = (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const attempt = attempts.get(request.ip) ?? { count: 0, until: now + 60_000 };
    if (attempt.count >= 8 || (attempts.size >= 256 && !attempts.has(request.ip))) {
      reply.header('Retry-After', '60');
      throw failure('尝试过于频繁，请一分钟后重试', 429);
    }
    attempt.count++; attempts.set(request.ip, attempt);
  };
  server.addHook('onRequest', async (request, reply) => {
    // Authorize the matched route, including percent-encoded static segments.
    // Checking only the raw URL would let /%61pi/status reach /api/status unauthenticated.
    const matched = request.routeOptions.url;
    const path = matched?.startsWith('/api/') ? matched : new URL(request.url, 'http://localhost').pathname;
    if (!path.startsWith('/api/') || path === '/api/auth/login') return;
    const id = sessionOf(request), session = id && sessions.get(id);
    if (!session || session.expires <= Date.now() || session.revision !== credentials.currentRevision) {
      if (id) sessions.delete(id);
      return reply.code(401).send({ message: '请先登录管理台' });
    }
    if (credentials.session().mustChangePassword && !['/api/auth/session', '/api/auth/credentials', '/api/auth/logout'].includes(path))
      return reply.code(403).send({ code: 'PASSWORD_CHANGE_REQUIRED', message: '首次登录请先修改密码' });
  });
  server.post('/api/auth/login', async (request, reply) => {
    limit(request, reply);
    const body = loginSchema.parse(request.body);
    const verifiedRevision = await credentials.verify(body.username, body.password);
    if (!verifiedRevision || verifiedRevision !== credentials.currentRevision) return reply.code(401).send({ message: '账号或密码不正确' });
    attempts.delete(request.ip);
    logger.info({ username: credentials.session().username }, '管理台登录成功');
    const previous = sessionOf(request); if (previous) sessions.delete(previous);
    return issue(request, reply);
  });
  server.get('/api/auth/session', async () => credentials.session());
  server.post('/api/auth/credentials', async (request, reply) => {
    limit(request, reply);
    const session = sessions.get(sessionOf(request) ?? '');
    if (!session) throw failure('请先登录管理台', 401);
    await credentials.change(request.body, session.revision);
    logger.info('管理账号凭据已更新，其他管理会话已退出');
    sessions.clear();
    attempts.delete(request.ip);
    return issue(request, reply);
  });
  server.post('/api/auth/logout', async (request, reply) => {
    const id = sessionOf(request); if (id) sessions.delete(id);
    logger.info('已退出管理台');
    reply.header('Set-Cookie', 'dy_console=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });
}
