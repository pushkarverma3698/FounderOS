#!/usr/bin/env bash
# Weekly QA auditor — thin orchestrator. Stages 1–2 run in TS (zero Claude tokens);
# Claude enters only at Stage 3 over a bounded digest. PR only — a human merges.
set -euo pipefail

# --- config (env-overridable) ---
QA_DIR="${QA_DIR:-/opt/founderos-qa}"          # isolated workspace, NOT the live deploy
WINDOW_DAYS="${WINDOW_DAYS:-7}"
TENANT="${TENANT:-turicks}"
DATE="$(date -u +%Y-%m-%d)"
DIGEST="${QA_DIR}/digest.json"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
TG_TOKEN="${TELEGRAM_BOT_TOKEN:?missing}"
TG_CHAT="${FOUNDER_CHAT_ID:?missing}"

notify() { curl -s "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TG_CHAT}" --data-urlencode "text=$1" >/dev/null || true; }

# --- isolated workspace: clean checkout of origin/main ---
cd "$QA_DIR"
git fetch origin --quiet
git reset --hard origin/main --quiet
git clean -fd --quiet
pnpm install --frozen-lockfile --silent

# --- Stage 1+2: harvest (zero Claude tokens) ---
journalctl -u founderos --since "${WINDOW_DAYS} days ago" -o cat --no-pager \
  | { grep -E '"seam"|"level":(4|5)0' || true; } \
  | pnpm -s logreview --days="${WINDOW_DAYS}" --tenant="${TENANT}" --out="${DIGEST}"

SUMMARY="$(cat "${DIGEST%.json}.summary.txt")"

# --- pre-check: is there anything worth a Claude pass? ---
HARD="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${DIGEST}')).hardAnomalies.length)")"
STATE="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${DIGEST}')).stateFindings.length)")"
BORDER="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${DIGEST}')).borderlineTurns.length)")"

# Always write the report + Telegram digest (notify=both, decided).
REPORT="docs/reviews/${DATE}-prod-review.md"
mkdir -p docs/reviews
printf '# Prod review %s\n\n```\n%s\n```\n' "$DATE" "$SUMMARY" > "$REPORT"
notify "📋 Weekly prod QA (${DATE})%0A${SUMMARY:0:3500}"

if [ "$HARD" -eq 0 ] && [ "$STATE" -eq 0 ] && [ "$BORDER" -eq 0 ]; then
  notify "✅ No anomalies this week — no PR."
  exit 0
fi

# --- branch keyed on issue-set content hash (cross-week dedup) ---
HASH="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${DIGEST}')).contentHash)")"
BRANCH="fix/weekly-qa-${HASH}"
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  notify "↩️ Issue set ${HASH} already has open branch ${BRANCH} — skipping duplicate PR."
  exit 0
fi
git checkout -b "$BRANCH"

# --- Stage 3: Claude reasons over the digest only, in this isolated workspace ---
PROMPT="$(cat scripts/log-review/stage3-prompt.md)
Here is digest.json:
$(cat "$DIGEST")"
"$CLAUDE_BIN" -p --dangerously-skip-permissions --add-dir "$QA_DIR" "$PROMPT" || true

# --- P0-1: GATE the PR on a green build. Red build => no PR, founder reviews. ---
if ! pnpm lint >/tmp/qa-lint.log 2>&1; then
  notify "🛑 Auto-fix produced a RED tsc — NO PR. See ${REPORT}. Manual review needed."
  exit 1
fi
if ! pnpm test >/tmp/qa-test.log 2>&1; then
  notify "🛑 Auto-fix FAILED tests — NO PR. See ${REPORT}. Manual review needed."
  exit 1
fi

# --- diff-size guardrail (precise: <=3 files / <=120 lines) ---
FILES_CHANGED="$(git diff --name-only origin/main | wc -l | tr -d ' ')"
LINES_CHANGED="$(git diff --numstat origin/main | awk '{s+=$1+$2} END {print s+0}')"
if [ "$FILES_CHANGED" -gt 3 ] || [ "$LINES_CHANGED" -gt 120 ]; then
  notify "🛑 Diff too large (${FILES_CHANGED} files / ${LINES_CHANGED} lines) — escalating to manual. NO PR."
  exit 1
fi

# --- protected-file denylist ---
if git diff --name-only origin/main | grep -qE 'src/core/config\.ts|src/db/schema\.ts|\.env|^\.github/'; then
  notify "🛑 Patch touches a PROTECTED file — escalating to manual. NO PR."
  exit 1
fi

if [ "$FILES_CHANGED" -eq 0 ]; then
  notify "ℹ️ Claude confirmed no actionable fix this week — report written, no PR."
  exit 0
fi

# --- commit + push (GITHUB_TOKEN via GIT_ASKPASS, off the cmdline) ---
git add -A
git commit -q -m "fix(qa): weekly auto-audit ${DATE} (${HASH})"
export GIT_ASKPASS="$QA_DIR/scripts/git-askpass.sh"  # echoes $GITHUB_TOKEN
git push -u origin "$BRANCH" --quiet
gh pr create --title "Weekly QA auto-fix ${DATE}" \
  --body "$(printf 'Automated weekly QA. Human merges only.\n\n%s\n\nReport: %s' "$SUMMARY" "$REPORT")" \
  || notify "⚠️ gh pr create failed — branch ${BRANCH} pushed, open PR manually."
notify "✅ Weekly QA PR opened on ${BRANCH}. Review + merge."
