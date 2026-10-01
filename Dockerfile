# syntax=docker/dockerfile:1
# One Dockerfile for both Node services. Pick one with --build-arg APP=api (or worker):
#   docker build --build-arg APP=api -t sotto-api .
# Multi-stage: dependencies and compilers stay in the build stages; the runtime image only gets
# compiled JavaScript and production node_modules.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Pin pnpm to the version in package.json so local, CI and image builds agree.
RUN npm install -g pnpm@10.34.6 && npm cache clean --force
WORKDIR /repo

FROM base AS build
ARG APP
# Copy manifests first: this layer (the slow install) is cached until a dependency changes.
COPY pnpm-lock.yaml* pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install --no-frozen-lockfile; fi
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
# Build the app and every workspace package it depends on ("..." = with dependencies).
RUN pnpm --filter "@sotto/${APP}..." run build
# A self-contained folder with only production dependencies.
RUN pnpm --filter "@sotto/${APP}" deploy --prod --legacy /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=local
ENV NODE_ENV=production APP=${APP} APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY --from=build --chown=node:node /out /app
# Why non-root: the official image ships a "node" user; a compromised process can't touch the image.
USER node
# Port 4000 is the api, 4100 the worker's health server.
EXPOSE 4000 4100
# Works for both apps: /healthz never depends on the database or queue.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.APP==='worker'?(process.env.WORKER_HEALTH_PORT||4100):(process.env.PORT||4000);fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
