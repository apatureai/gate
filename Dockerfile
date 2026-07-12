# Gate App/orchestrator service image. Secrets are injected at runtime from the
# Fly secret store (fly secrets set ...), never baked into the image.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# --- build: install all deps and compile the workspace ---
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

# --- runtime: prune dev deps, keep compiled output ---
FROM build AS prune
RUN pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=prune /app/node_modules ./node_modules
COPY --from=prune /app/packages ./packages
COPY --from=prune /app/package.json ./package.json
COPY --from=prune /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
EXPOSE 8080
CMD ["node", "packages/service/dist/server.js"]
