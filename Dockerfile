FROM node:18-bookworm-slim

ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT

ARG CLOUDFLARED_VERSION=2026.8.2
ARG CLOUDFLARED_BASE_URL="https://github.com/cloudflare/cloudflared/releases/download"

ENV VERSION=$CLOUDFLARED_VERSION
ENV UI_LANGUAGE=zh-CN
ENV WEBUI_PORT=${WEBUI_PORT:-14333}
ENV METRICS_ENABLE=${METRICS_ENABLE:-"false"}
ENV METRICS_PORT=${METRICS_PORT:-60123}

EXPOSE ${WEBUI_PORT}
EXPOSE ${METRICS_PORT}

USER root
WORKDIR /var/app

LABEL org.opencontainers.image.title="Cloudflared-web 中文版" \
      org.opencontainers.image.version="2026.8.2-zh-cn.5" \
      org.opencontainers.image.source="https://github.com/w87051809/cloudflared-web-zh-cn" \
      org.opencontainers.image.licenses="GPL-2.0"

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN if [ "$TARGETVARIANT" = "v7" ]; then \
        CLOUDFLARED_PKG="cloudflared-$TARGETOS-${TARGETARCH}hf.deb"; \
        CLOUDFLARED_SHA256="2ddaadc63910d1704f1a562044b4ae330a924da7a49c5dbd44207eaa91e44a1d"; \
    else \
        CLOUDFLARED_PKG="cloudflared-$TARGETOS-$TARGETARCH.deb"; \
        case "$TARGETARCH" in \
            amd64) CLOUDFLARED_SHA256="c805c7c8102190c04dfc16e3b4cc4acc9007d5b19b3afbcd608ea6fed7645a43" ;; \
            arm64) CLOUDFLARED_SHA256="096739c69f62cace40b144f0e6c81e61333f3d320ce07a265c7b17b5e925731c" ;; \
            386) CLOUDFLARED_SHA256="aa7143b5194b60e4bf3023461b686d1d1f359c84ce9ce6f6c3f597b71cbe338b" ;; \
            *) echo "Unsupported architecture: $TARGETARCH/$TARGETVARIANT" >&2; exit 1 ;; \
        esac; \
    fi && \
    curl -fL --retry 3 --output cloudflared.deb "$CLOUDFLARED_BASE_URL/$CLOUDFLARED_VERSION/$CLOUDFLARED_PKG" && \
    echo "$CLOUDFLARED_SHA256  cloudflared.deb" | sha256sum -c - && \
    dpkg -i cloudflared.deb && \
    rm cloudflared.deb

VOLUME /config
VOLUME /root/.cloudflared

COPY app/backend /var/app/backend
COPY app/frontend /var/app/frontend

RUN cd /var/app/frontend && npm install && npm run build
RUN cd /var/app/backend && npm install

ENTRYPOINT ["node", "/var/app/backend/app.js"]
