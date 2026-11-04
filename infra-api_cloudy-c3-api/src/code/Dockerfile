FROM node:22-bookworm-slim

WORKDIR /app

# System deps: SSH for remote VM commands, curl for healthcheck + API calls, ping for WG checks
# git for read-only repo clones (engines need source files)
# Build tools for better-sqlite3 (native module) — only needed if prebuilt binaries fail
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssh-client \
    iputils-ping \
    curl \
    git \
    python3 \
    build-essential \
    dnsutils \
    openssl \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Install npm dependencies (src/package.json is the Docker-context copy)
COPY package.json ./
RUN npm install --omit=dev && npm install tsx

# Copy TypeScript config and source (context = src/)
COPY tsconfig.json ./
COPY shared/ ./src/shared/
COPY api/ ./src/api/
COPY dash/dist/ ./src/dash/dist/

# Entrypoint: fix SSH keys, start API
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# SSH: known_hosts for host key verification
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8081/health || exit 1

COPY Dockerfile /opt/cloud-builder/Dockerfile
LABEL org.opencontainers.image.source="https://github.com/diegonmarcos/cloud-infra"
LABEL org.opencontainers.image.dockerfile-path="a_solutions/bc-obs_c3-infra-api/src/Dockerfile"

ENTRYPOINT ["./entrypoint.sh"]
