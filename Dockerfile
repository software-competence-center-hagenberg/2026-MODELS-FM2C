# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS app

WORKDIR /app

# Keep dev dependencies in the image: the server builds generated Vite views at runtime.
ENV NODE_ENV=production \
    PORT=8787 \
    GENERATED_DATA_DIR=/app/data \
    GENERATED_WORKSPACES_DIR=/app/generated-workspaces \
    GENERATED_DIST_DIR=/app/generated-dist \
    OPENCODE_DISABLE_AUTOUPDATE=true

COPY package.json package-lock.json ./

# Install project dependencies plus the opencode CLI used by the generation worker.
# Pin with: docker build --build-arg OPENCODE_VERSION=1.17.7 .
ARG OPENCODE_VERSION=latest
RUN npm ci --include=dev \
    && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

COPY . .

RUN apt-get update \
    && apt-get install -y --no-install-recommends iptables ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm run build \
    && mkdir -p /app/data /app/generated-workspaces /app/generated-dist \
    && chown -R node:node /app/data /app/generated-workspaces /app/generated-dist

# Egress lockdown script for the worker process
COPY server/worker-entrypoint.sh /app/server/worker-entrypoint.sh
RUN chmod +x /app/server/worker-entrypoint.sh

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["/app/server/worker-entrypoint.sh"]
