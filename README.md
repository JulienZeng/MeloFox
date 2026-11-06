<picture>
  <source media="(prefers-color-scheme: dark)" srcset="web/public/logo-dark.svg">
  <img src="web/public/logo.svg" width="80" height="80" alt="MeloFox 音狐图标">
</picture>

# MeloFox · 音狐

**连接抖音与 OneBot 11 的消息网关。**

MeloFox 将抖音群聊和已有私聊接入支持 OneBot 11 的机器人应用，提供消息收发、事件上报、会话查询和网页管理台。名称由 Melody（旋律）与 Fox（狐狸）组成。

**本项目支持 OneBot 11。** 适配范围以 OneBot 11 与抖音共有能力为准；无法映射的接口或参数明确返回失败。

[快速开始](#快速开始) · [Docker 部署](#docker-部署) · [接入机器人](#接入机器人) · [接口与兼容清单](guide/onebot11.md) · [部署进阶](guide/deployment.md)

## 功能与范围

| 能力 | 说明 |
| --- | --- |
| 消息收发 | 文本、图片、视频、引用、提及、表情，以及有对应原生能力的卡片和合并转发 |
| 消息接收 | 普通语音与文件下载；语音可经 ffmpeg 转换格式 |
| 会话与查询 | 已有私聊、群聊、成员资料、历史消息、已读状态、发送结果查询 |
| 群管理 | 已适配群名、名片、管理员、禁言、踢人、退群及已有管理群的入群申请；以账号权限和业务回执为准 |
| 事件与通道 | HTTP、反向 HTTP、正向 WebSocket、反向 WebSocket；消息、可映射通知、请求、心跳及生命周期 |
| 运行管理 | 扫码登录、通道配置、状态查看、自动重连、消息缓存、磁盘事件队列与媒体缓存 |
| 内置命令 | `#dy` 在原会话回复版本、平台和运行时间，命令及回复回显不传给下游机器人 |

私聊只向**已有会话**发送，不主动创建陌生人会话。普通文件、语音发送仍因上游业务拒绝而暂缓；加密语音、闪照及无对应映射的 QQ 专属能力当前不支持。OneBot 的好友列表在此表示已有私聊联系人，不代表抖音完整关注关系。

群管理、申请审批及部分原生消息类型已完成代码适配与自动化测试，真实账号权限和手机端表现仍需验收。完整接口、参数边界及消息段见[OneBot 11 接入指南](guide/onebot11.md)，测试与实机验收范围见[验证状态](guide/verification.md)。

## 快速开始

本机运行需要 **Node.js 20.12+、pnpm、Chromium、ffmpeg / ffprobe**。也可直接选择下方 Docker 部署，由镜像提供运行依赖。

在项目目录执行：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
# 仅首次创建；已有 .env 时直接编辑
cp .env.example .env
```

启动后在控制台「网络配置」设置通道地址和令牌。本机 Node 连接同一台机器上的机器人时，反向 WebSocket 地址可填写 `ws://127.0.0.1:6700/onebot/v11/ws`，以机器人实际配置为准。需要预置时可取消 `.env` 中相应首次导入项的注释。Linux 可用 `pnpm exec playwright install --with-deps chromium` 安装浏览器及系统依赖；ffmpeg / ffprobe 需另外安装。

生产运行先打包：

```sh
pnpm build
pnpm start
```

打开 [MeloFox 管理台](http://127.0.0.1:3000)，使用默认账号 **`melofox`** 登录。初始密码沿用当前管理令牌：优先使用 `WEB_TOKEN`，未配置时读取或自动生成 `data/console/admin-token`。在本机查看：

```sh
cat data/console/admin-token
```

首次登录后必须设置新密码，账号可选修改；完成前只能修改凭据或退出，不能访问管理功能。之后可在「设置 → 管理账号」修改账号和密码。新密码不会被重启或 `WEB_TOKEN` 覆盖。

进入管理台后，在「抖音账号」获取二维码，用抖音 App 扫码并确认，再到「网络配置」连接机器人。管理账号密码与 OneBot Access Token 分别配置。

## Docker 部署

在安装了 Docker Compose 的环境中执行；已有 `.env` 时跳过复制，按注释修改配置：

```sh
cp .env.example .env
docker compose config --quiet
docker compose build
docker compose up -d --no-build --pull never
docker compose exec douyin-onebot cat /data/console/admin-token
```

默认构建本地镜像 `melofox:latest`，基于 Node 24 Debian slim，包含已打包的后端和 Vue 管理台，以及无头模式使用的 Chromium headless shell、ffmpeg / ffprobe。仅安装所需浏览器及系统依赖，容器以非 root 用户运行。

| 服务 | 默认宿主机地址 | 用途 |
| --- | --- | --- |
| 管理台 | `127.0.0.1:3000` | 登录、通道配置与状态查看 |
| OneBot HTTP | `127.0.0.1:3001` | API 调用与媒体读取 |
| 正向 WebSocket | `127.0.0.1:3002` | 启用该通道后供机器人连接 |

端口映射由 `.env` 的 `*_BIND` / `*_PORT` 配置。远程访问时设置相应绑定 IP、鉴权令牌及机器人可达的媒体公开地址。反向连接宿主机上的机器人可使用 `host.docker.internal`。

为兼容现有部署，Compose 服务名仍为 `douyin-onebot`，默认数据卷仍为 `douyin-onebot-data`。卷内 `/data` 保存登录资料、通道配置、消息和媒体缓存。`docker compose down` 保留数据，`down -v` 会删除数据卷。**旧版 `./data` 绑定目录不会自动迁入命名卷**，升级前按[数据迁移说明](guide/deployment.md#docker)处理。

应用运行参数在首次启动时从 `.env` / YAML 导入，缺失项使用默认值，然后保存为 `/data/config/settings.json`（本机为 `data/config/settings.json`）。后续启动只读取保存的设置，不再从 env 覆盖。日志、消息处理、缓存、超时和下载代理在控制台「设置」修改，保存后重启服务生效；OneBot 地址与令牌在「网络配置」即时管理。Compose 仅保留容器部署参数和首次初始化的固定路径/端口，需要 Docker Compose 2.24+。

多架构构建和代理参数放在 `.build.env`，参考 [`.build.env.example`](.build.env.example)。脚本支持 `push`、`load`、`cache` 及 `--dry-run`；使用方法见[镜像构建与代理](guide/deployment.md#镜像构建与代理)。若使用自己已发布的镜像，在 `.env` 设置对应仓库和标签，执行 `docker compose pull` 后启动即可。

## 自动发布

GitHub Actions 在 main 推送和 PR 时检查构建；推送 `v1.2.3` 这类 tag 后，自动发布 GitHub Release、编译后的 `.tar.gz` / `.zip` 安装包，以及 Docker Hub 的 amd64 / arm64 镜像。安装包、镜像和管理台版本统一取自 tag；正式版更新 `latest`，预发布版保持独立。

使用前在 GitHub 仓库配置 Variables：`DOCKERHUB_USERNAME`、`DOCKERHUB_IMAGE`，以及 Secret：`DOCKERHUB_TOKEN`。配置、发布和升级步骤见[自动构建与发布](guide/releasing.md)。

## 接入机器人

在机器人端选择 **OneBot 11** 适配器，在 MeloFox「网络配置」中配置相同的地址和 Access Token。支持以下方式：

| 通道 | 连接方向 |
| --- | --- |
| HTTP | 机器人调用 MeloFox 的 API，读取媒体 |
| 正向 WebSocket | 机器人连接 MeloFox，收事件、调 API |
| 反向 WebSocket | MeloFox 连接机器人，收发事件与 API 请求 |
| 反向 HTTP | MeloFox 向机器人 POST 事件，支持签名和快速操作 |

使用 AstrBot 等应用时，可选反向 WebSocket，并保留一个 HTTP 通道用于媒体读取。反向 HTTP 的签名密钥与 API Access Token 用途不同。

配置时注意：

- **媒体地址必须从机器人所在环境可访问。** `127.0.0.1` 指当前机器或容器；`0.0.0.0` 是监听地址，不能作为对外媒体地址。
- **已有通道通过管理台修改。** 启用管理台时，YAML / env 通道仅在首次初始化导入，之后以持久化配置为准。
- **ID 使用字符串。** 抖音 UID、群 ID、消息 ID 可能超过 JavaScript 安全整数范围。
- **事件按 ID 去重。** 磁盘队列提供至少一次交付；消息发送结果不确定时先查询，不自动整批重发。

`get_version_info` 返回 `app_name: "melofox"`、`protocol_version: "11"`。`get_douyin_*` 等扩展用于表达抖音特有能力，详见[接口文档](guide/onebot11.md)。

## 配置文件

| 文件 | 用途 |
| --- | --- |
| [`.env.example`](.env.example) → `.env` | 容器部署与应用首次导入配置，每个变量均有用途与范围注释 |
| [`.build.env.example`](.build.env.example) → `.build.env` | 镜像仓库、平台、输出方式和构建代理 |
| [`config/config.example.yaml`](config/config.example.yaml) | 应用默认配置，可通过 `DOUYIN_ONEBOT_CONFIG` 指定其他文件 |

仅首次导入遵循**进程环境变量 > env 文件 > YAML > 内置默认值**。本机默认读 `.env`，不存在时兼容 `.env.astrbot`；首次导入可通过 `DOUYIN_ONEBOT_ENV_FILE` 指定其他文件。之后以 `settings.json` 和控制台保存的通道配置为准。Docker 的端口映射、数据卷与容器资源限制仍由 Compose 管理。

登录资料、令牌和数据目录应持久保留；`.dockerignore` 会将它们排除在镜像构建上下文之外。更名沿用原配置变量和目录，已有部署无需重建登录资料，详见[更名兼容说明](guide/deployment.md#更名后的兼容性)。

## 开发与打包

```sh
pnpm dev        # 后端 + 管理台 Vite 热更新，共用 3000 端口
pnpm typecheck  # 后端与 Vue 模板类型检查
pnpm build      # 编译后端并打包管理台
pnpm test       # 自动打包前端后运行测试
```

管理台按运行概览、抖音账号、网络配置、日志和设置组织，提供通道搜索、实时日志以及管理账号修改。界面保留狐橙配色，操作区直接展示状态和配置。

在「设置」保存修改后，可点击「重启服务」。MeloFox 会关闭通道和 Chromium、保存缓存，随后启动新进程并加载已保存的设置；本机与 Docker 均可使用。页面等待服务恢复后返回管理台登录页，已保存的抖音登录资料继续保留。

日志页与终端使用同一份后端日志，每秒增量更新，支持级别筛选、关键词搜索、暂停显示、自动滚动和下载当前筛选结果。服务端仅保留本次运行最近最多 1,000 条日志（同时限制为约 4 MiB），重启后重新开始；需要长期留存时使用 Docker 日志或进程管理器的日志配置。「清空视图」只影响当前页面。

默认日志格式为 `时间 [级别] [模块] 内容`，收发消息显示方向、私聊或群聊对象与最多 180 字符的摘要，媒体显示类型。在「设置 → 消息与日志」关闭消息摘要可隐藏内容，只显示对象和类型；令牌、Cookie、密码等凭据字段统一脱敏。该页面还可将终端日志切换为 JSON，并统一调整终端与管理台的日志级别；保存后重启服务生效。

概览展示当前抖音账号的昵称与头像、完整系统信息、CPU 总体及逐核使用率、MeloFox 主进程和 Chromium 进程组的 CPU / 常驻内存、JS 堆、磁盘、网卡及四类通道统计。通道总数等于就绪、等待、异常、停用四类之和。资源指标每 2 秒采样，页面每 4 秒刷新；不可用或过期的数据会明确标示。深色主题使用深墨色卡片、明亮文字与狐狸橙强调色，支持毛玻璃和减少透明度偏好。统计范围见[概览指标说明](guide/deployment.md#概览指标)。

页面组织参考 [NapCat WebUI](https://github.com/NapNeko/NapCatQQ/tree/main/packages/napcat-webui-frontend) 和 [SnowLuma WebUI](https://github.com/SnowLuma/SnowLuma/tree/main/packages/webui)，按 MeloFox 的抖音会话与 OneBot 通道功能实现。

管理台使用 Vue 3、TypeScript 和 Vue Router。`pnpm dev` 支持前端热更新；修改后端或 Vite 配置需要重启；运行参数在设置页保存后重启生效，旧 env 不再覆盖。生产环境由 Node 直接提供 `dist/web/public/` 静态资源，无需单独运行 Vite 或依赖外部 CDN。页面使用 Hash 路由，支持刷新和浏览器前进、返回。

部署时必须携带构建产物。将产物复制到其他机器、仅安装生产依赖的步骤见[本机生产部署](guide/deployment.md#本机生产部署)。

```text
src/                 网关、抖音适配、OneBot 11 与管理 API
web/                 Vue 管理台
proto/               抖音消息协议
config/              默认应用配置
docker/              容器健康检查
guide/               接口、部署和验证文档
tests/               自动化回归测试
dist/                构建产物
```

## 参考项目

- [OneBot 11](https://github.com/botuniverse/onebot-11)：通信、API、消息段与事件规范。
- [DouYin_Spider](https://github.com/cv-cat/DouYin_Spider/tree/fc8b9c2490a9561265425c26058290f01c064eda)：抖音私信消息结构和身份安全接口参考。
- [NapCatQQ](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-plugin-builtin/index.ts#L303-L375)：内置状态命令的交互参考。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
