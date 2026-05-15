---
title: "接入 NOISE导航 的 MCP（Skill）"
audience: "使用者"
---

# 接入 NOISE导航 的 MCP（Skill）

本文件面向使用者：用于把 NOISE导航 的 MCP（站内收录搜索）接入到你的任意 AI 客户端，并保证配置通用、可复制、可排错。

## 你将获得什么

- 让 AI 具备 “站内搜索收录的网站” 的能力（工具名：`search_sites`）
- 搜索结果支持可点击翻页/筛选（资源：`resource://noisedh/start`、`resource://noisedh/search`）

## AI 引导式安装（推荐）

如果你希望 AI 带着你完成配置（尤其是第一次接入），你可以直接对 AI 说：

- “帮我接入 NOISE导航 的 MCP。我只需要站内搜索功能。请一步步引导我配置，并在我配置缺失时提示我怎么修复。”

AI 应该按这个顺序向你确认（尽量只问 2-3 个问题）：

1) “你的 AI 客户端运行在哪台机器？能直接执行 `node` 吗？”  
2) “你希望用 URL 接入还是本地 stdio 接入？（优先 URL）”  
3) “如果用 URL：你的后端地址是什么（域名或 IP）？鉴权 Token 用哪个？”

然后 AI 应该优先给出下面“方式 A（URL）”的可复制配置片段；只有当你的 AI 客户端不支持 `url` 时，才给“方式 B（Node stdio）”。

## 两种接入方式（推荐先用方式 A）

### 方式 A：URL 方式（推荐，最少配置）

适用：你已经把后端服务部署到可访问的域名/IP（例如 `http://<ip>:8990` 或 `https://api.example.com`），希望 AI 客户端只需要填写一个 URL。

服务端要求：

- 开启 MCP HTTP：设置 `MCP_HTTP=true`（推荐）或使用启动参数 `--mcp-http`
- 默认需要鉴权：`Authorization: Bearer <API_TOKEN>`（可用 `MCP_REQUIRE_TOKEN=false` 关闭）

把下面配置片段添加到你的 AI 客户端 MCP 配置里即可（把地址与 Token 改成你自己的）：

```json
{
  "mcpServers": {
    "NOISE导航": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <API_TOKEN>"
      }
    }
  }
}
```

常见地址示例：

- `http://<服务器IP>:8990/mcp`
- `https://<你的域名>/mcp`

### 方式 B：Node stdio 方式（仅当你的 AI 客户端不支持 url）

适用：你的 AI 客户端只能“启动本地命令（stdio）”来接入 MCP。

前提：

- AI 客户端所在机器需要能访问到站点的数据目录（通常是本机/本服务器的 `data/` 目录）
- 本机需要有 `extension/yaml-server` 目录并安装依赖：在 `extension/yaml-server` 执行 `npm ci`（或 `npm i --production`）

把下面配置片段添加到你的 AI 客户端 MCP 配置里即可（把路径改成你自己的实际路径）：

```json
{
  "mcpServers": {
    "NOISE导航": {
      "command": "node",
      "args": [
        "/absolute/path/to/noisedh/extension/yaml-server/server.js",
        "--mcp",
        "--no-http"
      ],
      "env": {
        "BASE_DIR": "/path/to/hugo",
        "SEARCH_DATA_DIRS": "/path/to/hugo/data"
      }
    }
  }
}
```

## MCP 接入参数说明（最全）

### AI 客户端字段

- `mcpServers`：MCP 服务集合
- `mcpServers."NOISE导航"`：服务显示名称（可改成你喜欢的名字）
- `url`：URL 方式的 MCP 地址（推荐），例如 `https://api.example.com/mcp`
- `headers`：URL 方式可选请求头（默认建议填 `Authorization: Bearer <API_TOKEN>`）
- `command` / `args` / `env`：当客户端只支持 stdio 时使用

### URL（推荐）

等价请求（示例用于自检工具列表）：

```bash
curl -X POST "https://api.example.com/mcp" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Node stdio（可选）

等价命令：

```bash
BASE_DIR=/path/to/hugo SEARCH_DATA_DIRS=/path/to/hugo/data \
  node /absolute/path/to/noisedh/extension/yaml-server/server.js --mcp --no-http
