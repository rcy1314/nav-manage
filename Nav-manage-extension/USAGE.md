# Nav-Manage 扩展使用说明

本说明面向浏览器扩展 `extension/Nav-manage-extension`，用于配合后端 `yaml-server` 管理 Hugo 导航数据（收录/删除/搜索/失效检测），并支持推送通知、GitHub 同步与 AI 分类建议。

## 安装与加载

1. 打开 Chrome/Edge 扩展管理页：
   - Chrome：`chrome://extensions`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择目录：[Nav-manage-extension](file:///Library/Github/noisedh/extension/Nav-manage-extension)

## 权限说明

扩展会使用以下能力：

- `activeTab`/`scripting`：读取当前网页标题、摘要、favicon 等用于自动填充
- `contextMenus`：右键“一键收录”
- `notifications`：右键收录成功/失败的系统通知提示
- `storage`：保存配置（云端地址、Token、GitHub、AI、推送等）
- `host_permissions`：允许在 http/https 网站上执行脚本并读取页面信息

## 第一次使用（推荐流程）

### 1) 部署后端

先部署 `yaml-server`，并确保能从浏览器访问。后端部署与 API 说明见：

- [DEPLOYMENT.md](file:///Library/Github/noisedh/extension/yaml-server/DEPLOYMENT.md)

如果你还没有把 Hugo 主题网站本体部署起来，建议先完成整站 Docker 教程，再配置扩展：

- [DOCKER_HUGO_THEME_DEPLOY.md](file:///Library/Github/noisedh/DOCKER_HUGO_THEME_DEPLOY.md)

### 2) 配置扩展

打开扩展设置页（扩展弹窗右上角齿轮）并填写：

- 云服务器配置
  - 服务器地址（API URL）：例如 `https://api.your-domain.com`
- 身份验证
  - 云服务器 Token：必须与后端 `API_TOKEN` 一致
- 写入同步
  - 云服务器 / GitHub（可同时勾选）
- GitHub 配置（可选）
  - 用户名/仓库/分支/目录 + GitHub Token
- AI 智能分析设置（可选）
  - 服务商 / 模型 / Key / Endpoint
- 推送通知（后端）（可选）
  - Webhook / Telegram Chat ID / Telegram Bot Token
  - 保存时会尝试同步到后端（需要已填写服务器地址与云服务器 Token）

提示：如果只想使用云服务器读写，把“写入同步”只勾选云服务器即可。

## 主界面说明

### 数据库文件选择

弹窗底部是“数据库文件”选择（来自后端 `/data` 或 GitHub 仓库目录）。

- 首次使用先选择 `webstack.yml`（或你的实际数据文件）
- 选择后会加载分类/子分类并允许收录

### 自动识别网页参数

打开任意网站后点击扩展，默认会自动填充：

- 标题：网页标题
- 摘要：meta description / og:description
- Logo：favicon
- 链接：当前 URL

### 收录

填写分类/子分类后点击“收录”，会按设置执行：

- 写入云服务器（调用后端 `POST /api/yaml`）
- 写入 GitHub（如果开启 GitHub 同步）

### 置顶（悬浮窗口）

点击右上角图钉按钮，会打开一个“悬浮窗口”版本的扩展页面：

- 会把当前界面状态（选中文件、输入内容、当前页签）同步到悬浮窗口
- 再次点击图钉会复用并刷新同一个悬浮窗口

重要说明：

- 浏览器扩展无法实现系统级“永远置顶在所有应用之上”的强制置顶（受浏览器与系统权限限制）
- 但悬浮窗口不会像浏览器 popup 弹窗那样，点击别处就自动消失

### 失效检测（进度窗口）

点击右上角“失效检测”按钮，会打开一个独立窗口显示：

- 分批检测进度（游标/分页）
- 本次自动清理列表（标题/分类/URL/连续404次数）

失效检测会调用后端：

- `POST /api/invalid-links/check`

当某个 URL 连续 404 达到阈值（默认 3 次）后，会自动从 YAML 删除，并把记录追加写入：

- `/Library/Github/noisedh/content/invalidlinks.md`（取决于后端 `BASE_DIR`）

## 右键“一键收录”

在网页上右键，可使用：

- “收录此网站到 Nav Manage”

该能力会尝试将当前网页自动提取后写入云服务器（需要已配置服务器地址、云服务器 Token，且“写入同步”勾选云服务器）。

## 常见问题

### 收录失败（401/403）

- 检查后端是否设置了 `API_TOKEN`
- 检查扩展设置中的“云服务器 Token”是否一致
- 如果前面有反向代理，确认没有剥离 `Authorization` 请求头

### 无法读取分类/文件列表

- 云服务器模式：检查 `serverUrl` 是否正确，后端是否可访问
- GitHub 模式：检查 GitHub Token 权限、仓库/路径是否正确
