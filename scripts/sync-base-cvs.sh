#!/usr/bin/env bash
set -euo pipefail

# FounderOS — sync-base-cvs.sh
# Uploads local master Markdown CVs from personal-rag to S3 base-cvs location.

HOME_DIR="${HOME:-/Users/pushkarverma}"
CV_SRC_DIR="${HOME_DIR}/Projects/personal-rag/data/local_docs/cv"
BUCKET="${STORAGE_BUCKET:-founderos-assets}"

if [ ! -d "$CV_SRC_DIR" ]; then
  echo "Error: CV source directory not found at ${CV_SRC_DIR}"
  exit 1
fi

echo "Uploading master base CVs to s3://${BUCKET}/base-cvs/..."

for track in ai backend frontend; do
  cv_file="${CV_SRC_DIR}/${track}/cv.md"
  if [ -f "$cv_file" ]; then
    echo "  -> Uploading ${track}/cv.md"
    aws s3 cp "$cv_file" "s3://${BUCKET}/base-cvs/${track}/cv.md"
  else
    echo "  -> Warning: ${cv_file} not found, skipping."
  fi
done

master_file="${HOME_DIR}/Projects/personal-rag/data/local_docs/cv-master.md"
if [ -f "$master_file" ]; then
  echo "  -> Uploading cv-master.md"
  aws s3 cp "$master_file" "s3://${BUCKET}/base-cvs/cv-master.md"
fi

echo "✅ Base CV sync complete."
