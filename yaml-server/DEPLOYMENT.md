# yaml-server 部署与使用说明

本说明面向 `extension/yaml-server` 这个独立后端 API 服务，用于读写 Hugo 导航数据（通常是 `data/*.yml`），并在写入后触发 Hugo 更新（本机编译或远程 Webhook）。

边界说明：本文主要介绍 `yaml-server` 后端部署。  
如果你要部署“带 Hugo 主题网站本体”的整站 Docker 运行，请优先阅读：

- [DOCKER_HUGO_THEME_DEPLOY.md](file:///Library/Github/noisedh/DOCKER_HUGO_THEME_DEPLOY.md)

## 适用场景

- 只部署后端 API（不带 Hugo 本体），由扩展写入服务器文件或触发远程更新
- 部署后端 API + 挂载 Hugo 站点目录（包含 `data/` 与 `content/`），写入后在容器/服务器内直接执行 `hugo`
- 与浏览器扩展 [Nav-manage-extension](file:///Library/Github/noisedh/extension/Nav-manage-extension) 配合：收录、删除、搜索、失效链接自动检测与归档

## 目录约定（非常重要）

`yaml-server` 会把 `BASE_DIR` 作为“站点根目录”，并默认认为数据位于：

- 数据目录：`${BASE_DIR}/data/`（例如 `${BASE_DIR}/data/webstack.yml`）
- 内容目录：`${BASE_DIR}/content/`（例如 `${BASE_DIR}/content/invalidlinks.md`）

如果你只挂载 `data/`，也可以让 `BASE_DIR` 指向一个目录并在其中提供 `data/` 子目录。

## 安全与鉴权

写入类接口必须携带管理员 Token（强烈建议同时配合 HTTPS 与反向代理限制来源）。

- Token 来源：环境变量 `API_TOKEN`
- 请求头：`Authorization: Bearer <API_TOKEN>`

注意：读取类接口（如 `/data`、`/data/:filename`）默认是开放的；若你不希望公开，请在反向代理层做访问控制，或自行将这些路由也加上鉴权。

## 环境变量清单

必选：

- `PORT`：服务监听端口（默认 8990）
- `API_TOKEN`：管理员 Token（扩展端必须一致）
- `BASE_DIR`：站点根目录（默认为仓库根，生产环境建议显式设置）

可选（Hugo 更新）：

- `ENABLE_HUGO=true|false`：是否在本机执行 `hugo`（默认 false）
- `REMOTE_UPDATE_WEBHOOK`：写入后触发的远程更新 Webhook（JSON 形式）

可选（通知/推送）：

- `WEBHOOK_URL`：收录通知 Webhook（非站点更新 Webhook，payload 为收录详情）
- `TELEGRAM_CHAT_ID`、`TELEGRAM_BOT_TOKEN`：Telegram 推送

可选（RSS 与推送文案默认值）：

- `rssChannelTitle`：RSS channel 标题（默认 `NOISE导航收录更新`）
- `rssChannelLink`：RSS channel 链接（默认 `http://www.noisedh.cn`）
- `rssChannelDescription`：RSS channel 描述（默认 `最新更新通知`）
- `rssImageUrl`：RSS image url（默认 `https://s2.loli.net/2025/02/26/a6yMIxOUZjHDghp.png`）
- `rssImageTitle`：RSS image 标题（默认 `NOISE导航`）
- `rssImageLink`：RSS image 链接（默认 `http://www.noisedh.cn`）
- `telegramMessageTitle`：Telegram 推送首行文案（默认 `📢导航站收录更新通知！`）
- `telegramNavText`：Telegram “前往导航”文案（默认 `www.noisedh.cn 或 www.noisedh.link`）

说明：

- 推送配置支持两种来源：环境变量或服务端持久化设置文件 `server_settings.json`
- 当两者同时存在时，服务端会优先使用 `server_settings.json` 中的配置
- 浏览器扩展可在设置页填写推送配置，并在保存时通过受保护接口同步到后端

可选（失效链接检测）：

- `INVALID_404_THRESHOLD`：连续 404 次数阈值（默认 3）
- `INVALID_CHECK_TIMEOUT_MS`：单链接检测超时（默认 8000）
- `INVALID_LINKS_MD`：失效归档文件路径（默认 `${BASE_DIR}/content/invalidlinks.md`）
- `INVALID_LINKS_COUNTS`：失效计数 JSON 路径（默认 `yaml-server/invalidlink_counts.json`）

## 运行方式一：Docker Compose（推荐）

在 [yaml-server](file:///Library/Github/noisedh/extension/yaml-server) 目录下使用仓库自带的 `docker-compose.yml`。

核心点：

- 把你的 Hugo 站点目录（至少包含 `data/`）挂载到容器内的 `/app/hugo`
- 将 `BASE_DIR=/app/hugo`
- 配置 `API_TOKEN`

示例（仅示意，按实际路径改）：

```yaml
services:
  yaml-server:
    environment:
      - PORT=8990
      - BASE_DIR=/app/hugo
      - API_TOKEN=change_me
      - ENABLE_HUGO=false
      - REMOTE_UPDATE_WEBHOOK=
    volumes:
      - /path/to/your/hugo-site:/app/hugo
```

如果你希望“写入后直接在容器内跑 hugo”，需要：

- `ENABLE_HUGO=true`
- 容器内必须有 Hugo（仓库 Dockerfile 已安装）
- 站点根目录内必须能执行 `hugo`（含 `config.toml`/主题等）

若你还需要同时发布静态站点（例如 Nginx 对外服务），请直接按整站教程部署：

- [DOCKER_HUGO_THEME_DEPLOY.md](file:///Library/Github/noisedh/DOCKER_HUGO_THEME_DEPLOY.md)

## 运行方式二：Docker run（适合已构建/已推送镜像）

当你已经构建出镜像（例如 `noise233/nav-manage:v1.4` 或 `noise233/nav-manage:latest`）时，可以直接用 `docker run -d` 启动服务。

核心点：

- 容器内默认以 `BASE_DIR` 作为站点根目录，并读取 `${BASE_DIR}/data/*.yml`
- 若启用失效检测归档，默认会写入 `${BASE_DIR}/content/invalidlinks.md`（因此建议同时挂载 `content/`）
- 写入/删除/失效检测类接口必须携带 `API_TOKEN`

示例（按实际路径修改，推荐持久化 notifications/计数文件）：

```bash
docker run -d \
  --name noisedh-yaml-server \
  -p 8990:8990 \
  -e PORT=8990 \
  -e BASE_DIR=/app/hugo \
  -e API_TOKEN=change_me_to_a_strong_token \
  -e ENABLE_HUGO=false \
  -e REMOTE_UPDATE_WEBHOOK= \
  -e INVALID_404_THRESHOLD=3 \
  -e INVALID_CHECK_TIMEOUT_MS=8000 \
  -e INVALID_LINKS_COUNTS=/app/server/invalidlink_counts.json \
  -e INVALID_LINKS_MD=/app/hugo/content/invalidlinks.md \
  -v /path/to/your/hugo-site:/app/hugo \
  -v /path/to/persist/notifications.json:/app/server/notifications.json \
  -v /path/to/persist/invalidlink_counts.json:/app/server/invalidlink_counts.json \
  --restart=always \
  noise233/nav-manage:v1.4
```

验证是否运行成功（示例）：

```bash
curl "http://localhost:8990/data"
```

失效链接检测接口（需要 Token）：

```bash
curl -X POST "http://localhost:8990/api/invalid-links/check" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"filename":"webstack.yml","limit":40,"offset":0}'
```

## 镜像构建与发布（Docker buildx，多架构）

在 [yaml-server](file:///Library/Github/noisedh/extension/yaml-server) 目录下提供一键脚本 `buildx.sh`，用于封装多架构构建与推送。

默认行为：

- `PLATFORMS=linux/amd64,linux/arm64`
- 同时打 `:latest` 与 `:${IMAGE_TAG}` 两个 tag
- 默认 `PUSH=1`（推送镜像清单）
- 默认 `NO_CACHE=1`
- 默认 `BUILDER=multiarch`（自动创建/切换 buildx builder）

常用变量：

- `IMAGE_NAME`：镜像名（默认 `noise233/nav-manage`）
- `IMAGE_TAG`：版本标签（未设置时优先取 `GITHUB_REF_NAME`，否则尝试 `git describe`，最后回退 `dev`）
- `BUILD_TIME`：UTC 时间（默认自动生成）
- `PUSH=1|0`：是否推送
- `LOAD=1`：本地加载（仅单平台构建可用）
- `PLATFORMS`：目标平台列表（逗号分隔）
- `DRY_RUN=1`：只输出最终命令，不执行

示例（与发布命令等价）：

```bash
cd /Library/Github/noisedh/extension/yaml-server
IMAGE_TAG=v1.4 IMAGE_NAME=noise233/nav-manage PUSH=1 NO_CACHE=1 sh ./buildx.sh
```

仅打印命令（不推送）：

```bash
PUSH=0 DRY_RUN=1 sh ./buildx.sh
```

## 运行方式三：Node 直接运行（适合本机/服务器）

```bash
cd /Library/Github/noisedh/extension/yaml-server
npm ci
PORT=8990 BASE_DIR=/path/to/hugo API_TOKEN=change_me node server.js
```

建议使用 systemd/pm2 保持常驻，并在反向代理（Nginx/Caddy）上做 HTTPS 与访问限制。

## API 使用说明

所有写入类接口都需要 Header：

```text
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

### 获取数据文件列表

- `GET /data`

返回：`["webstack.yml", "..."]`

### 读取某个 YAML 文件内容

- `GET /data/:filename`

### 收录/写入数据

- `POST /api/yaml`

Body（示意）：

```json
{
  "filename": "webstack.yml",
  "allowCreateCategory": true,
  "newDataEntry": {
    "title": "Example",
    "url": "https://example.com",
    "logo": "https://example.com/favicon.ico",
    "description": "desc",
    "taxonomy": "分类名",
    "term": "子分类名"
  }
}
```

### 删除条目

- `DELETE /api/delete`

Body（示意）：

```json
{ "filename": "webstack.yml", "title": "Example" }
```

### 搜索（标题/描述/URL）

- `GET /api/search?keyword=<kw>&filePath=<filename>`

### URL 统计

- `GET /api/statistics`

### 导出为浏览器书签 HTML

- `GET /api/export-bookmarks?outputDir=<可选>`

### 最近更新通知

- `GET /api/notifications`

### 服务端推送配置（受保护）

用于在不改环境变量的情况下，动态配置 Telegram/Webhook 推送（需要管理员 Token）。

- `GET /api/server-settings`
- `POST /api/server-settings`

Body（示意）：

```json
{
  "webhookUrl": "https://your-webhook.example.com",
  "telegramChatId": "-100xxxxxx",
  "telegramBotToken": "123456:ABCDEF...",
  "rssChannelTitle": "NOISE导航收录更新",
  "rssChannelLink": "http://www.noisedh.cn",
  "rssChannelDescription": "最新更新通知",
  "rssImageUrl": "https://s2.loli.net/2025/02/26/a6yMIxOUZjHDghp.png",
  "rssImageTitle": "NOISE导航",
  "rssImageLink": "http://www.noisedh.cn",
  "telegramMessageTitle": "📢导航站收录更新通知！",
  "telegramNavText": "www.noisedh.cn 或 www.noisedh.link"
}
```

补充说明：

- 新增字段会持久化到 `server_settings.json`，并优先于环境变量默认值生效
- RSS 输出结构不变，仅将 `<channel>` 与 `<image>` 内文案改为可配置
- Telegram 推送结构不变，仅将首行文案与“前往导航”文案改为可配置

### 失效链接检测（分页/游标）

- `POST /api/invalid-links/check`

Body（示意）：

```json
{ "filename": "webstack.yml", "limit": 40, "offset": 0 }
```

返回（示意）：

```json
{
  "checkedCount": 40,
  "removedCount": 1,
  "removedItems": [],
  "totalLinks": 320,
  "hasMore": true,
  "nextOffset": 40
}
```

说明：

- 服务端会对每个 URL 记录“连续 404 次数”，达到 `INVALID_404_THRESHOLD` 后自动从 YAML 删除
- 删除记录会追加写入 `${BASE_DIR}/content/invalidlinks.md`
- `removedItems` 用于前端展示“本次自动清理的条目列表”

## trigger_hugo.sh（可选）

当你希望“写入后触发远程更新”，可以使用 `trigger_hugo.sh`：

- 若存在 `REMOTE_UPDATE_WEBHOOK`（或兼容变量 `HUGO_WEBHOOK_URL`/`WEBHOOK_URL`），脚本会 POST JSON 到该地址
- 否则回退到本机执行 `hugo --minify`

脚本文件：[trigger_hugo.sh](file:///Library/Github/noisedh/extension/yaml-server/trigger_hugo.sh)

## 一键部署（平台示例）

以下“一键部署”的含义是：把 GitHub 仓库/目录接入平台，由平台自动构建并运行容器。由于 `yaml-server` 依赖本地文件系统（读写 `data/`、追加 `invalidlinks.md`），部署时需要考虑持久化目录挂载。

### Zeabur（推荐：最省事）

思路：

1. 在 Zeabur 选择 “Deploy from GitHub”
2. 指定服务根目录为 `extension/yaml-server`
3. 选择 Dockerfile 构建（平台会自动识别）
4. 配置环境变量：`PORT`、`API_TOKEN`、`BASE_DIR=/app/hugo`（按你 Docker 内路径）
5. 添加持久化卷并挂载到 `/app/hugo`（至少包含 `data/`；若你需要写入 `content/invalidlinks.md`，也需要 `content/`）
6. 配置公网域名并开启 HTTPS

推荐做法：

- 若你不想在 Zeabur 内编译 Hugo：`ENABLE_HUGO=false`，并配置 `REMOTE_UPDATE_WEBHOOK` 指向你的 Hugo 构建/刷新服务

### Fly.io（适合需要全球节点 + 持久化卷）

思路：

1. 在本机安装 Fly.io CLI 并登录
2. 在 `extension/yaml-server` 目录执行初始化，让 Fly 以 Dockerfile 构建
3. 创建 volume 并挂载到容器内（例如 `/app/hugo`），把你的 `data/` 与 `content/` 放进去或通过同步方式维护
4. 在 Fly 的 secrets/env 中配置 `API_TOKEN` 等变量

关键点：

- Fly 的实例文件系统是临时的，必须用 volume 才能持久化 `data/` 与 `invalidlinks.md`
- 如果你站点不在 Fly 上构建：关闭 `ENABLE_HUGO`，用 `REMOTE_UPDATE_WEBHOOK` 通知你的站点构建服务

### Cloudflare（说明：默认 Workers 不适配本项目的“本地文件读写”）

重要限制：

- Cloudflare Workers/Pages Functions 运行环境不提供传统意义上的可写本地文件系统
- 而 `yaml-server` 需要读写 `data/*.yml` 并追加写入 `content/invalidlinks.md`

可选方案（择一）：

1. 若你有 Cloudflare 的容器化产品能力（例如可运行容器并挂载持久化存储的形态），可直接用本项目 Dockerfile 部署
2. 若你只能使用 Workers/Pages Functions：需要把存储层改造为 R2/KV/Durable Objects（当前代码未实现，不建议直接上）

结论：

- 希望保持“读写服务器文件”的能力：优先选 Zeabur/Fly 等容器平台
- 若必须在 Cloudflare：建议使用 Cloudflare 提供的容器运行形态（如果你账号已开通），否则需要对存储做适配改造

## 常见问题（FAQ）

### 浏览器访问域名显示 “Cannot GET /”

这是正常现象：服务没有提供 `/` 首页路由。请直接访问具体 API 路由（例如 `/api/notifications` 或 `/api/statistics`），或在反向代理层增加首页落地页。

### 扩展无法写入（403）

检查：

- 后端是否设置了 `API_TOKEN`
- 扩展设置页是否填写了相同 Token（并确保请求头带 `Authorization: Bearer ...`）
- 反向代理是否剥离了 `Authorization` 头（某些配置默认不转发）
