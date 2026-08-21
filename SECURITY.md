# 安全说明

- 禁止向 Issue、日志或提交记录粘贴 Cloudflare Tunnel Token。
- 禁止提交 `/config`、证书、私钥、密码和路由器备份。
- 首次登录后应立即更换默认账号和默认密码。
- `/config/auth.json` 包含登录密码的加盐哈希，应仅允许管理员和容器读取。
- 怀疑 Token 泄露时，应立即在 Cloudflare Zero Trust 后台更换令牌。
- 安全问题请使用 GitHub Security Advisory 私下报告。
