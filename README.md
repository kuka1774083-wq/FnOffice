# FnOffice

飞牛 fnOS 网关应用，注册 Office 文件默认打开方式并集成 OnlyOffice。

## 开发运行

```powershell
$env:FNOS_DEV_MODE='true'
node app/server/index.mjs
```

## 自动安装 OnlyOffice

安装向导选择自动安装时，FnOffice 会直接创建 `fnoffice-onlyoffice` 和 `fnoffice-callback-relay` Docker 容器，不会创建或管理 Compose 项目。两个容器都使用 `restart=always`。安装回调会前台等待镜像拉取、容器创建以及 OnlyOffice `/healthcheck` 就绪后才报告安装完成，健康检查最长等待 1200 秒；失败会提示先等待 Docker 中的两个镜像下载完毕后再次尝试安装，并保留诊断日志。`wizard_onlyoffice_port` 会同时写入应用配置和手动部署教程使用的 `docker/.env`；设置页从同一份配置读取该端口，因此向导填写的端口不会被默认值覆盖。端口映射到所有网卡，请按需配置飞牛防火墙。

安装向导还可选择是否区分移动端界面，默认关闭（手机端使用桌面版界面）；开启后会根据设备自动使用 OnlyOffice 移动端编辑器。该选项可在 FnOffice 设置页修改并与持久化配置同步。设置页会根据配置中的 OnlyOffice 地址实时检测并显示版本号，无法连接时显示“未配置”。

安装过程点击取消时会终止镜像拉取/健康检查，清理 FnOffice 创建的两个容器，并写入取消结果；同时兼容飞牛通过取消标记文件终止长时间 Docker 操作的情况。

如果安装向导选择不自动安装，FnOffice 不会创建、停止或修改任何 Docker 容器；之后仍可在设置页填写外部 OnlyOffice 地址和 JWT 配置。

仓库中的 Compose 文件仅用于管理员选择手动部署时复制使用，不参与自动安装。OnlyOffice 端口映射到所有网卡。
