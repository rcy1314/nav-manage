## Nav-Manage为静态导航带来强大的管理扩展!

![](https://jsd.cdn.noisework.cn/gh/rcy1314/tuchuang@main/uPic/1726070023506.png)

## 说明

待添加…



# 一键部署

## 使用 Railway 部署

点击下面的按钮，快速将应用部署到 Railway：

[![Deploy to Railway](https://railway.app/button.svg)](https://railway.app/new/template)

## 使用 Zeabur 部署

点击下面的按钮，快速将应用部署到 Zeabur：

[<img src="https://zeabur.com/favicon.svg" alt="Deploy to Zeabur" style="zoom: 25%;" />](https://zeabur.com/deploy)

### 环境变量说明

在 Railway 或 Zeabur 上，你需要设置以下环境变量：

- `PORT`: 服务器监听的端口（可选，默认是 8980）。
- `DATA_DIR`: 存储 YAML 文件的目录（可选，默认是 `/data`）。
- `GITHUB_TOKEN`: 用于访问 GitHub API 的访问令牌。
- `REPO`: GitHub 仓库的名称，格式为 `username/repo`。
- `FILE_PATH`: 需要读写的 YAML 文件的路径。

### 注意事项

1. 确保在 GitHub 上创建一个访问令牌，并为其分配必要的权限（如 repo 权限）。
2. 在处理 YAML 文件时，你需要获取文件的 SHA 值，以便在更新时使用。可以在读取文件时获取该值。
