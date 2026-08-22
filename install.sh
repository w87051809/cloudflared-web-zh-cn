#!/bin/sh

set -eu
umask 077

VERSION='2026.8.2-zh-cn.13'
IMAGE="ghcr.io/w87051809/cloudflared-web-zh-cn:${VERSION}"
INSTALL_ROOT='/opt/cloudflared-web'
SOCKET_ROOT='/run/cloudflared-web-updater'
BACKUP_ROOT='/www/临时文件'
HELPER_NAME="cloudflared-web-installer-$(date -u +%Y%m%d%H%M%S)-$$"

say() {
  printf '%s\n' "$1"
}

fail() {
  printf '安装失败：%s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = 'Linux' ] || fail '仅支持 Linux、OpenWrt 和 iStoreOS。'
[ "$(id -u)" = '0' ] || fail '请使用 root 账号执行安装命令。'
command -v docker >/dev/null 2>&1 || fail '没有找到 Docker，请先安装并启动 Docker。'
docker info >/dev/null 2>&1 || fail 'Docker 服务没有运行。'

mkdir -p "$INSTALL_ROOT" "$INSTALL_ROOT/config/cloudflared" "$SOCKET_ROOT" "$BACKUP_ROOT"
chmod 700 "$INSTALL_ROOT" "$INSTALL_ROOT/config" "$INSTALL_ROOT/config/cloudflared" "$BACKUP_ROOT"
chmod 770 "$SOCKET_ROOT"

say "正在下载经过版本核对的正式镜像 ${VERSION}……"
docker pull "$IMAGE" >/dev/null

say '正在核对现有安装并补齐完整更新服务……'
docker create \
  --name "$HELPER_NAME" \
  --network host \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --security-opt no-new-privileges:true \
  -v /var/run/docker.sock:/var/run/docker.sock:rw \
  -v "$SOCKET_ROOT:$SOCKET_ROOT:rw" \
  -v "$BACKUP_ROOT:$BACKUP_ROOT:rw" \
  -v "$INSTALL_ROOT:/host-install:rw" \
  --entrypoint /nodejs/bin/node \
  "$IMAGE" \
  /var/app/backend/installer.js >/dev/null

if ! docker start --attach "$HELPER_NAME"; then
  fail "统一安装器没有完成。诊断容器已保留为 ${HELPER_NAME}。"
fi

docker rm "$HELPER_NAME" >/dev/null

say '安装完成：管理服务和一键更新服务均已启用。'
say "当前版本：${VERSION}"
say '管理地址：http://本机IP:14333'
say '默认账号：admin'
say '默认密码：123456789'
say '首次登录后必须修改账号和密码。'
