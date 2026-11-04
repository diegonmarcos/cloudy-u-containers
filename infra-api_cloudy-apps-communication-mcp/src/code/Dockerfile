FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends dnsutils openssh-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY mcp/ ./mcp/

COPY Dockerfile /opt/cloud-builder/Dockerfile
LABEL org.opencontainers.image.source="https://github.com/diegonmarcos/cloud-infra"
LABEL org.opencontainers.image.dockerfile-path="a_solutions/aa-sui_mail-mcp/src/Dockerfile"

# Invoke node + tsx's cli.mjs directly. `npx tsx` (and the
# node_modules/.bin/tsx wrapper) failed at runtime on 2026-04-28 with
# "ERR_MODULE_NOT_FOUND .../node_modules/.bin/package-CeBgXWuR.mjs":
# the bin shim is a real file (not a symlink) on this npm + node:22-slim
# combo, so its `import './package-*.mjs'` resolves relative to .bin/
# instead of the package dir. Skipping the shim avoids it.
CMD ["node", "/app/node_modules/tsx/dist/cli.mjs", "mcp/index.ts", "--http"]
