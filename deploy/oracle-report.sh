#!/usr/bin/env bash
# oracle-report.sh - the post-deploy oracle report, run on the VPS by the Deploy workflow after the restart.
#
# Reads exactly five keys from the app's .env (never sources it: a .env is not shell), runs scripts/oracle-report.ts
# against the commit that is checked out, and ALWAYS exits 0. A report is not a gate: prod is already live and healthy
# by the time this runs, so a red here would only say the report could not be made, and the script prints why.
#
# Bash 3.2 safe. Overrides exist for tests: ORACLE_REPORT_ROOT, ORACLE_REPORT_ENV_FILE, ORACLE_REPORT_NODE.
set -u

ROOT="${ORACLE_REPORT_ROOT:-/opt/founderos}"
ENV_FILE="${ORACLE_REPORT_ENV_FILE:-$ROOT/.env}"
NODE="${ORACLE_REPORT_NODE:-node}"

env_val() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'\r'; }

# A value already in the environment wins; otherwise the .env value, when there is one.
args=()
for key in AGENT_PIPELINE_V2 FOUNDEROS_CONTRACTS_DIR ORACLE_ALLOWED_HOSTS TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
  val="${!key:-}"
  [[ -n "$val" ]] || val="$(env_val "$key")"
  [[ -z "$val" ]] || args+=("$key=$val")
done

deployed="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
if [[ ! "$deployed" =~ ^[0-9a-f]{40}$ ]]; then
  echo '{"status":"FAILED","error":"could not read the deployed commit"}'
  exit 0
fi

cd "$ROOT" || { echo '{"status":"FAILED","error":"app directory missing"}'; exit 0; }
env ${args[@]+"${args[@]}"} ORACLE_REPORT_REPO="$ROOT" "$NODE" --import tsx/esm scripts/oracle-report.ts --deployed "$deployed" 2>&1 \
  || echo '{"status":"FAILED","error":"the report script exited non-zero"}'
exit 0
