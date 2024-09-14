## Nav-Manage

## 为静态导航带来强大的管理扩展!

![](https://jsd.cdn.noisework.cn/gh/rcy1314/tuchuang@main/uPic/1726070023506.png)

## 说明

Nav-Manage由后端API+前端扩展组成

服务基础为[WebStack 网址导航 Hugo 主题](https://github.com/shenweiyan/WebStack-Hugo)

这是为静态导航而开发的功能增强为主的扩展，本仓库为后端，前端请安装扩展使用！

演示导航站：[NOISE导航](https://www.noisedh.link)

待添加…

待添加…

待添加…

待添加…

待添加…

## 安装扩展

Gooogle chrome：已提交，待审核通过

Microsoft Edge：已提交，待审核通过

暂未通过审核，你可以访问主页添加我的微信后，发送关键词”nav扩展“来获取前端扩展

## 视频介绍

视频已压缩过了，预览高清视频请前往公众号查看



<video width="100%" height="100%" src="https://jsd.cdn.noisework.cn/gh/rcy1314/tuchuang@main/uPic/%E6%89%A9%E5%B1%95%E4%BB%8B%E7%BB%8D01.mp4" controls loop></video>

# 一键部署

## 使用 Railway 部署

点击下面的按钮，快速将应用部署到 Railway：

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/DUKGIQ?referralCode=aPt4gm)

部署成功后确保项目设置中开启网络选项，默认开启http，该链接为服务端地址

<img src="https://jsd.cdn.noisework.cn/gh/rcy1314/tuchuang@main/uPic/1726090548735.png" style="zoom:50%;" />

## 使用 Zeabur 部署

点击下面的按钮，快速将应用部署到 Zeabur：

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/MFNZYE)

点击模版后输入环境变量点击部署，确保项目设置中开启网络选项，该链接为服务端地址

<img src="https://jsd.cdn.noisework.cn/gh/rcy1314/tuchuang@main/uPic/1726090729510.png" alt="1726090729510" style="zoom:50%;" />

### 环境变量说明

在 Railway 或 Zeabur 上，你需要设置以下环境变量：

- `PORT`: 服务器监听的端口（可选，默认是 8980）。
- `DATA_DIR`: 存储 数据 文件的目录（如果没有设置 `DATA_DIR`，则默认使用 `/data/` 作为文件路径）
- `GITHUB_TOKEN`: [GitHub 访问令牌](https://github.com/settings/apps)，用于认证 API 请求。（**GitHub API 限制**：如果你在短时间内发送了太多请求，GitHub API 可能会限制你的请求。确保在调用 API 时遵循 GitHub 的速率限制。）
- `GITHUB_REPO`: GitHub 仓库（格式：`username/repo`）。
- `GITHUB_BRANCH`: 默认分支（可选，默认是 `main`）。
- **`TELEGRAM_BOT_TOKEN`**：**可选**：用于发送 Telegram 消息的机器人令牌。你需要在 Telegram 中创建一个机器人并获取此令牌。
- **`TELEGRAM_CHAT_ID`**：**可选**：指定接收 Telegram 消息的聊天 ID。可以是个人聊天 ID 或群组 ID。
- **`NAVIGATION_URL`**：**可选**：指定导航站的 URL，用于在 Telegram 消息中提供链接。
-  `WEBHOOK_URL` ：可选：**Webhook 通知**，可联动自动化集成推送到其它平台
-  `STORAGE_FILE_PATH`：可选：持久化存储更新数据，用于嵌入网站等方式

### 获取更新通知请求示例

环境变量增加TG频道的通知及可以使用 `fetch` 来请求更新通知

```
fetch('http://你部署的域名/api/updates')
    .then(response => response.json())
    .then(data => {
        if (data.message) {
            console.log(data.message);
        } else {
            data.forEach(update => {
                console.log(`标题: ${update.title}`);
                console.log(`Logo: ${update.logo}`);
                console.log(`URL: ${update.url}`);
                console.log(`描述: ${update.description}`);
            });
        }
    })
    .catch(error => console.error('获取更新通知时出错:', error));
```

TG通知预览

![TG通知预览](https://jsd.cdn.noisework.cn/gh/rcy1314/tuchuang@main/uPic/1726221372161.png)

### 功能说明

1. **获取文件列表**：`GET /data` - 返回 `/data` 文件夹中的数据 文件列表。
2. **获取特定文件内容**：`GET /data/:filename` - 返回指定数据文件的内容。
3. **添加数据到 文件**：`POST /api/yaml` - 向指定的 数据 文件添加新数据条目。
4. **搜索条目**：`GET /api/search` - 在指定数据 文件中搜索条目。
5. **删除条目**：`DELETE /api/delete` - 从指定的数据文件中删除条目。
6. **更新条目**：`PUT /api/update` - 更新指定数据文件中的条目。
7. 获取更新数据：`GET /api/notifications` - 获取最新更新站点的数据。
8. **Webhook 通知**：通过环境变量 `WEBHOOK_URL` 发送 Webhook 通知。可选设置
9. **持久化存储**：通过 `STORAGE_FILE_PATH` 环境变量指定仓库路径json文件来存储更新数据，已设置限制为最大存储40条

### 注意事项

确保在 GitHub 上创建一个访问令牌，并为其分配必要的权限（如 repo 权限）。

在处理 数据文件时，你需要获取文件的 SHA 值，以便在更新时使用。可以在读取文件时获取该值。

### 安装所有依赖的命令

在项目根目录下，运行以下命令以安装所有依赖：

```bash
npm install
```

## 本地运行使用

注意！本地的代码完全不同，需要自定义你的文件路径然后启动服务！

待添加…

待添加…

待添加…

## 云服务器部署使用

注意！本地的代码完全不同，需要自定义你的文件路径然后启动服务！

待添加…

待添加…

待添加…

## 一键部署导航站

<details>
<summary>✅ 【点击展开】</summary>



说明：这是导航站的部署模版，非本项目的一键部署，如果一键部署链接失效请使用模版地址fork或导入部署即可！

项目来源：https://github.com/shenweiyan/WebStack-Hugo

模版地址：https://github.com/rcy1314/webstack-hugo-templates

### Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/rcy1314/webstack-hugo-templates)

### Vercel

[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/rcy1314/webstack-hugo-templates)

### GitHub Pages

[点击使用 GitHub Pages 部署](https://github.com/features/actions/starter-workflows/deploy-to-github-pages)

### Webify

[![Deploy with Webify](https://cloudbase.net/deploy.svg)](https://console.cloud.tencent.com/webify/new)

复刻模版后选择导入

### Cloudflare Pages

[![Deploy to Cloudflare Pages](https://www.cloudflare.com/favicon.ico)](https://pages.cloudflare.com)

复刻模版后选择导入

## GitHub action 工作流运行

构建页面工作流将在您点击 “Start Workflow” 按钮后立即运行，并且在每次 `main` 分支有变动时也会自动运行

自动检测失效链接工作流将在您点击 “Start Workflow” 按钮后立即运行，需要定时运行时取消cron前的#符号即可



</details>

## 致谢



 感谢[shenweiyan](https://github.com/shenweiyan)带来的[WebStack 网址导航 Hugo 主题](https://github.com/shenweiyan/WebStack-Hugo)项目

## 补充

要使用自动化检测并删除失效链接请前往详细文档查看



> 如果你觉得本项目对你有所帮助，请[赞赏支持](https://www.noisework.cn/e/zhichi)它！
