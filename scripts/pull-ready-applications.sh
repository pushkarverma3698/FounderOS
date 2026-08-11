#!/usr/bin/env bash
set -euo pipefail

# FounderOS — pull-ready-applications.sh
# Downloads tailored applications and PDFs from S3 to local Desktop folder for manual review.

DEST_DIR="${HOME}/Desktop/Ready_Applications"
BUCKET="${STORAGE_BUCKET:-founderos-assets}"

echo "Syncing ready applications from s3://${BUCKET}/ready-applications/ to ${DEST_DIR}..."

mkdir -p "${DEST_DIR}"

if command -v aws &>/dev/null; then
  aws s3 sync "s3://${BUCKET}/ready-applications/" "${DEST_DIR}/" --exclude "*" --include "*.pdf" --include "*.txt" --include "*.md"
  echo "✅ Downloaded tailored applications to ${DEST_DIR}"
else
  echo "aws CLI not found on local PATH. Downloading via Mac apply client sync..."
  cd "$(dirname "$0")/../mac-client" && .venv/bin/python -m mac_client.sync
  echo "✅ Mac client sync complete."
fi
