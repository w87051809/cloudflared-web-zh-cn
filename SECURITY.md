# 安全说明

- 禁止向 Issue、日志或提交记录粘贴 Cloudflare Tunnel Token。
- 禁止提交 `/config`、证书、私钥、密码和路由器备份。
- 默认账号和密码仅用于首次登录；后端会强制更换，完成前不会开放隧道管理接口。
- 默认信息只允许从可信局域网首次使用；不要开启 `WEBUI_ALLOW_REMOTE_SETUP` 对公网放行首次设置。
- Cloudflare Tunnel 指向本管理页面时，源服务必须使用 `127.0.0.1` 或 `localhost`，不能使用路由器局域网 IP。
- `/config/auth.json` 包含登录密码的加盐哈希，应仅允许管理员和容器读取。
- `/config/config.json` 和 cloudflared 配置文件包含敏感信息，程序会按 `0600` 权限原子写入。
- 正式镜像使用最小化 Distroless 运行环境，cloudflared 从校验后的官方标签源码使用已修复 Go 工具链构建。
- 发布前会扫描每种架构的实际镜像摘要，并阻止带有可修复高危或严重漏洞的镜像发布。
- 登录会话可在退出时立即吊销，敏感接口禁止缓存并校验同源 JSON 请求。
- Web 管理容器不挂载 Docker Socket，更新通信目录也以只读方式挂载。一键更新由独立容器执行，只监听本机 Unix Socket，请求使用短时效 HMAC 签名并防止重放。
- 更新服务只允许操作名为 `cloudflared-web` 的主容器，并且只接受本项目 GitHub 最新公开正式版本；不能通过网页指定镜像仓库、容器或命令。
- 怀疑 Token 泄露时，应立即在 Cloudflare Zero Trust 后台更换令牌。
- 安全问题请使用 GitHub Security Advisory 私下报告。
