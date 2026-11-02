# MeloFox · 部署与配置

[返回 README](../README.md)

## 本机生产部署

需要 Node.js 20.12+、pnpm、Playwright Chromium，以及可执行的 ffmpeg / ffprobe。Linux 安装 Chromium 时可用 `pnpm exec playwright install --with-deps chromium` 一并安装系统依赖。

先安装完整依赖，再打包和启动：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

管理台采用 Vue 3 + TypeScript + Vue Router，源码在 `web/`。`pnpm build` 同时编译 Node 后端并用 Vite 打包前端：后端入口是 `dist/index.js`，管理台产物是 `dist/web/public/`（包含 HTML、带哈希的 JS/CSS 和图片）。现有 Node 服务直接提供这些静态资源，运行时不需要 Vite 服务、Vue 源码或外部 CDN。

部署到另一台机器时，一起复制 `dist/`、`proto/`、`config/`、`package.json` 和 `pnpm-lock.yaml`，在部署目录执行：

```sh
pnpm install --prod --frozen-lockfile
pnpm exec playwright install chromium
pnpm start
```

目标机器仍需安装 Chromium 的系统依赖及 ffmpeg / ffprobe；登录状态和通道配置继续使用原来的持久数据目录。构建机器先安装完整依赖再运行 `pnpm build`；生产环境仅安装依赖并启动已生成的产物，不在删去开发依赖后执行构建。前端所需的 Vue、路由和构建工具都在构建阶段处理。

## 配置优先级与通道持久化

运行参数参考 [`.env.example`](../.env.example)，构建参数参考 [`.build.env.example`](../.build.env.example)。两个文件用途独立；已有本机 env 直接编辑，不覆盖现有值。

本机启动配置优先级为：进程环境变量 > `.env`（没有时回退 `.env.astrbot`）> YAML。默认 YAML 为 `config/config.example.yaml`。可用进程环境中的 `DOUYIN_ONEBOT_ENV_FILE` 选择其他 env，用 `DOUYIN_ONEBOT_CONFIG` 选择其他 YAML。Compose 使用自己的 `.env` 插值机制，只把 `docker-compose.yml` 列出的环境变量传入容器。

首次启动先加载本地环境文件，再将 YAML / 环境变量中的启用通道导入 `data/console/channels.json`。此后以该文件为准，通过网页管理，修改旧的 `ONEBOT_*` 环境变量不会覆盖已有通道。管理台数据目录可用 `WEB_DATA_DIR` 修改。文件包含通道令牌，目录和文件分别以 0700 / 0600 权限创建。

- **HTTP**：提供 OneBot API、媒体下载与原有调试接口。
- **正向 WebSocket**：本服务监听，应用主动连接。
- **反向 WebSocket**：本服务主动连接应用，适用于 AstrBot。
- **反向 HTTP**：向应用 POST 事件，支持 HMAC-SHA1 签名、磁盘队列重试、心跳、启用/停用生命周期，以及回复/撤回自身消息的快速操作。该通道中的签名密钥用于 `X-Signature`；Access Token 用于其他通道的 API 鉴权。

图片和视频的媒体下载需要至少一个启用的 HTTP 通道。多个 HTTP 通道共用媒体缓存，对外生成链接时使用列表中第一个启用的 HTTP 通道。机器人在其他设备上时，请将该通道的「媒体公开地址」设为机器人能够访问的地址。监听 `0.0.0.0` 只表示绑定所有网卡，不能作为远程访问地址。

管理台默认监听 `127.0.0.1:3000`，使用 HttpOnly / SameSite 会话 Cookie，登录有效期 12 小时。设置 `WEB_ENABLED=false` 可关闭管理台，恢复完全由 YAML / 环境变量控制的原有启动方式。

## 管理账号与首次登录

默认账号为 `melofox`。首次初始化使用当前 `WEB_TOKEN` 作为初始密码；未设置时读取 `WEB_DATA_DIR/admin-token`，该文件不存在才自动生成。已有令牌部署升级后也使用这套账号密码登录。

首次登录只授予限时改密会话，刷新或直接调用管理 API 都不能绕过。必须设置与当前密码不同的 8–128 位新密码；账号可保持不变，或改为 3–32 位字母、数字、下划线、点和短横线。完成后进入控制台。

