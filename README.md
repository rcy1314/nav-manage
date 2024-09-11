## Nav-Manage

## 为静态导航带来强大的管理扩展!

![](https://jsd.cdn.noisework.cn/gh/rcy1314/tuchuang@main/uPic/1726070023506.png)

## 说明

待添加…



# 一键部署

## 使用 Railway 部署

点击下面的按钮，快速将应用部署到 Railway：

[![Deploy to Railway](https://railway.app/button.svg)](https://vercel.com/import/project?template=https://github.com/rcy1314/nav-manage)

## 使用 Zeabur 部署

点击下面的按钮，快速将应用部署到 Zeabur：

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/MFNZYE)



### 环境变量说明

在 Railway 或 Zeabur 上，你需要设置以下环境变量：

- `PORT`: 服务器监听的端口（可选，默认是 8980）。
- `DATA_DIR`: 存储 数据 文件的目录（可选，但不再直接使用）。
- `GITHUB_TOKEN`: GitHub 访问令牌，用于认证 API 请求。
- `GITHUB_REPO`: GitHub 仓库（格式：`username/repo`）。
- `GITHUB_BRANCH`: 默认分支（可选，默认是 `main`）。

### 功能说明

1. **获取文件列表**：`GET /data` - 返回 `/data` 文件夹中的数据 文件列表。
2. **获取特定文件内容**：`GET /data/:filename` - 返回指定数据文件的内容。
3. **添加数据到 文件**：`POST /api/yaml` - 向指定的 数据 文件添加新数据条目。
4. **搜索条目**：`GET /api/search` - 在指定数据 文件中搜索条目。
5. **删除条目**：`DELETE /api/delete` - 从指定的数据文件中删除条目。
6. **更新条目**：`PUT /api/update` - 更新指定数据文件中的条目。

### 注意事项

确保在 GitHub 上创建一个访问令牌，并为其分配必要的权限（如 repo 权限）。

在处理 数据文件时，你需要获取文件的 SHA 值，以便在更新时使用。可以在读取文件时获取该值。

### 安装所有依赖的命令

在项目根目录下，运行以下命令以安装所有依赖：

```bash
npm install
```



> 如果你觉得本项目对你有所帮助，请[赞赏支持](https://www.noisework.cn/e/zhichi)它！
