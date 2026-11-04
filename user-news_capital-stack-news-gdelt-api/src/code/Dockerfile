FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY dist/ ./dist/
RUN mkdir -p /app/cache

EXPOSE 3019
CMD ["node", "dist/server.js"]

LABEL org.opencontainers.image.source="https://github.com/diegonmarcos/cloud-infra"
LABEL org.opencontainers.image.description="GDELT News Aggregator — Fastify API with SQLite cache"
LABEL org.opencontainers.image.title="news-gdelt"
