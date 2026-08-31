# syntax=docker/dockerfile:1

# Bun runtime image for the claude-code-provider-proxy.
# Pinned to an explicit version (not :latest) for reproducible builds. For a
# fully immutable base, additionally pin the digest, e.g.
#   FROM oven/bun:1.3.13-alpine@sha256:<digest> AS base
# (resolve the current digest with: docker buildx imagetools inspect oven/bun:1.3.13-alpine)
FROM oven/bun:1.4.0-alpine AS base
WORKDIR /app

# Install dependencies first (better layer caching).
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Final runtime image.
FROM base AS runtime
ENV NODE_ENV=production

# Non-root user (the oven/bun image ships a "bun" user).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# Config is mounted at runtime (see docker-compose.yml); not baked into the image.

EXPOSE 8787
USER bun

# The proxy reads CONFIG_PATH (default ./config.local.jsonc) and PORT/HOST.
CMD ["bun", "run", "src/server.ts"]
