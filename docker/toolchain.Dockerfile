# Toolchain used by every workflow script and by CI, so the host needs only Docker.
FROM node:26.13.1-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq openssl shellcheck shfmt yq \
  && rm -rf /var/lib/apt/lists/*

# pnpm comes from corepack, pinned by "packageManager" in package.json. Node 25 and later no longer ship
# corepack, so it is installed from npm at a pinned version. pnpm is prepared here so runs need no
# download; the cache stays writable so a newer pinned version can still be fetched by a non-root user.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install --global corepack@0.36.0 \
  && corepack enable \
  && corepack prepare pnpm@12.18.0 --activate \
  && pnpm --version \
  && chmod -R a+rwX /opt/corepack

ENV HOME=/tmp \
    LANG=C.UTF-8
WORKDIR /repo
