# Cloudflared-web 中文版

这是基于 [WisdomSky/Cloudflared-web](https://github.com/WisdomSky/Cloudflared-web) 修改的中文版本，包含 Cloudflare Tunnel 管理页面、中文提示和 `cloudflared 2026.8.2`。

## 版本

- 中文版：`2026.8.2-zh-cn.4`
- cloudflared：`2026.8.2`
- 支持架构：`linux/amd64`、`linux/arm64`、`linux/arm/v7`
- 开源协议：GPL-2.0

## Docker Compose

复制示例文件：

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

管理页面：

```text
http://路由器IP:14333
```

首次打开页面后再填写 Tunnel Token。不要把 Token、密码、私钥或 `/config` 目录提交到仓库。

## 当前网络建议

部分运营商网络会拦截或限制 QUIC/UDP 7844。出现隧道反复离线时，可设置：

```yaml
environment:
  PROTOCOL: http2
```

HTTP/2 使用 TCP，不会影响普通下载速度。

## DNS 建议

Docker 使用 `host` 网络时，应给容器设置可用 DNS。不要配置没有 DNS 服务监听的 `::1`。示例文件使用路由器 DNS、阿里 DNS和腾讯 DNS作为备用。

## 构建

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t cloudflared-web-zh-cn:2026.8.2-zh-cn.4 .
```

构建过程会从 Cloudflare 官方发布页下载对应架构的安装包并校验 SHA-256。

## 上游项目

- [WisdomSky/Cloudflared-web](https://github.com/WisdomSky/Cloudflared-web)
- [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared)
