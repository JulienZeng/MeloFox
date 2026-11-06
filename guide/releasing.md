# MeloFox · 自动构建与发布

[返回 README](../README.md)

## 一次性配置

将本项目（包括 `.github/workflows/` 和 `scripts/`）推送到 GitHub，并启用仓库的 Actions。两个 workflow 已纳入版本管理；本地 `tests/` 仍不上传。

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variables | `DOCKERHUB_USERNAME` | 用于登录 Docker Hub 的账号名 |
| Variables | `DOCKERHUB_IMAGE` | 完整镜像仓库，例如 `your-name/melofox`，不要填写 `https://`、`docker.io/` 或 tag |
| Secrets | `DOCKERHUB_TOKEN` | Docker Hub 访问令牌，授予目标仓库 Read & Write 权限 |

先在 Docker Hub 创建对应镜像仓库。令牌在 Docker 账号的 **Account settings → Personal access tokens** 创建，填入 GitHub Secret，不写入代码或 env 示例。Docker Hub 关联 GitHub 的源代码授权与本工作流的镜像推送鉴权分别配置，工作流使用上述令牌登录。

发布 GitHub Release 使用 Actions 自动提供的 `GITHUB_TOKEN`，无需另建 GitHub PAT。只有发布及更新 Latest 的 job 获取 `contents: write`；组织策略需允许此权限。PR 构建不读取发布 Secret。

镜像使用 `ubuntu-24.04` 和 `ubuntu-24.04-arm` 原生 runner 分别构建 amd64 / arm64，避免跨架构模拟编译；仓库须能使用这两个 GitHub 托管 runner。Docker 构建缓存按架构隔离。

## 发布一个版本

先提交并推送待发布代码，再为该提交创建 tag：

```sh
git tag -a v1.2.3 -m "MeloFox v1.2.3"
git push origin v1.2.3
```

推送 tag 会自动触发 **Release**。支持 `v主版本.次版本.修订版本` 及 `v1.2.3-beta.1` 这类预发布格式；拒绝前导零、空格和 `+` 构建元数据。工作流也可在 Actions → Release → Run workflow 中填写一个已存在的 tag 手动触发；会校验真实 tag 和检出提交一致，不能用分支名代替版本 tag。

版本号以 tag 为准：工作流在临时构建目录将 `package.json.version` 改为去掉 `v` 的版本，不向源码仓库创建版本提交。因此推送 `v1.2.3` 后，下列版本一致：

| 对象 | 版本 |
| --- | --- |
| GitHub Release | `v1.2.3` |
| Node.js 安装包内 `package.json` | `1.2.3` |
| 管理台、`#dy`、`get_version_info.app_version` | `1.2.3` |
| Docker Hub 镜像 tag | `1.2.3` 和 `v1.2.3` |
| 镜像 OCI version 标签 | `1.2.3` |

源码仓库中的 `package.json` 保留开发版本；GitHub 自动生成的 Source code 压缩包也保持源码原样。运行部署请使用本工作流附加的安装包或镜像。

## 自动执行的内容

**CI** 在 main 推送、Pull Request 和手动触发时运行：使用 Node.js 20 / 24，锁定依赖安装，编译后端与 Vue 管理台，检查 Compose 和构建脚本，并生成安装包、验证 SHA256 校验和。`tests/` 保持本地，CI 不调用缺少测试文件的 `pnpm test`。

**Release** 按顺序执行：

1. 校验 tag、目标镜像仓库和发布凭据是否齐全，将版本写入构建目录，编译并打包。
2. 原生构建 `linux/amd64`、`linux/arm64` 镜像，先按 digest 推送；在各自架构的实际镜像内校验 OneBot 11 版本信息并启动、关闭一次 Chromium。
3. 两个架构通过后，合并多架构镜像并创建两个精确版本 tag；验证安装包校验和，把所有附件上传到 Release 草稿，再公开发布。
4. 正式版本发布成功后，串行更新 Docker `latest` 与 GitHub Latest，按已经发布的最高正式版本选择。补发旧 tag 不会让 latest 降级；预发布版本不更新 latest。

第三方 Actions 固定到提交 SHA，依赖使用 `pnpm-lock.yaml`。Docker 构建使用工作目录作为 context，确保读取工作流写入的版本。两架构镜像有相同版本、源码提交标签；Release 附件记录提交及最终镜像 digest。

## 下载与部署

每个 Release 包含：

- `melofox-1.2.3.tar.gz`、`melofox-1.2.3.zip`：编译后的通用 Node.js 包，包含后端、管理台、协议文件、依赖清单、示例配置、运行说明和 MIT 许可证。
- `docker-compose.yml`、`melofox.env.example`：用于直接拉取该版本镜像；将后者复制为 `.env`。发布用 Compose 已移除本地 build，避免下载后缺少源码或 Dockerfile。
- `build-info.json`：版本、tag、源码提交及镜像仓库。
- `image-digest.txt`：合并后的多架构镜像固定引用。
- `SHA256SUMS`：全部附件的 SHA256 校验和。

安装包采用文件白名单，不包含 `.env`、管理凭据、抖音登录资料、运行数据、测试、源码、`node_modules` 或浏览器。它不是包含 Node.js 的独立可执行程序：本机需要 Node.js 20.12+（推荐 24）、pnpm 9.15.3、Chromium 及 ffmpeg/ffprobe。

本机解压后执行：

```sh
pnpm install --prod --frozen-lockfile
pnpm exec playwright install chromium
pnpm start
```

Linux 安装浏览器及系统依赖时可使用 `pnpm exec playwright install --with-deps chromium`。无需重新编译。

Docker 用户下载 Compose 和 env 示例后执行：

```sh
cp melofox.env.example .env
# 根据部署需要调整 .env 的端口、数据卷等参数
docker compose pull
docker compose up -d --no-build
```

已有部署不要覆盖现有 `.env` 和数据卷。将 `IMAGE_NAME` 设为配置的 Docker Hub 仓库，将 `IMAGE_TAG` 改为目标版本后更新即可；使用精确版本可以避免自动跟随 latest。

下载全部附件后，在 Linux 执行 `sha256sum --check SHA256SUMS`，macOS 执行 `shasum -a 256 --check SHA256SUMS`。只下载部分附件时，只校验对应条目。

## 失败与重试

缺少仓库变量、Secret、tag 不合法或已发布时，会在构建镜像前报错。镜像构建或 Chromium 检查失败时，不发布 Release 和正式版本 tag；上传附件中断时，Release 保持草稿。在 Actions 中优先选择 **Re-run failed jobs**，复用当前运行已经成功的产物。中间产物保留 14 天；过期后需重新运行构建。

镜像仓库和 GitHub 是两个独立服务，无法做跨平台原子发布。若合并镜像后上传 Release 失败，精确版本镜像可能已存在，但 latest 尚未更新；重试可完成草稿。已公开的版本拒绝整套覆盖重发，应使用新的 tag。只更新 latest 失败时，重跑该 job 即可。

不要移动已发布 tag 到其他提交。工作流校验已有草稿的提交；正式发布的安装包和镜像应按版本保持不变。版本发布不会自动重启已部署的服务。

参考：[Docker 多架构 GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)、[Docker 访问令牌](https://docs.docker.com/security/access-tokens/)、[GitHub Release API](https://docs.github.com/en/rest/releases/releases)。
