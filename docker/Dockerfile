# FounderOS — Multi-stage Dockerfile
# Node 22 Alpine | Build → Prune → Runtime

# ── Stage 1: Dependencies ─────────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Non-root user for security
RUN addgroup -g 1001 -S founderos && adduser -u 1001 -S founderos -G founderos
WORKDIR /app

# Copy only what's needed at runtime
COPY --from=builder --chown=founderos:founderos /app/dist ./dist
COPY --from=builder --chown=founderos:founderos /app/node_modules ./node_modules
COPY --from=builder --chown=founderos:founderos /app/package.json ./package.json
COPY --from=builder --chown=founderos:founderos /app/drizzle ./drizzle
COPY --from=builder --chown=founderos:founderos /app/governance ./governance

USER founderos

ENV NODE_ENV=production
EXPOSE 3000

# Graceful startup: run migrations, then start app
CMD ["node", "dist/index.js"]
