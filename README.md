# Cloudflared-web 中文定制版

[![版本](https://img.shields.io/badge/版本-2026.8.2--zh--cn.5-orange)](https://github.com/w87051809/cloudflared-web-zh-cn/releases/tag/v2026.8.2-zh-cn.5)
[![cloudflared](https://img.shields.io/badge/cloudflared-2026.8.2-blue)](https://github.com/cloudflare/cloudflared/releases/tag/2026.8.2)
[![许可](https://img.shields.io/badge/许可-GPL--2.0-green)](LICENSE)

这是专门给路由器和内网环境使用的 Cloudflare Tunnel 中文管理界面。可以在网页中保存连接令牌、启动或停止隧道，并查看当前连接协议、边缘网络 IP、管理端口和核心版本。

本项目基于 [WisdomSky/Cloudflared-web](https://github.com/WisdomSky/Cloudflared-web) 修改，继续使用 GPL-2.0 开源协议。

## 中文界面预览

<img src="./screenshot-1.png" alt="Cloudflared-web 中文管理界面" width="1200">

## 当前版本

- 中文定制版：`2026.8.2-zh-cn.5`
- cloudflared 核心：`2026.8.2`
- 支持架构：`linux/amd64`、`linux/arm64`、`linux/arm/v7`
- 默认管理端口：`14333`
- 推荐隧道协议：`HTTP/2`

## Docker Compose 部署

```yaml
services:
  cloudflared-web:
    image: ghcr.io/w87051809/cloudflared-web-zh-cn:2026.8.2-zh-cn.5
    container_name: cloudflared-web
    restart: unless-stopped
    network_mode: host
    environment:
      WEBUI_PORT: 14333
      PROTOCOL: http2
    volumes:
      - ./config:/config
```

启动：

```bash
docker compose up -d
```

管理页面：

```text
http://路由器IP:14333
```

首次打开后，把 Cloudflare Zero Trust 中的 Tunnel Token 粘贴到页面并保存。令牌只保存在本机 `/config` 目录，不会显示在页面日志中。

## 为什么默认使用 HTTP/2

部分运营商线路会限制 QUIC 使用的 UDP 7844，表现为隧道偶尔离线或一直连接失败。设置 `PROTOCOL: http2` 后改走 TCP，通常更稳定，也不会限制局域网设备的普通下载速度。

## 自行构建

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t cloudflared-web-zh-cn:2026.8.2-zh-cn.5 .
```

构建过程会从 Cloudflare 官方发布页下载对应架构的安装包，并进行 SHA-256 校验。

## 安全说明

不要把 Tunnel Token、密码、私钥或实际 `/config` 目录提交到仓库。发现安全问题请查看 [SECURITY.md](SECURITY.md)。

## 上游项目

- [WisdomSky/Cloudflared-web](https://github.com/WisdomSky/Cloudflared-web)
- [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared)
