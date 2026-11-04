FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev && npm install tsx

COPY tsconfig.json ./
COPY shared/ ./src/shared/
COPY api/ ./src/api/
COPY registry/ ./src/registry/

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8082/health || exit 1

COPY Dockerfile /opt/cloud-builder/Dockerfile
LABEL org.opencontainers.image.source="https://github.com/diegonmarcos/cloud-infra"
LABEL org.opencontainers.image.dockerfile-path="a_solutions/bc-obs_c3-services-api/src/Dockerfile"

ENTRYPOINT ["./entrypoint.sh"]