```

## 使用方式（给 AI 的一句话）

接入完成后，你可以直接对 AI 说：

- “在 NOISE导航 里搜索：AI 工具，翻到第 2 页”
- “帮我找可以 AI 生成图片的网站”
- “在 NOISE导航 里搜一下 AI 绘图工具”
- “找一些支持文生图的站点”
- “搜索能生成图片的 AI 网站，优先国外热门产品”
- “帮我找 AI 图片生成工具，第 2 页”
- “打开 NOISE导航 MCP 起始页”

你也可以用更稳定的“格式化搜索”表达（AI 更容易准确映射参数）：

- “搜索：关键词=AI，页码=2，每页=20”
- “搜索：关键词=图标，一级分类=设计”
- “搜索：关键词=导航，一级分类=AI，二级分类=大模型”
- “搜索：关键词=云盘资源库（描述里也能命中）”
- “搜索：关键词=AI，格式=json”（需要结构化字段时用）

字段含义（MCP 搜索参数 / 数据字段）：

- `关键词` → `query`
- `页码` → `page`
- `每页` → `pageSize`
- `一级分类` → `taxonomy`
- `二级分类` → `term`
- `地址` → `url`
- `描述` → `description`
- `格式` → `format`（`markdown`/`json`）

## 安装后若缺少配置，AI 应该如何主动帮助

如果你已经“看起来配置过了”，但 AI 仍然无法正常使用 MCP，AI 应该主动给出下一步提示，而不是只说“配置有问题”。

### AI 应主动识别并提示的情况

#### 1) 工具不存在 / 没看到 `search_sites`

AI 应提示你：

- 先重启或重新加载 AI 客户端，让 MCP 配置生效
- 如果你用 URL 方式：先检查 `/mcp` 是否可访问（以及 Token 是否正确）

```bash
curl -X POST "https://api.example.com/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

- 如果你用 Node stdio 方式：检查本机 Node 与路径是否正确

```bash
node -v
ls -la /absolute/path/to/noisedh/extension/yaml-server/server.js
```

并检查依赖是否安装（只需要执行一次）：

```bash
cd /absolute/path/to/noisedh/extension/yaml-server && npm ci
```

#### 2) 容器找不到 / 命令执行失败

AI 应提示你：

- 如果你用 URL 方式：重点检查反向代理/网关是否放行 `/mcp`、`Authorization`、`Mcp-Session-Id`、`MCP-Protocol-Version`，并且不要错误拦截 `text/event-stream`
- 如果你用 Node stdio 方式：重点检查依赖是否已安装（在 `extension/yaml-server` 执行 `npm ci`）

#### 3) 能调用工具，但结果始终为空

AI 应提示你：

- URL 方式：检查服务端容器/进程是否能读到数据目录（`BASE_DIR` 或 `SEARCH_DATA_DIRS` 是否正确）
- Node stdio 方式：检查 `SEARCH_DATA_DIRS` 指向的目录是否存在，且目录下确实有数据文件：

```bash
ls -la /path/to/hugo/data
```

- 如果你用的是 Docker 方式：检查 `-v /path/to/your/hugo-site/data:/app/data` 左侧路径是否正确

#### 4) 起始页或资源页打不开

AI 应提示你：

- MCP 资源 URI 必须使用：
  - `resource://noisedh/start`
  - `resource://noisedh/help`
  - `resource://noisedh/search?...`
- 不能写成别的 hostname

### AI 的推荐回应风格

AI 在帮助你安装/排错时，应该：

- 先判断你是“复用容器”还是“临时容器”方案
- 一次只给 1～2 个最关键的检查步骤
- 尽量给可直接复制的命令，而不是只给概念说明
- 检查到缺少配置时，直接补一份完整配置片段给你替换

## 验证与排错

1) 验证 MCP 已连接

- 在 AI 客户端里让它列出工具，确认出现 `search_sites`
- 或者让 AI 打开起始页：`resource://noisedh/start`

2) 常见问题

- 看不到工具：检查 AI 客户端是否真正加载了 MCP 配置（通常需要重启客户端）
- 执行失败：确认 AI 客户端所在机器能执行 `node`，并且已在 `extension/yaml-server` 安装依赖（`npm ci`）
- 结果为空：确认 `SEARCH_DATA_DIRS` 指向了真实存在的 `data/` 目录

## Token（可选）

URL 方式默认需要鉴权：

- `Authorization: Bearer <Token>`
- 若设置了 `MCP_TOKEN`，则 Token 为 `MCP_TOKEN`
- 否则 Token 复用 `API_TOKEN`

如果你希望公开提供 MCP 给所有人使用：

- 设置 `MCP_REQUIRE_TOKEN=false` 即可关闭 `/mcp` 鉴权
- 建议开启 MCP 访问频率限制（按 IP 计数）：
  - `MCP_RATE_LIMIT_MAX`（默认 120）
  - `MCP_RATE_LIMIT_WINDOW_MS`（默认 60000）
  - 需要关闭可设 `MCP_RATE_LIMIT_DISABLED=true`

## 安全建议

- 本 MCP 仅做站内数据读取/搜索，不需要 `API_TOKEN`
- 不建议在 AI 客户端配置里写入任何敏感 Token
