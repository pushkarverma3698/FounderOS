#!/usr/bin/env bash
set -euo pipefail

mkdir -p .git/hooks
cat << 'HOOK' > .git/hooks/pre-push
#!/usr/bin/env bash
# Pre-push hook to verify branch name
pnpm verify:branch
HOOK
chmod +x .git/hooks/pre-push
echo "Git pre-push hook installed."
