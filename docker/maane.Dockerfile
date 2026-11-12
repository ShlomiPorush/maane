# syntax=docker/dockerfile:1
# Maane: the server (with the built web UI) and the worker in one image. Build context: repository root.
# The server runs by default; the worker runs with the command `node dist/worker/index.js`.

FROM node:26.13.1-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Node 25 and later no longer ship corepack; it reads the pnpm version from "packageManager".
RUN npm install --global corepack@0.36.0 && corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY config config
COPY packages packages
COPY apps apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @maane/server --filter @maane/worker --filter @maane/web run build

# The bundles need no node_modules. Runs as node on a read-only root file system; only /tmp is written.
FROM node:26.13.1-bookworm-slim
ARG VERSION=dev
ENV NODE_ENV=production \
    MAANE_VERSION=${VERSION} \
    PORT=8080 \
    MAANE_MIGRATIONS_DIR=drizzle \
    MAANE_WEB_DIR=dist/web
WORKDIR /app
COPY --from=build /src/apps/server/dist/server ./dist/server
COPY --from=build /src/apps/worker/dist/worker ./dist/worker
COPY --from=build /src/apps/web/dist ./dist/web
COPY apps/server/drizzle ./drizzle
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 CMD ["node", "dist/server/healthcheck.js"]
CMD ["node", "dist/server/index.js"]
