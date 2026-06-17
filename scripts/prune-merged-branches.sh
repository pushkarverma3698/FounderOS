#!/usr/bin/env bash
# Delete remote branches already merged into main. Keeps main, stable, beta.
# Usage: ./scripts/prune-merged-branches.sh [--dry-run]
set -euo pipefail

DRY="${1:-}"
REPO="${GITHUB_REPOSITORY:-pushkarverma3698/FounderOS}"
KEEP='^(main|stable|beta|HEAD)$'

git fetch origin --prune

while read -r branch; do
  [[ -z "$branch" ]] && continue
  [[ "$branch" == *"->"* ]] && continue
  if [[ "$branch" =~ $KEEP ]]; then
    continue
  fi
  if [[ "$DRY" == "--dry-run" ]]; then
    echo "would delete: $branch"
  else
    echo "deleting: $branch"
    gh api -X DELETE "repos/${REPO}/git/refs/heads/${branch}" || true
  fi
done < <(git branch -r --merged origin/main | sed 's|^[[:space:]]*origin/||')

echo "Done."
