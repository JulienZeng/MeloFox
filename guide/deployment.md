# MeloFox · 部署与配置

[返回 README](../README.md)

## 本机生产部署

GitHub Release 提供已经编译的通用 Node.js 安装包，Docker Hub 提供对应 tag 的多架构镜像；自动发布配置见[自动构建与发布](releasing.md)。下载安装包后直接安装生产依赖并启动，无需再次构建。

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

## 首次初始化与控制台设置

应用参数只在首次启动时导入：进程环境变量 > `.env`（本机没有时回退 `.env.astrbot`）> 可选 YAML > 内置默认值。未提供 env 或 YAML 也可启动。首次导入可通过进程环境中的 `DOUYIN_ONEBOT_ENV_FILE` 选择 env，通过 `DOUYIN_ONEBOT_CONFIG` 选择 YAML。参数示例见 [`.env.example`](../.env.example)。

首次启动自动生成 `data/config/settings.json`，Docker 中为 `/data/config/settings.json`。**此文件存在后，后续启动直接读取它，不再加载应用 env 或 YAML；修改旧环境变量不会覆盖设置。** 升级已有部署时自动导入一次当时的配置，保留现有管理账号、通道与抖音登录资料。

控制台「设置」提供消息与日志、连接与超时、媒体缓存与转换、消息缓存与队列、下载代理、高级设置。修改后点击「保存设置」，再点击「重启服务」应用；有未保存的修改时须先保存或撤销。多个页面同时编辑时，旧版本提交会被拒绝，避免覆盖较新的设置。

「重启服务」适用于 `pnpm dev`、`pnpm start`、`node dist/index.js` 及 Docker。启动入口保留一个轻量启动进程，收到管理台请求后，业务进程先关闭通道与 Chromium、写入缓存，再退出；启动进程等待其退出后创建新进程，重新加载已保存的设置。容器保持运行，无需挂载 Docker socket。重启会短暂中断消息连接并使管理台登录会话失效，页面自动等待恢复后返回登录页，抖音登录资料不被清除；90 秒内未恢复时可继续等待，并查看终端或容器日志。清理失败时不会直接创建新进程，启动/运行异常仍交由 Docker 或外部进程管理器处理。

也可使用 `docker compose restart douyin-onebot` 或在本机停止后重新启动。Ctrl+C 和容器停止信号会关闭整个服务，不会触发自动重启。OneBot 的 `set_restart` 仍只重建抖音网关会话，不代替管理台的完整服务重启。

管理台监听地址、数据目录和浏览器模式属于首次初始化参数，在「部署信息」只读显示。持久配置目录默认固定为项目目录下的 `data/config`；需要自定义时，在启动进程中持续设置 `MELOFOX_CONFIG_DIR=/实际目录`，不要放进 `.env`，因为后续启动不会读取 `.env`。Docker 已将该定位变量固定为 `/data/config`。这是每次启动用于定位配置文件的唯一应用环境变量。

配置目录与文件分别以 0700 / 0600 权限创建，保存采用原子替换；损坏或不兼容的文件会使启动报错，不会悄悄使用 env 覆盖。备份时同时保留 `settings.json` 和原有持久目录。若需重新导入，先停止服务，备份并移走该文件，再重新启动；保留 `channels.json` 和账号文件可继续沿用原有通道和登录状态。

OneBot 的地址、端口、令牌、签名密钥、启用状态仍在「网络配置」管理，修改即时应用。首次导入的启用通道保存为 `WEB_DATA_DIR/channels.json`，此后以该文件为准。已有通道不会被首次生成运行设置的过程覆盖。

- **HTTP**：提供 OneBot API 与原有调试接口。
- **正向 WebSocket**：本服务监听，应用主动连接。
- **反向 WebSocket**：本服务主动连接应用，适用于 AstrBot。
- **反向 HTTP**：向应用 POST 事件，支持 HMAC-SHA1 签名、磁盘队列重试、心跳、启用/停用生命周期，以及回复/撤回自身消息的快速操作。该通道中的签名密钥用于 `X-Signature`；Access Token 用于其他通道的 API 鉴权。

### 独立媒体服务

