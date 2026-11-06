# 使用 Docker 内置前端，避免构建前额外拉取 docker/dockerfile 镜像。

# 使用 Debian slim，仅安装运行所需浏览器及依赖。
ARG NODE_IMAGE=node:24-bookworm-slim
# 保留版本校验；浏览器由锁文件安装的 Playwright CLI 下载。
ARG PLAYWRIGHT_VERSION=1.63.0

# TypeScript 与 Vue 产物跨架构通用；编译器及 Rollup/esbuild 在构建机原生架构运行。
# 避免在 ARM Mac 的 amd64 模拟环境中编译时触发 Illegal instruction。
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
ARG PLAYWRIGHT_VERSION
ARG PNPM_VERSION=9.15.3
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm install --global "pnpm@${PNPM_VERSION}" --registry="${NPM_REGISTRY}"
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --registry="${NPM_REGISTRY}" \
  && node -e 'if (require("playwright/package.json").version !== process.argv[1]) throw Error("Playwright package version must match PLAYWRIGHT_VERSION")' "${PLAYWRIGHT_VERSION}"

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN pnpm build

# 生产依赖在各自目标架构安装，不从原生编译阶段复制 node_modules。
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ARG PLAYWRIGHT_VERSION
ARG PNPM_VERSION=9.15.3
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm install --global "pnpm@${PNPM_VERSION}" --registry="${NPM_REGISTRY}"
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --registry="${NPM_REGISTRY}" \
  && node -e 'if (require("playwright/package.json").version !== process.argv[1]) throw Error("Playwright package version must match PLAYWRIGHT_VERSION")' "${PLAYWRIGHT_VERSION}"

# 不携带源码、Vite、Vue 编译器或构建阶段的 pnpm/npm registry 配置。
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    MELOFOX_CONFIG_DIR=/data/config \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DOUYIN_ONEBOT_CONFIG=/app/config/config.example.yaml \
    BROWSER_HEADLESS=true \
    BROWSER_USER_DATA_DIR=/data/douyin-profile \
    MEDIA_CACHE_DIR=/data/media-cache \
    RUNTIME_MESSAGE_CACHE_DIR=/data/message-cache \
    WEB_HOST=0.0.0.0 \
    WEB_DATA_DIR=/data/console \
    MEDIA_HOST=0.0.0.0 \
    MEDIA_PORT=3001

# 容器内使用 root，直接读写宿主机绑定目录，无需额外初始化服务或修改目录属主。
USER root
COPY --from=prod-deps /app/package.json /app/pnpm-lock.yaml ./
COPY --from=prod-deps /app/node_modules ./node_modules
# 现有 headless: true 且未设置 channel 的启动方式使用 headless shell。
# 不下载完整 Chromium、Firefox 或 WebKit；CLI 与生产依赖使用同一锁定版本。
# 下载缓存仅保留在 BuildKit，网络中断后可复用，不进入运行镜像。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean \
  && printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80melofox-retries \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
  && node node_modules/playwright/cli.js install --with-deps --only-shell chromium \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm
COPY --from=build /app/dist ./dist
COPY LICENSE ./LICENSE
COPY proto ./proto
COPY config/config.example.yaml ./config/config.example.yaml
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs
RUN mkdir -p /data/config /data/douyin-profile /data/media-cache /data/message-cache /data/console

EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "docker/healthcheck.mjs"]
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