账号及加盐 scrypt 密码哈希存放在 `WEB_DATA_DIR/admin-credentials.json`，文件权限为 0600。已有凭据优先，重启、重新部署、修改 `WEB_TOKEN` 都不会覆盖已设置的账号密码；初始令牌也不再用于登录。Docker 中该文件位于 `/data/console/`，随现有数据卷持久化。

日常修改在「设置 → 管理账号」进行，需要当前密码，保存后其他登录会话失效。浏览器使用 HttpOnly / SameSite 会话 Cookie，不把密码存到 localStorage。完整会话有效期 12 小时，首次改密会话有效期 10 分钟。

忘记账号或密码时，停止服务，在服务端私下备份并移走 `admin-credentials.json`，确认 `WEB_TOKEN` 或 `admin-token` 中的初始密码后重新启动，再用 `melofox` 完成首次改密。仅处理该凭据文件，保留登录资料、通道和缓存目录。损坏的凭据文件会使管理服务启动失败，不会自动恢复初始密码。

## 概览指标

概览的系统信息和资源指标通过已登录的管理 API 提供，采样器随管理服务启动与关闭。每 2 秒更新一次 CPU / 内存 / 磁盘 / 网卡数据；网页沿用每 4 秒刷新，页面隐藏时暂停请求。多个浏览器共享同一份采样，手动刷新不重置 CPU 统计区间；首次区间未完成时显示 `—`。数据超过 10 秒未更新或服务连接中断时显示“数据未更新”，浏览器与服务端的时钟偏差不影响过期判断。

| 分区 | 展示内容与统计口径 |
| --- | --- |
| 抖音账号 | 当前已验证账号的昵称、头像、ID 与消息连接状态；账号管理页同步显示 |
| 系统信息 | MeloFox / 管理台版本、Node.js / V8 / Chromium 版本、操作系统与内核、主机名、架构、时区、系统与服务运行时间、启动时间、PID、工作目录 |
| CPU | 型号、逻辑核心、可用并行度、系统报告频率、整体/逐核使用率、MeloFox 主进程与 Chromium 进程组 CPU、浏览器进程数；逐核使用率默认展开，可手动收起；由相邻采样的 CPU 时间差计算 |
| 内存 | 系统总量、已用（总量减空闲，含缓存）、空闲、MeloFox 主进程与 Chromium 进程组 RSS、JS 堆已用/已分配/上限、外部内存、ArrayBuffer、系统报告的环境内存限制 |
| 磁盘 | 管理数据目录所在文件系统的总量、已用、空闲及当前进程可用空间；不是目录占用大小，也不扫描目录文件 |
| 网络 | 有地址的非回环网卡与 IPv4 / IPv6 地址；不代表公网地址或 OneBot 对外访问地址 |
| 通道 | 总数 = 就绪 + 等待 + 异常 + 停用；就绪包含已连接或监听中，等待包含等待会话/连接中；停用通道优先计入停用。每类 HTTP / WS 卡片展示总数及启用/停用数，两者之和等于该类总数 |