媒体服务在「设置 → 媒体服务」管理，默认端口 `3001`，应用启动后即监听，独立于 OneBot 通道和抖音会话。关闭全部 OneBot HTTP 通道、退出抖音或会话重连时，已有且未过期的缓存仍可下载。OneBot HTTP 不再注册 `/media/` 路由，媒体服务也不提供 OneBot API 或管理 API。

- **监听地址和端口**：Docker 默认 `0.0.0.0:3001`，本机默认 `127.0.0.1:3001`。不能与管理台或启用的 OneBot HTTP / 正向 WS 通道重复。
- **媒体公开地址**：接收端真正能访问的根地址；同网容器可填写 `http://melofox:3001` 或 `http://douyin-onebot:3001`，跨机器填写宿主机 IP/域名和映射端口。支持反向代理路径前缀，代理需将该前缀移除后转发到媒体服务。
- **下载签名密钥**：可选，至少 16 个字符。配置后返回链接自动附带针对该资源的 HMAC 签名；支持直接 GET、HEAD 和视频 Range 请求，不需要接收端添加 OneBot Authorization 头。密钥不会出现在链接中，签名随缓存删除/过期失效，修改密钥后旧签名立即失效。留空允许持有资源链接者下载。
- **媒体缓存**：在「设置 → 媒体缓存」管理容量、TTL 和转换，配置存储于 `media.cache`。以上设置保存后重启应用生效。媒体服务启动失败时，管理台仍可访问，媒体服务页显示运行状态和错误，可修正后重启。

首次升级会先保留 `settings.json.v1.bak`，再将 `settings.json` 从版本 1 原子迁移到版本 2，保留缓存目录、缓存索引、登录状态和通道令牌；已有通道文件中的媒体地址随后移除。迁移以第一个已启用 HTTP 通道的保存值为准，缺失时使用原配置。直连地址使用新媒体端口，外部反向代理的域名、端口和路径保持原值；默认 `3001` 被现有监听占用时，从 `3002` 起依次跳过已配置的监听端口。已有 OneBot 通道不会删除或改端口，已保存的独立媒体配置也不因默认值变化而覆盖。迁移之后不再从 env 或 OneBot 通道覆盖媒体配置。

**升级部署时需同步端口：** 查看「设置 → 媒体服务」迁移后的监听端口，将 Compose 的 `MEDIA_TARGET_PORT` 设为该端口，`MEDIA_PORT` 设为可用的宿主机端口，并保留已有 OneBot 通道所需映射。同网容器直接连接媒体容器端口即可；反向代理将 `/media/` 上游切换到该端口。指向旧 OneBot HTTP 入口的媒体链接不再提供下载，重新接收或通过 `get_image` / `get_record` / `get_file` 查询可获取新地址；已有缓存文件不会因此删除。迁移不会自动修改服务器上的 Compose 或代理配置。

旧 `ONEBOT_HTTP_PUBLIC_BASE_URL` 仅保留首次导入兼容，新部署使用 `MEDIA_PUBLIC_BASE_URL`。媒体监听端口在控制台修改后，应同步调整 Compose 的 `MEDIA_TARGET_PORT` 和公开地址；`MEDIA_PORT` 控制宿主机映射端口。关闭媒体服务会停止 HTTP 下载，已注册缓存仍可用于本机 OneBot 发送。

管理台默认监听 `127.0.0.1:3000`，使用 HttpOnly / SameSite 会话 Cookie，登录有效期 12 小时。首次导入时设置 `WEB_ENABLED=false` 可关闭管理台；此模式仍从持久化设置启动，使用其中保存的初始 OneBot 通道配置。

## 管理账号与首次登录

默认账号为 `melofox`。首次初始化使用当前 `WEB_TOKEN` 作为初始密码；未设置时读取 `WEB_DATA_DIR/admin-token`，该文件不存在才自动生成。已有令牌部署升级后也使用这套账号密码登录。

首次登录只授予限时改密会话，刷新或直接调用管理 API 都不能绕过。必须设置与当前密码不同的 8–128 位新密码；账号可保持不变，或改为 3–32 位字母、数字、下划线、点和短横线。完成后进入控制台。

账号及加盐 scrypt 密码哈希存放在 `WEB_DATA_DIR/admin-credentials.json`，文件权限为 0600。已有凭据优先，重启、重新部署、修改 `WEB_TOKEN` 都不会覆盖已设置的账号密码；初始令牌也不再用于登录。Docker 中该文件位于 `/data/console/`，随现有数据卷持久化。

