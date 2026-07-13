# Gate App/orchestrator service image. Secrets are injected at runtime from the
# Fly secret store (fly secrets set ...), never baked into the image.
FROM node:24-trixie-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Pin a Node-24-compatible npm release whose bundled Undici is patched.
RUN npm install --global npm@11.18.0 && corepack enable
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
# Keep the supported distro current and remove build-only package managers from
# the App image. The Action image retains them for customer preview commands.
RUN apt-get update && apt-get install -y --no-install-recommends liblzma5 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=prune /app/node_modules ./node_modules
COPY --from=prune /app/packages ./packages
COPY --from=prune /app/package.json ./package.json
COPY --from=prune /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
EXPOSE 8080
CMD ["node", "packages/service/dist/server.js"]
