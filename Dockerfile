# Gate App/orchestrator service image. Secrets are injected at runtime from the
# Fly secret store (fly secrets set ...), never baked into the image.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# The upstream Node 24 image's bundled npm carries Undici 6.26.0; npm 12.0.1
# bundles the fixed 6.27.0 while retaining Node 24 support.
RUN npm install --global npm@12.0.1 && corepack enable
WORKDIR /app

# --- build: install all deps and compile the workspace ---
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

# --- runtime: prune dev deps, keep compiled output ---
FROM build AS prune
RUN rm -rf node_modules packages/*/node_modules \
  && pnpm install --prod --offline --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=prune /app/node_modules ./node_modules
COPY --from=prune /app/packages ./packages
COPY --from=prune /app/package.json ./package.json
COPY --from=prune /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
EXPOSE 8080
CMD ["node", "packages/service/dist/server.js"]
