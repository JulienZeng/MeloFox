# 使用 Docker 内置前端，避免构建前额外拉取 docker/dockerfile 镜像。

# 必须与 pnpm-lock.yaml 中的 Playwright 版本一致，否则预装 Chromium 无法匹配。
ARG PLAYWRIGHT_VERSION=1.63.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS base

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
ARG PLAYWRIGHT_VERSION
ARG PNPM_VERSION=9.15.3
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm install --global "pnpm@${PNPM_VERSION}" --registry="${NPM_REGISTRY}"
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --registry="${NPM_REGISTRY}" \
  && node -e 'if (require("playwright/package.json").version !== process.argv[1]) throw Error("Playwright image version must match pnpm-lock.yaml")' "${PLAYWRIGHT_VERSION}"

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN pnpm build && pnpm prune --prod

# 不携带源码、Vite、Vue 编译器或构建阶段的 pnpm/npm registry 配置。
FROM base AS runtime
ENV NODE_ENV=production \
    DOUYIN_ONEBOT_CONFIG=/app/config/config.example.yaml \
    BROWSER_HEADLESS=true \
    BROWSER_USER_DATA_DIR=/data/douyin-profile \
    MEDIA_CACHE_DIR=/data/media-cache \
    RUNTIME_MESSAGE_CACHE_DIR=/data/message-cache \
    WEB_HOST=0.0.0.0 \
    WEB_DATA_DIR=/data/console \
    ONEBOT_HTTP_HOST=0.0.0.0 \
    ONEBOT_FORWARD_WS_HOST=0.0.0.0

COPY --from=build --chown=pwuser:pwuser /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /app/dist ./dist
COPY --chown=pwuser:pwuser proto ./proto
COPY --chown=pwuser:pwuser config/config.example.yaml ./config/config.example.yaml
COPY --chown=pwuser:pwuser docker/healthcheck.mjs ./docker/healthcheck.mjs
RUN mkdir -p /data/douyin-profile /data/media-cache /data/message-cache /data/console \
  && chown -R pwuser:pwuser /data

USER pwuser
VOLUME ["/data"]
EXPOSE 3000 3001 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "docker/healthcheck.mjs"]
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
