FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS frontend-builder

WORKDIR /build

COPY app/frontend/package.json app/frontend/package-lock.json ./
RUN npm ci

COPY app/frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS backend-dependencies

WORKDIR /build

COPY app/backend/package.json app/backend/package-lock.json ./
RUN npm ci --omit=dev

FROM --platform=$BUILDPLATFORM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS cloudflared-builder

ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
ARG CLOUDFLARED_VERSION=2026.8.2

WORKDIR /src

ADD --checksum=sha256:acdf125b7e872be6e1d13116e8054d27b2c4755760b0cdc3b4ee3910edd37b93 \
    https://codeload.github.com/cloudflare/cloudflared/tar.gz/refs/tags/2026.8.2 \
    /tmp/cloudflared-source.tar.gz

RUN set -eu; \
    tar -xzf /tmp/cloudflared-source.tar.gz --strip-components=1 -C /src; \
    mkdir -p /out; \
    if [ "$TARGETARCH" = "arm" ]; then export GOARM="${TARGETVARIANT#v}"; fi; \
    CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
      go build -mod=vendor -trimpath \
      -ldflags="-s -w -buildid= -X main.Version=$CLOUDFLARED_VERSION -X main.BuildTime=2026-08-14T12:23:25Z -X github.com/cloudflare/cloudflared/metrics.Runtime=virtual" \
      -o /out/cloudflared github.com/cloudflare/cloudflared/cmd/cloudflared

FROM gcr.io/distroless/nodejs22-debian13@sha256:c2753c8b3754b5bde34c1bbbaaa81b2e3ddd67604a867c3521257241f281ce0f

ENV VERSION=2026.8.2
ENV APP_VERSION=2026.8.2-zh-cn.11
ENV NODE_ENV=production
ENV UI_LANGUAGE=zh-CN
ENV WEBUI_PORT=14333
ENV METRICS_ENABLE=false
ENV METRICS_PORT=60123
ENV HA_CONNECTIONS=1
ENV CLOUDFLARED_BIN=/usr/local/bin/cloudflared

EXPOSE 14333 60123

USER 0:0
WORKDIR /var/app

LABEL org.opencontainers.image.title="Cloudflared-web 中文版" \
      org.opencontainers.image.version="2026.8.2-zh-cn.11" \
      org.opencontainers.image.source="https://github.com/w87051809/cloudflared-web-zh-cn" \
      org.opencontainers.image.licenses="GPL-2.0-only"

COPY --from=cloudflared-builder --chown=0:0 /out/cloudflared /usr/local/bin/cloudflared
COPY --from=backend-dependencies --chown=0:0 /build/node_modules /var/app/backend/node_modules
COPY --chown=0:0 \
  app/backend/package.json \
  app/backend/app.js \
  app/backend/cloudflare-tunnel.js \
  app/backend/update-auth.js \
  app/backend/updater-client.js \
  app/backend/updater.js \
  /var/app/backend/
COPY --from=frontend-builder --chown=0:0 /build/dist /var/app/frontend/dist

VOLUME /config
VOLUME /root/.cloudflared

ENTRYPOINT ["/nodejs/bin/node", "/var/app/backend/app.js"]