系统指标来自 [Node.js OS API](https://nodejs.org/docs/latest-v20.x/api/os.html)，表示运行环境可见的资源，容器中可能是宿主机或虚拟机总量。MeloFox 主进程通过 [Node.js Process API](https://nodejs.org/docs/latest-v20.x/api/process.html) 采集，Chromium 进程组独立展示；两者 CPU 都按单个逻辑核心计算，可超过 100%。ArrayBuffer 已包含在外部内存中，各项不相加。磁盘使用 [statfs](https://nodejs.org/docs/latest-v20.x/api/fs.html#fspromisesstatfspath-options) 读取文件系统容量。

Chromium 使用当前浏览器实例的 [CDP 会话](https://playwright.dev/docs/api/class-browser#browser-new-browser-cdp-session) 查询 `SystemInfo.getProcessInfo`，按 PID 累加浏览器、渲染器、GPU 和工具进程的区间 CPU。内存仅查询这些 PID：Linux 读取 `/proc/<pid>/status`，macOS 使用系统 `ps`，Windows 使用 PowerShell `Get-Process` 的 `WorkingSet64`。RSS 总和可能重复计入共享页，不等于独占内存。首次采样、进程增减、读数不可用分别显示采样中、部分数据或采集不可用；部分内存样本会标注已采集/全部进程数量。浏览器重启清除旧采样与 CPU 基线，不会统计其他 Chrome 实例。Linux 容器不需要新增进程工具包。

账号资料复用 `get_login_info` 底层的已登录账号查询，通过抖音 `/aweme/v1/web/im/user/info/` 获取昵称和头像；OneBot 的 `get_login_info` 仍返回标准的 `user_id`、`nickname`，管理台的 `/api/status` 增加 `account.name` 和 `account.avatar`。资料在页面轮询时后台刷新，成功缓存 60 秒，失败 15 秒后重试；不阻塞资源指标。退出或切换账号立即清除旧资料，查询失败保留同一账号的上次资料。头像仅允许 HTTPS 抖音/字节图片 CDN，加载失败显示默认头像。

部分平台不提供 CPU 频率、环境内存限制或磁盘信息。这些项目显示 `—`、不可用或“未限制或不可用”，不会用零值冒充有效读数。Chromium 尚未启动时显示“尚未就绪”。

## 登录与会话恢复

默认使用无头 Chromium，不弹出浏览器窗口。后台 Chromium 用于抖音消息收发，以及在官方站点会话中执行登录 API（保留官方 Cookie 与请求 SDK）。常规扫码使用接口返回的二维码和状态。遇到支持的短信二次验证时，管理台显示发送验证码及校验表单；只有点击发送才请求短信，60 秒内不重复请求。后台保留官方 SDK 的原扫码事务，验证成功后由外部验证处理器继续请求。随后选择是否在抖音保存快捷登录信息，调用官方 `setTrust`（保存为 1、不保存为 2），成功后保存网关会话。两种选择都会保留本网关的当前会话以便重启恢复，退出登录可清除。SDK 尚未加载、上行短信、滑块等情况仍可点击「官方页面辅助验证」，按需操作官方页面，完成后点击「保存登录」。原生表单已通过本地模拟协议和真实 Chromium UI 验证，真实账号完整流程仍待联调。画面仅在操作或刷新时更新，闲置 10 分钟关闭。

管理服务独立于抖音会话，后台会话启动失败时仍可打开网页管理配置。登录 API 在后台会话就绪后可用。登录凭据保存在 `WEB_DATA_DIR/douyin-session.json`，文件权限为 0600；下次启动先恢复凭据再加载消息服务。`browser.userDataDir` 同时保留 Chromium 运行资料。二维码、手机确认及官方验证由用户完成。官方返回风险验证等错误时，管理台显示原始错误码和说明，不把它当作登录成功。

## Docker

Dockerfile 使用多阶段构建：编译 Node 后端及 Vue 管理台后，只复制生产依赖、`dist/`、协议及配置到运行镜像。容器以 `pwuser` 运行，包含 Chromium、ffmpeg/ffprobe 和 tini；Playwright 镜像版本必须与锁文件一致，构建时检查，参见 [Playwright 镜像版本说明](https://playwright.dev/docs/docker#usage)。

首次本地构建并部署（已有 `.env` 时直接编辑，不覆盖）：

```sh
cp .env.example .env
# 编辑运行配置，默认镜像名为 melofox:latest
docker compose config --quiet
docker compose build
docker compose up -d --no-build --pull never
docker compose exec douyin-onebot cat /data/console/admin-token
```

使用已发布镜像时，将 `.env` 的 `IMAGE_NAME` / `IMAGE_TAG` 改为对应仓库和标签，执行 `docker compose pull`、`docker compose up -d --no-build --pull never`，无需在部署机编译。`docker compose build` 使用 Dockerfile 默认构建参数；需要构建代理或覆盖构建参数时使用下方脚本。

打开 http://127.0.0.1:3000，使用 `melofox` 和初始密码登录并完成改密，再在「抖音账号」扫码。Compose 内部端口固定为 3000/3001/3002，`.env` 的 `*_PORT` 控制宿主机端口，`*_BIND` 控制宿主机绑定 IP；本机 Node 部署的 `*_HOST`、数据目录、ffmpeg 路径不覆盖容器内固定值。容器强制无头运行。管理端口默认只绑定宿主机回环地址；远程访问按需修改 `WEB_BIND` 并完成管理账号的首次改密。

反向 WS/HTTP 地址必须能从容器访问。机器人在宿主机时可用 `host.docker.internal`；同一个 Docker 网络的机器人可用服务名。`ONEBOT_HTTP_PUBLIC_BASE_URL` 是机器人读取媒体的地址，需要从机器人所在环境访问验证：跨机器填宿主机 IP/域名和映射端口；同网容器可用 `http://douyin-onebot:3001`。机器人在其他容器时，其 `127.0.0.1` 不代表网关。已有管理台通道以持久化配置为准，改 env 只影响首次导入；容器内新增 HTTP/正向 WS 通道时监听 `0.0.0.0`，使用新端口还需增加 Compose 映射。

所有持久状态位于 `/data`：`douyin-profile/`、`media-cache/`、`message-cache/`、`console/`。默认命名卷为 `DOCKER_DATA_VOLUME=douyin-onebot-data`，新卷自动继承镜像目录权限；多实例使用不同卷名和宿主机端口。`docker compose down` 保留数据；`down -v` 会删除该卷。旧版的宿主机 `./data` 绑定目录不会自动迁移：停掉旧容器并备份后，将上述四个目录复制到新卷并设置为 `pwuser` 所有，或通过 Compose override 将 `/data` 继续绑定到原目录，并保证容器用户有写权限；迁移完成前保留原数据。

健康检查只确认管理台 HTTP 或（管理台关闭时）OneBot HTTP 服务可用，不把未扫码/IM 离线视为容器故障；两种 HTTP 入口都关闭时跳过探测。`unhealthy` 是诊断状态，Docker 不会仅因该状态自动重启容器；`restart: unless-stopped` 处理进程退出后的重启。`docker compose ps` 查看状态，`docker compose logs --tail=100` 查看日志。共享内存、停止宽限、日志轮转均可通过已注释的 Docker 环境变量调整。

### 镜像构建与代理

首次复制 `.build.env.example` 为 `.build.env`，修改镜像仓库、标签及平台。该文件由 Bash `source` 加载，按文件中注释配置；运行配置留在 `.env`。已有 `.build.env` 可直接补充新参数，不需要覆盖本机仓库或代理值。

```sh
./build-multiarch.sh --dry-run  # 校验参数并预览，代理值脱敏，不调用 Docker
./build-multiarch.sh            # 按 .build.env 构建
# 可指定另一份可信构建配置
BUILD_ENV_FILE=/path/to/build.env ./build-multiarch.sh
```

`BUILD_OUTPUT=push` 构建多平台并推送，需要提前 `docker login`；`load` 仅允许单个平台并导入本机 Docker，可随后 `docker compose up -d --no-build --pull never`；`cache` 只构建，不推送或导出镜像。脚本显式指定构建器，不改变全局选中的 Buildx 构建器。amd64/arm64 跨架构构建需要构建器具备相应原生节点或 QEMU 支持。

`.build.env` 中 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 及小写别名用于宿主机 Docker CLI；`BUILD_*_PROXY` 用于构建阶段 RUN，并配置新建 BuildKit 容器的代理。容器内不能用宿主机 `127.0.0.1`，通常改为 `host.docker.internal` 且代理需允许容器访问。已有构建器不会被自动重建，修改其拉取代理需手动配置该构建器；Docker daemon 自身拉取 BuildKit/基础镜像的代理仍由 Docker 设置控制。[Docker 代理构建参数](https://docs.docker.com/build/building/variables/#proxy-arguments)不会写成最终镜像的 `ENV`；私有仓库登录使用 Docker 凭据管理，不在 env 中填写登录密码。

运行期媒体下载代理独立配置在 `.env`；它不自动代理浏览器或 OneBot 连接。`.dockerignore` 使用白名单，登录态、所有 env、令牌、抓包和缓存不进入构建上下文。示例 env 的每个变量都附有用途、范围或单位说明。

## 更名后的兼容性

项目名称为 **MeloFox（音狐）**，包名及 `get_version_info.app_name` 为 `melofox`；协议版本继续为 `11`。管理台、启动日志、`#dy` 回复与 HTTP 健康接口均使用新名称，新示例的镜像名为 `melofox`。

已有部署继续使用原配置：Compose 服务名和默认容器名 `douyin-onebot`、数据卷名 `douyin-onebot-data`、构建器名 `douyin-onebot-builder`、`DOUYIN_ONEBOT_*` 环境变量，以及原数据目录和浏览器主题偏好键均保留。因此，`docker compose exec` 仍使用 `douyin-onebot` 服务名。已有 `.env` / `.build.env` 中的仓库地址和代理值不自动改写；更换镜像仓库时自行同步两份文件的 `IMAGE_NAME` / `IMAGE_TAG`。
