# Cloudflared-web 中文版

[![Release](https://img.shields.io/github/v/release/w87051809/cloudflared-web-zh-cn?display_name=tag)](https://github.com/w87051809/cloudflared-web-zh-cn/releases)
[![Build](https://github.com/w87051809/cloudflared-web-zh-cn/actions/workflows/build.yml/badge.svg)](https://github.com/w87051809/cloudflared-web-zh-cn/actions/workflows/build.yml)
[![cloudflared](https://img.shields.io/badge/cloudflared-2026.8.2-2f73b8)](https://github.com/cloudflare/cloudflared/releases/tag/2026.8.2)
[![License](https://img.shields.io/badge/license-GPL--2.0-168254)](LICENSE)

面向路由器和内网服务器的 Cloudflare Tunnel 中文管理界面。项目集成 `cloudflared` 核心、Web 管理后台和登录保护，支持在浏览器中管理 Tunnel Token、控制隧道启停并查看当前运行状态。

本项目基于 [WisdomSky/Cloudflared-web](https://github.com/WisdomSky/Cloudflared-web) 修改，继续遵循 GPL-2.0 开源协议。

## 功能概览

- 中文化的登录页面和隧道管理页面
- 基于账号、密码和签名会话 Cookie 的访问控制
- 登录失败次数限制和会话有效期管理
- Tunnel Token 本地持久化与前端脱敏
- 隧道启动、停止及实时运行参数查看
- `HTTP/2`、`QUIC` 和自动协议选择
- `linux/amd64`、`linux/arm64`、`linux/arm/v7` 多架构镜像
- 固定版本镜像和 `latest` 镜像发布

## 页面预览

### 登录页面

<img src="./screenshot-login.png" alt="Cloudflared-web 中文登录页面" width="1200">

### 隧道管理页面

<img src="./screenshot-1.png" alt="Cloudflared-web 中文隧道管理页面" width="1200">

## 版本信息

| 项目 | 当前版本 |
| --- | --- |
| 中文定制版 | `2026.8.2-zh-cn.6` |
| cloudflared | `2026.8.2` |
| 默认管理端口 | `14333` |
| 容器镜像 | `ghcr.io/w87051809/cloudflared-web-zh-cn` |
| 支持架构 | `linux/amd64`、`linux/arm64`、`linux/arm/v7` |

## 部署

### 1. 创建环境变量文件

复制环境变量模板并修改其中的账号、密码和会话密钥：

```bash
cp .env.example .env
```

`.env` 文件格式如下：

```dotenv
CLOUDFLARED_WEB_USER=admin
CLOUDFLARED_WEB_PASSWORD=请替换为独立的强密码
CLOUDFLARED_WEB_SESSION_SECRET=请替换为至少32位的随机字符
```

不要将 `.env`、Tunnel Token、证书或私钥提交到仓库。

### 2. 使用 Docker Compose 启动

```yaml
services:
  cloudflared-web:
    image: ghcr.io/w87051809/cloudflared-web-zh-cn:2026.8.2-zh-cn.6
    container_name: cloudflared-web
    restart: unless-stopped
    network_mode: host
    environment:
      WEBUI_HOST: 0.0.0.0
      WEBUI_PORT: 14333
      BASIC_AUTH_USER: ${CLOUDFLARED_WEB_USER:-admin}
      BASIC_AUTH_PASS: ${CLOUDFLARED_WEB_PASSWORD:?请先在 .env 设置登录密码}
      WEBUI_SESSION_SECRET: ${CLOUDFLARED_WEB_SESSION_SECRET:?请先在 .env 设置会话密钥}
      WEBUI_SESSION_HOURS: 12
      WEBUI_COOKIE_SECURE: auto
      PROTOCOL: http2
      EDGE_IP_VERSION: auto
    volumes:
      - ./config:/config
      - ./config/cloudflared:/root/.cloudflared
```

启动服务：

```bash
docker compose up -d
```

管理地址：

```text
http://路由器IP:14333
```

首次登录后，从 Cloudflare Zero Trust 控制台复制 Tunnel Token，在管理页面保存并启动隧道。

## 配置参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `WEBUI_HOST` | `0.0.0.0` | Web 管理服务监听地址 |
| `WEBUI_PORT` | `14333` | Web 管理服务监听端口 |
| `BASIC_AUTH_USER` | `admin` | 管理账号 |
| `BASIC_AUTH_PASS` | 空 | 管理密码；为空时不启用登录保护 |
| `WEBUI_SESSION_SECRET` | 随机值 | 会话签名密钥；生产环境应固定设置 |
| `WEBUI_SESSION_HOURS` | `12` | 登录会话有效期，允许范围为 1 至 168 小时 |
| `WEBUI_COOKIE_SECURE` | `auto` | 根据 HTTP/HTTPS 自动设置安全 Cookie，也可指定 `true` 或 `false` |
| `WEBUI_TRUST_PROXY` | `false` | 通过可信反向代理部署时可设置为 `true` |
| `PROTOCOL` | `auto` | 隧道连接协议：`auto`、`http2` 或 `quic` |
| `EDGE_IP_VERSION` | `auto` | Cloudflare 边缘连接 IP 版本：`auto`、`4` 或 `6` |
| `EDGE_BIND_ADDRESS` | 空 | 指定隧道连接使用的本地源地址 |
| `METRICS_ENABLE` | `false` | 是否启用 cloudflared 指标服务 |
| `METRICS_PORT` | `60123` | 指标服务监听端口 |

部分运营商线路会限制 QUIC 使用的 UDP 7844。出现隧道连接不稳定时，可以将 `PROTOCOL` 固定为 `http2`。

## 安全设计

- 未登录请求无法访问隧道配置、状态和控制接口。
- 登录会话使用 HMAC-SHA256 签名，Cookie 设置 `HttpOnly` 和 `SameSite=Strict`。
- 同一来源连续登录失败 5 次后，将暂停登录 5 分钟。
- Tunnel Token 仅保存在容器挂载的 `/config/config.json`，管理页面不会返回完整内容。
- 配置目录、环境变量文件和备份文件应限制为管理员访问。

详细安全说明见 [SECURITY.md](SECURITY.md)。

## 更新与回滚

建议在生产环境使用明确的版本标签，不直接依赖 `latest`。

更新：

```bash
docker compose pull
docker compose up -d
```

回滚时，将镜像标签改回上一个已验证版本，再重新执行：

```bash
docker compose up -d
```

更新前应备份 `/config` 挂载目录，并确认 Tunnel Token 和启动状态文件完整。

## 从源码构建

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t cloudflared-web-zh-cn:2026.8.2-zh-cn.6 .
```

Dockerfile 会从 Cloudflare 官方发布地址下载对应架构的软件包并进行 SHA-256 校验。

## 许可证与上游项目

- 许可证：[GPL-2.0](LICENSE)
- 上游管理界面：[WisdomSky/Cloudflared-web](https://github.com/WisdomSky/Cloudflared-web)
- cloudflared：[cloudflare/cloudflared](https://github.com/cloudflare/cloudflared)
