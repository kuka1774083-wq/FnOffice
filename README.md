# FnOffice

飞牛 fnOS 网关应用，注册 Office 文件默认打开方式并集成 OnlyOffice，支持 DOC/DOCX、XLS/XLSX、PPT/PPTX、PDF 等文件类型，以及多人在线协作编辑、保存回写和权限校验。

## 特性

- 通过飞牛统一网关运行，不声明独立应用端口。
- 自动创建或手动连接 OnlyOffice Document Server。
- 自动安装使用 `restart=always`，并等待容器真正健康后才完成安装。
- 支持公网、fnConnect 和内网网关访问，浏览器端不暴露服务端内部地址。
- 支持 OnlyOffice JWT、实时协作、强制保存和并发文档限制。
- 编辑器心跳、离线会话清理、临时文件清理和原子回写。
- 设置页显示 FnOffice 与 OnlyOffice 版本、连接状态和在线会话。

## 飞牛 OS 安装

1. 在飞牛应用中心安装 FnOffice FPK。
2. 安装向导选择 OnlyOffice 自动安装或手动部署。
3. 自动安装会下载约 3GB 镜像，并创建 `fnoffice-onlyoffice` 与 `fnoffice-callback-relay` 两个容器；端口仅用于 FnOffice 与 OnlyOffice 内部通信。
4. 手动模式不会创建、停止或修改用户已有的 Docker 容器，在设置页填写 OnlyOffice 地址和 JWT 配置即可。

安装向导中的端口、镜像、JWT 和移动端界面选项会写入持久化配置，并同步到设置页。

## 手动部署 OnlyOffice

仓库中的 [`app/docker/docker-compose.yaml`](app/docker/docker-compose.yaml) 可直接复制到飞牛 Docker Compose 项目中。请准备一个可写的项目目录，设置 `.env` 中的 `ONLYOFFICE_PORT`、`JWT_SECRET` 和 `FNOFFICE_APPDEST`，启动后在 FnOffice 设置页填写相同地址和密钥。

OnlyOffice 端口是否对外开放取决于管理员的部署方式；如果只供 FnOffice 内部访问，建议使用飞牛防火墙限制来源。

## 开发运行

```powershell
$env:FNOS_DEV_MODE='true'
node app/server/index.mjs
```

需要 Node.js 20 或更高版本。构建 FPK：
Windows：
```powershell
..\fnpack.exe build -d .
```
Linux：
```bash
..\fnpack build -d .
```

## 目录说明

- `app/server`：FnOffice 网关服务、OnlyOffice 代理和回调处理。
- `app/ui`：设置页、文档打开页和前端资源。
- `cmd`：飞牛安装、升级、卸载生命周期脚本。
- `wizard`：飞牛安装向导配置。
- `app/docker`：手动部署 OnlyOffice 的 Compose 示例。

## 许可证

本项目采用 MIT License，详见 [`LICENSE`](LICENSE)。
