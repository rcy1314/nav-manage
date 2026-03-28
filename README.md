# Nav-Manage

本仓库仅提供扩展 + 后端 API，需要hugo主题及网站源码请前往[noisedh-nav](https://github.com/rcy1314/noisedh-nav)

全新重构扩展，带有AI一键分析推荐分类的扩展，随时随地收藏你的网址

| ![预览](https://s2.loli.net/2025/05/05/BQaNdGi8u1CDjJM.png)  | ![823shots_so](https://cdn.jsdelivr.net/gh/rcy1314/tuchuang@main/uPic/823shots_so.png) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![553shots_so](https://cdn.jsdelivr.net/gh/rcy1314/tuchuang@main/uPic/553shots_so.png) | ![369shots_so](https://cdn.jsdelivr.net/gh/rcy1314/tuchuang@main/uPic/369shots_so.png) |

Nav-Manage 由两部分组成：

- 浏览器扩展（前端）：[Nav-manage-extension](file:///Library/Github/noisedh/extension/Nav-manage-extension)
- 后端 API（Node + Express）：[yaml-server](file:///Library/Github/noisedh/extension/yaml-server)

用于给 Hugo 静态导航站提供“收录/删除/搜索/失效检测/导出书签/通知推送”等管理能力。

演示站点：[NOISE导航](https://www.noisedh.link)

## 快速开始（仅部署后端）

说明：本节是“仅后端 API”部署，不包含 Hugo 主题网站的静态服务。  
如果你需要“一次性部署 Hugo 主题网站 + Docker 运行教程”，请先看：

- [DOCKER_HUGO_THEME_DEPLOY.md](file:///Library/Github/noisedh/DOCKER_HUGO_THEME_DEPLOY.md)

已发布镜像：`noise233/nav-manage`（默认端口 `8990`）。

示例（按实际路径修改）：

```bash
docker run -d \
  --name nav-manage \
  -p 8990:8990 \
  -e PORT=8990 \
  -e BASE_DIR=/app/hugo \
  -e API_TOKEN=change_me_to_a_strong_token \
  -e ENABLE_HUGO=false \
  -e REMOTE_UPDATE_WEBHOOK= \
  -v /path/to/your/hugo-site:/app/hugo \
  --restart=always \
  noise233/nav-manage:latest
```

说明：

- `BASE_DIR`：站点根目录，容器会读写 `${BASE_DIR}/data/*.yml`，并可能写入 `${BASE_DIR}/content/invalidlinks.md`
- `API_TOKEN`：写入/删除/失效检测等接口鉴权 Token（扩展设置里要一致）
- `ENABLE_HUGO=true`：收录/删除后在容器内执行 `hugo`（需要挂载完整 Hugo 源码目录）
- `ENABLE_HUGO=false`：不在容器内编译 Hugo，建议配合 `REMOTE_UPDATE_WEBHOOK` 触发远程更新

完整参数说明与 API 列表见：[DEPLOYMENT.md](file:///Library/Github/noisedh/extension/yaml-server/DEPLOYMENT.md)

## 前后端分离部署（推荐）

典型方式：

- Hugo 导航站（前端）：静态发布在 Nginx / CDN / GitHub Pages
- yaml-server（后端）：部署在云服务器，仅负责写入数据与触发更新

有两种常见更新策略：

### 策略 A：后端同机编译 Hugo

- 把 Hugo 源码目录挂载到容器（包含 `config.toml`、`themes/`、`content/`、`data/`）
- `ENABLE_HUGO=true`
- Web 服务指向 Hugo 的输出目录（例如 `publishDir=docs` 则为 `docs/`）

### 策略 B：Webhook 触发远程构建（更通用）

- `ENABLE_HUGO=false`
- 配置 `REMOTE_UPDATE_WEBHOOK` 指向你的构建/发布入口（例如：拉取仓库、执行 hugo、同步到站点）
- 后端写入数据完成后会自动 POST 该 webhook 触发更新

## 浏览器扩展使用

扩展安装后，在设置页填写并保存：

- `serverUrl`：后端 API 地址（例如 `https://api.example.com`）
- `serverToken`：与后端 `API_TOKEN` 一致
- 推送通知参数：`webhookUrl`、`telegramChatId`、`telegramBotToken`
- RSS 自定义参数：`rssChannelTitle`、`rssChannelLink`、`rssChannelDescription`、`rssImageUrl`、`rssImageTitle`、`rssImageLink`
- Telegram 文案参数：`telegramMessageTitle`、`telegramNavText`

并在“写入同步”里勾选：

- 云服务器（写入到 yaml-server）
- GitHub（写入到仓库 data/ 目录）

两者可以同时勾选：一次收录会同时写入两端，并分别提示成功/失败原因。

说明：以上推送/RSS/文案参数会随“保存”同步到后端 `/api/server-settings`，服务端会持久化并直接用于 RSS 生成与 Telegram 推送。

扩展完整说明见：[USAGE.md](file:///Library/Github/noisedh/extension/Nav-manage-extension/USAGE.md)

## 常用 API（示例）

写入类接口需携带：

```text
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

示例：

```bash
curl "http://localhost:8990/data"

curl -X POST "http://localhost:8990/api/yaml" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"filename":"webstack.yml","newDataEntry":{"title":"Example","url":"https://example.com","logo":"https://example.com/favicon.ico","description":"desc","taxonomy":"分类名","term":"子分类名"}}'

curl -X DELETE "http://localhost:8990/api/delete" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"filename":"webstack.yml","title":"Example"}'

curl -X POST "http://localhost:8990/api/invalid-links/check" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"filename":"webstack.yml","limit":40,"offset":0}'

curl -O "http://localhost:8990/api/export-bookmarks"
```

完整接口与参数请以 [DEPLOYMENT.md](file:///Library/Github/noisedh/extension/yaml-server/DEPLOYMENT.md) 为准。

## GitHub action 工作流运行

构建页面工作流将在您点击 “Start Workflow” 按钮后立即运行，并且在每次 `main` 分支有变动时也会自动运行

自动检测失效链接工作流将在您点击 “Start Workflow” 按钮后立即运行，需要定时运行时取消cron前的#符号即可



</details>

## 致谢



 感谢[shenweiyan](https://github.com/shenweiyan)带来的[WebStack 网址导航 Hugo 主题](https://github.com/shenweiyan/WebStack-Hugo)项目

## 补充


你也可以自己再增加其它功能，比如，导入导出书签或备份等

 最初的本地版V0版本

![1725915567699](https://s2.loli.net/2024/10/04/PbITCYk3oMwHvXB.png)

> 如果你觉得本项目对你有所帮助，请[赞赏支持](https://www.noisework.cn/e/zhichi)它！
