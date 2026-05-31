#!/usr/bin/env bash
# FounderOS — One-command local setup
# Usage: ./setup.sh
set -euo pipefail

echo "FounderOS Setup"

# 1. Check prereqs
command -v node >/dev/null || { echo "Node 22+ required"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm required: npm i -g pnpm"; exit 1; }
command -v docker >/dev/null || { echo "Docker required"; exit 1; }

# 2. Install deps
echo "Installing dependencies..."
pnpm install

# 3. Check .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env created from .env.example — fill in your API keys before continuing"
  echo "   Required: GOOGLE_GENERATIVE_AI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
  echo "   Optional: ANTHROPIC_API_KEY, COMPOSIO_API_KEY, FIRECRAWL_API_KEY, GITHUB_TOKEN"
  exit 0
fi

# 4. Start Postgres + Redis
echo "Starting Postgres + Redis..."
docker compose up -d postgres redis

# Wait for Postgres to be ready
echo "Waiting for Postgres..."
until docker compose exec -T postgres pg_isready -U founderos >/dev/null 2>&1; do
  sleep 1
done

# 5. Run DB migrations
echo "Running migrations..."
npx drizzle-kit migrate

# 6. Verify
echo "Running smoke test..."
npx tsx -e "import('./src/core/registry.js').then(m => { const a = m.getAgent('lead_intel'); console.log('Registry OK:', a?.name); })"

echo ""
echo "FounderOS ready!"
echo "   Start:  npx tsx src/index.ts"
echo "   Test:   pnpm test"
echo "   Health: curl localhost:3000/health"