日常修改在「设置 → 管理账号」进行，需要当前密码，保存后其他登录会话失效。浏览器使用 HttpOnly / SameSite 会话 Cookie，不把密码存到 localStorage。完整会话有效期 12 小时，首次改密会话有效期 10 分钟。

忘记账号或密码时，停止服务，在服务端私下备份并移走 `admin-credentials.json`，确认或重新设置 `admin-token` 中的初始密码后重新启动（已有运行设置不会重新读取 `WEB_TOKEN`），再用 `melofox` 完成首次改密。仅处理该凭据文件，保留登录资料、通道和缓存目录。损坏的凭据文件会使管理服务启动失败，不会自动恢复初始密码。

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

## 日志与连接排查

本机和 Docker 默认使用易读文本日志，显示时间、级别、消息及错误详情；非终端输出不带 ANSI 颜色。日志级别、格式和消息摘要在「设置 → 消息与日志」调整，保存后重启服务生效。需要对接日志采集器时选择 JSON。已有设置不会被 Compose 的旧日志环境变量覆盖。

`ECONNREFUSED` 表示反向 WebSocket 目标地址/端口拒绝连接。请在管理台「网络配置」检查反向 WS 地址：同一自定义 Docker 网络可使用机器人服务名与容器内监听端口；不同网络可使用 `host.docker.internal` 与机器人发布到宿主机的端口，例如 `6189:6189` 对应 `ws://host.docker.internal:6189/ws`（路径以机器人配置为准）。机器人必须启动对应 WS 服务，路径和 token 也需匹配。尚未配置机器人时可先禁用该通道；已有通道由管理台持久化，修改 `ONEBOT_REVERSE_WS_URL` 不会覆盖它。连接失败仍按重连间隔重试，相同错误每分钟汇总一次，错误变化或连接恢复会立即记录。通道卡片显示最近一次失败原因及排查方向，连接恢复后清除。

`抖音 IM 请求未完成` / `Failed to fetch` 表示浏览器中的抖音接口请求失败，不能仅凭这条错误判断为未登录或浏览器缺失。先检查管理台抖音登录/验证状态，再检查容器到 `www.douyin.com`、`imapi.douyin.com` 的 DNS、HTTPS 及网络访问；「设置 → 下载代理」当前仅用于出站媒体 URL 下载，不会代理 Chromium。错误详情会保留具体接口及原始原因。管理台已启动时，这类会话错误不会关闭管理服务。

## 登录与会话恢复

默认使用无头 Chromium，不弹出浏览器窗口。后台 Chromium 用于抖音消息收发，以及在官方站点会话中执行登录 API（保留官方 Cookie 与请求 SDK）。常规扫码使用接口返回的二维码和状态。遇到支持的短信二次验证时，管理台显示发送验证码及校验表单；只有点击发送才请求短信，60 秒内不重复请求。后台保留官方 SDK 的原扫码事务，验证成功后由外部验证处理器继续请求。随后选择是否在抖音保存快捷登录信息，调用官方 `setTrust`（保存为 1、不保存为 2），成功后保存网关会话。两种选择都会保留本网关的当前会话以便重启恢复，退出登录可清除。SDK 尚未加载、上行短信、滑块等情况仍可点击「官方页面辅助验证」，按需操作官方页面，完成后点击「保存登录」。原生表单已通过本地模拟协议和真实 Chromium UI 验证，真实账号完整流程仍待联调。画面仅在操作或刷新时更新，闲置 10 分钟关闭。

管理服务独立于抖音会话，后台会话启动失败时仍可打开网页管理配置。登录 API 在后台会话就绪后可用。登录凭据保存在 `WEB_DATA_DIR/douyin-session.json`，文件权限为 0600；下次启动先恢复凭据再加载消息服务。`browser.userDataDir` 同时保留 Chromium 运行资料。二维码、手机确认及官方验证由用户完成。官方返回风险验证等错误时，管理台显示原始错误码和说明，不把它当作登录成功。

## Docker

需要 Docker Compose 2.24+，以支持可选的 `env_file`。Compose 通过可选 `.env` 导入首次配置，不再逐项列出业务参数；没有 `.env` 时直接使用默认值。镜像、端口映射、数据卷、共享内存和日志轮转仍由 Compose 管理。

