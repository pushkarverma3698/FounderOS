#!/usr/bin/env bash
# FounderOS — Production Start Script
# =====================================
# Handles:
#  - SIGTERM trap for graceful shutdown (Kubernetes/Docker friendly)
#  - Database migration before start
#  - Crash detection

set -euo pipefail

echo "🚀 FounderOS starting..."

# Run migrations first (idempotent)
echo "⚙️  Running database migrations..."
node dist/scripts/setup-db.js

echo "✅ Migrations complete. Starting app..."

# Start the app, capture PID for signal forwarding
node dist/index.js &
APP_PID=$!

# Forward SIGTERM to the app process
trap "echo 'SIGTERM received — draining...'; kill -TERM $APP_PID; wait $APP_PID" SIGTERM SIGINT

# Wait for app process
wait $APP_PID
EXIT_CODE=$?

echo "FounderOS exited with code $EXIT_CODE"
exit $EXIT_CODE
