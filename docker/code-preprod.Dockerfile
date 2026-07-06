# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Support Kanban — preprod image
# Multi-stage, non-root, no build toolchain in the final layer.
# Built/pushed by CI as: qtk8s.azurecr.io/support-kanban_code:preprod
# ---------------------------------------------------------------------------

############################
# Stage 1 — deps + prisma generate
############################
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Native addon (bcrypt) needs a toolchain — build stage ONLY.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

# Reproducible install from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Generate the Prisma client against the committed schema (no DB needed).
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

############################
# Stage 2 — runtime
############################
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# tini = correct PID 1 (signal forwarding + zombie reaping); openssl for Prisma.
# Dedicated unprivileged user/group.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin nodejs

# node_modules from the build stage: production + generated Prisma client, and
# the Prisma CLI (used by the k8s init container for `migrate deploy`).
# No compilers ship in the final image.
COPY --from=deps /app/node_modules ./node_modules

# Application code (explicit — keeps the image lean and predictable).
COPY package.json package-lock.json prisma.config.ts prismaClient.js seed-admin.js server.js ./
COPY prisma ./prisma
COPY public ./public
COPY index.html ./

# Writable runtime state dirs (also mounted as volumes in k8s).
RUN mkdir -p /app/data /app/versions \
    && chown -R nodejs:nodejs /app/data /app/versions

USER nodejs
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