Dockerfile 基于 `node:24-bookworm-slim`，使用多阶段构建：Node 后端及 Vue 管理台固定在构建机原生架构（`BUILDPLATFORM`）编译，生成跨架构通用的 JS 和静态资源；生产依赖分别在目标架构安装。运行镜像只复制对应架构的生产依赖、`dist/`、协议及配置，不复制编译阶段的 `node_modules`。

容器沿用无头模式，只安装其实际使用的 Chromium headless shell 及对应系统依赖，保留 ffmpeg/ffprobe、中文字体和 tini。浏览器通过生产依赖中的 Playwright CLI 下载，`PLAYWRIGHT_VERSION` 与锁文件不一致时构建失败；不再继承包含 Firefox、WebKit 和完整 Chromium 的通用镜像。此方式保持现有 `headless: true`、未设置 `channel` 的启动行为，管理台截图与官方页面辅助验证仍可使用，参见 [Playwright headless shell](https://playwright.dev/docs/browsers#chromium-headless-shell)。Docker 镜像用于无头运行，本机的有界面运行方式不受影响。

容器内默认以 root 运行，直接读写绑定目录。Compose 已设置运行用户，可兼容默认使用 `pwuser` 的旧镜像，无需部署者另行设置 UID/GID。`NODE_IMAGE` 可在 `.build.env` 中覆盖为同一 Node Debian slim 镜像的可信镜像源或固定 digest；旧 `.build.env` 未配置时使用默认值。apt 下载包缓存在 BuildKit 中供重试复用，不进入运行镜像；构建结束清理 apt 索引及其他下载缓存。

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

打开 http://127.0.0.1:3000，使用 `melofox` 和初始密码登录并完成改密，再在「抖音账号」扫码。Compose 默认仅映射管理台 3000 和媒体服务 3001，网络配置初始为空，不预置任何 OneBot 通道或映射。`.env` 的 `WEB_PORT` / `MEDIA_PORT` 控制宿主机端口，`WEB_BIND` / `MEDIA_BIND` 控制宿主机绑定 IP；首次导入时，管理台和媒体服务的监听地址、内部端口、数据目录使用 Compose 中的固定值，ffmpeg/ffprobe 路径可在设置页调整。容器强制无头运行。管理端口默认只绑定宿主机回环地址；远程访问按需修改 `WEB_BIND` 并完成管理账号的首次改密。

反向 WS/HTTP 地址必须能从容器访问。机器人在宿主机时可用 `host.docker.internal`；同一个 Docker 网络的机器人可用服务名。「设置 → 媒体服务 → 媒体公开地址」是机器人读取媒体的地址，需要从机器人所在环境访问验证：跨机器填宿主机 IP/域名和映射端口；同网容器可用 `http://douyin-onebot:3001`。机器人在其他容器时，其 `127.0.0.1` 不代表网关。已有管理台通道以持久化配置为准，改 env 只影响首次导入；容器内新增 HTTP/正向 WS 通道时监听 `0.0.0.0`，使用新端口还需增加 Compose 映射。

所有持久状态绑定到 **Compose 文件同目录的 `./data` → 容器 `/data`**，包含 `config/`、`douyin-profile/`、`media-cache/`、`message-cache/`、`console/`。默认不创建命名卷或匿名卷，不再使用 `DOCKER_DATA_VOLUME`。多实例使用不同部署目录和宿主机端口。

首次启动时，Docker 自动创建 `./data`，应用按需创建各子目录。直接执行 `docker compose up -d` 即可，无需预先执行 `mkdir`、`chown` 或 `chmod`，也没有单独的初始化容器。

`docker compose down` 与 `down -v` 都不会删除绑定的宿主机目录。需要完全重置时，先停止服务，再备份并移走整个 `./data`，下次启动会创建新目录；只删除 `config/` 而保留 `console/` 会留下旧通道和管理账号。

旧部署使用的命名卷（如 `douyin-onebot-data`）不会自动迁移或删除。需要保留旧状态时，停掉旧服务并备份，使用 `docker volume inspect` 确认实际卷，将完整数据复制到新 `./data` 并保留权限；从零部署则保持 `./data` 为空。不要把两个实例的数据混用，旧卷确认不再需要后再单独清理。

健康检查优先检查管理台 HTTP；管理台关闭时依次检查媒体服务和 OneBot HTTP，不把未扫码/IM 离线视为容器故障；所有 HTTP 入口都关闭时跳过探测。`unhealthy` 是诊断状态，Docker 不会仅因该状态自动重启容器；`restart: unless-stopped` 处理进程退出后的重启。`docker compose ps` 查看状态，`docker compose logs --tail=100` 查看日志。共享内存、停止宽限、日志轮转均可通过已注释的 Docker 环境变量调整。

### 镜像构建与代理

首次复制 `.build.env.example` 为 `.build.env`，修改镜像仓库、标签及平台。该文件由 Bash `source` 加载，按文件中注释配置；应用运行参数通过控制台管理，`.env` 仅用于首次导入和容器部署。已有 `.build.env` 可直接补充新参数，不需要覆盖本机仓库或代理值。

```sh
./build-multiarch.sh --dry-run  # 校验参数并预览，代理值脱敏，不调用 Docker
./build-multiarch.sh            # 按 .build.env 构建
# 可指定另一份可信构建配置
BUILD_ENV_FILE=/path/to/build.env ./build-multiarch.sh
```

`BUILD_OUTPUT=push` 构建多平台并推送，需要提前 `docker login`；`load` 仅允许单个平台并导入本机 Docker，可随后 `docker compose up -d --no-build --pull never`；`cache` 只构建，不推送或导出镜像。脚本显式指定构建器，不改变全局选中的 Buildx 构建器。源码编译使用原生架构，避免 ARM Mac 在 amd64 模拟环境运行前端编译工具时出现 `Illegal instruction` / 退出码 132；目标架构的系统包和生产依赖安装仍需要相应原生节点或模拟支持，参见 [Docker 多平台构建](https://docs.docker.com/build/building/multi-platform/#cross-compilation)。

`.build.env` 中 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 及小写别名用于宿主机 Docker CLI；`BUILD_*_PROXY` 用于构建阶段 RUN，并配置新建 BuildKit 容器的代理。容器内不能用宿主机 `127.0.0.1`；Docker Desktop 可使用内置 DNS 提供的 `host.docker.internal`，代理需允许容器访问。Linux Engine 若无法解析该名称，填写构建器可达的宿主机 IP 或代理域名。脚本使用 `docker-container` 驱动，不传入该驱动不支持的 `--add-host host.docker.internal=host-gateway`；遇到相关报错时更新构建脚本后重试，无需重建构建器。

已有构建器不会被自动重建，修改其拉取代理需手动配置该构建器；Docker daemon 拉取 BuildKit 镜像的代理由 Docker 设置控制，BuildKit 拉取基础镜像及推送镜像使用构建器自身的网络与代理。[Docker 代理构建参数](https://docs.docker.com/build/building/variables/#proxy-arguments)不会写成最终镜像的 `ENV`；私有仓库登录使用 Docker 凭据管理，不在 env 中填写登录密码。

运行期媒体下载代理在控制台「设置 → 下载代理」管理，首次启动可从 `.env` 导入；保存后的代理值（包括留空直连）会覆盖旧进程环境，不自动代理浏览器或 OneBot 连接。`.dockerignore` 使用白名单，登录态、所有 env、令牌、抓包和缓存不进入构建上下文。示例 env 的每个变量都附有用途、范围或单位说明。

## 更名后的兼容性

项目名称为 **MeloFox（音狐）**，包名及 `get_version_info.app_name` 为 `melofox`；协议版本继续为 `11`。管理台、启动日志、`#dy` 回复与 HTTP 健康接口均使用新名称，新示例的镜像名为 `melofox`。

Compose 服务名和默认容器名 `douyin-onebot`、构建器名 `douyin-onebot-builder`、`DOUYIN_ONEBOT_*` 环境变量，以及浏览器主题偏好键均保留。持久化现改为 Compose 同目录的 `./data`，旧命名卷请按上方迁移说明处理。`docker compose exec` 仍使用 `douyin-onebot` 服务名。已有 `.env` / `.build.env` 中的仓库地址和代理值不自动改写；更换镜像仓库时自行同步两份文件的 `IMAGE_NAME` / `IMAGE_TAG`。
