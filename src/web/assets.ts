import type { FastifyInstance } from "fastify";
import { access, readdir, readFile } from "node:fs/promises";
import { extname } from "node:path";

export async function registerConsoleAssets(
  server: FastifyInstance,
): Promise<void> {
  // Compiled Node entry uses dist/web/public; tsx development uses the same Vite output.
  const candidates = [
    new URL("./public/", import.meta.url),
    new URL("../../dist/web/public/", import.meta.url),
  ];
  let root: URL | undefined;
  for (const candidate of candidates) {
    try {
      await access(new URL("index.html", candidate));
      root = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!root)
    throw new Error(
      "管理台尚未打包，请先执行 pnpm build（开发可执行 pnpm build:web）",
    );
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };
  async function register(directory: URL, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory())
        await register(new URL(`${entry.name}/`, directory), `${name}/`);
      else if (entry.isFile() && types[extname(name)]) {
        const content = await readFile(new URL(entry.name, directory));
        server.get(
          name === "index.html" ? "/" : `/${name}`,
          async (_request, reply) =>
            reply.type(types[extname(name)]).send(content),
        );
      }
    }
  }
  await register(root);
}
