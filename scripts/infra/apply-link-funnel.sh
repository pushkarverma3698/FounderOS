#!/usr/bin/env bash
# Publishes the jobs bot's /apply route on public HTTPS through Tailscale Funnel.
# Idempotent: with the mapping already correct it changes nothing and exits 0.
#
#   scripts/infra/apply-link-funnel.sh                   ensure the mapping, print the public base URL
#   scripts/infra/apply-link-funnel.sh --print-base-url  print the base URL only; changes nothing
#
# Public https://<node>.ts.net/apply/<x>  ->  http://127.0.0.1:3001/apply/<x>
#
# Why Funnel: the founder opens the apply link from a phone. Funnel gives a public HTTPS
# endpoint with a Let's Encrypt certificate that tailscaled issues and renews itself, with no DNS
# record to manage and nothing listening on a public port (nginx keeps :80 for the static site).
#
# Measured 2026-10-16 on turicks-dots (tailscale 1.104.1):
#   - `--set-path=/apply` STRIPS the mount before proxying, so the target must carry the path
#     again (`http://127.0.0.1:3001/apply`); with a bare `http://127.0.0.1:3001` the upstream
#     would see `/<x>` instead of `/apply/<x>`.
#   - Only paths under the mount are public; `/`, `/health` and `/apply-x` answer 404 from tailscaled.
#   - `--bg` stores the config in tailscaled's state, so it survives restarts and reboots.
#   - Funnel is switched on per host:port, not per path: every handler on host:443 becomes public.
#     This script therefore refuses to switch Funnel on while another tailnet-only handler sits on :443.
#   - After the first enable, some Funnel relays need 1-3 minutes to learn the route.
#
# Failure: a clear message on stderr and exit 1. deploy/deploy.sh treats that as non-fatal.
set -euo pipefail

APPLY_PATH="/apply"
FUNNEL_PORT=443
UPSTREAM_PORT="${APPLY_LINK_UPSTREAM_PORT:-3001}"
TARGET="http://127.0.0.1:${UPSTREAM_PORT}${APPLY_PATH}"
SET_TIMEOUT="${APPLY_LINK_FUNNEL_TIMEOUT:-45}"

log() { printf 'apply-link-funnel: %s\n' "$*" >&2; }
die() { printf 'apply-link-funnel: ERROR: %s\n' "$*" >&2; exit 1; }
squash() { printf '%s' "$1" | tr '\n' ' ' | cut -c1-300; }

mode="ensure"
case "${1:-}" in
  "") ;;
  --print-base-url) mode="print" ;;
  *) die "unknown argument '$1' (use no argument or --print-base-url)" ;;
esac

command -v tailscale >/dev/null 2>&1 || die "tailscale binary not found on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH (needed to read tailscale JSON)"

# A wedged tailscaled makes the CLI block forever; bound the read-only calls (no `timeout` on a bare Mac: then unbounded).
READ_TMO=""
if command -v timeout >/dev/null 2>&1; then READ_TMO="timeout 20"; fi

# What this node is and may do. Fields: backend state | DNS name | funnel cap | https cap | funnel allowed on FUNNEL_PORT
status_json="$($READ_TMO tailscale status --json --peers=false 2>&1)" || die "tailscale status failed: $(squash "$status_json")"
self="$(printf '%s' "$status_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
port = sys.argv[1]
s = d.get("Self") or {}
caps = set((s.get("CapMap") or {}).keys()) | set(s.get("Capabilities") or [])
allowed = "443,8443,10000"  # the Funnel defaults when the node carries no explicit list
for c in caps:
    if c.startswith("https://tailscale.com/cap/funnel-ports") and "ports=" in c:
        allowed = c.split("ports=", 1)[1]
print("|".join([
    d.get("BackendState", ""),
    (s.get("DNSName") or "").rstrip("."),
    "1" if ("funnel" in caps or "https://tailscale.com/cap/funnel" in caps) else "0",
    "1" if "https" in caps else "0",
    "1" if port in allowed.split(",") else "0",
]))
' "$FUNNEL_PORT" 2>&1)" || die "could not read tailscale status: $(squash "$self")"

IFS='|' read -r backend dns has_funnel has_https port_ok <<<"$self"
[ "$backend" = "Running" ] || die "tailscale is not running (BackendState='$backend')"
[ -n "$dns" ] || die "this node has no MagicDNS name (enable MagicDNS and HTTPS in the tailnet admin console)"

base_url="https://${dns}"

if [ "$mode" = "print" ]; then
  printf '%s\n' "$base_url"
  exit 0
fi

[ "$has_funnel" = "1" ] || die "this node has no 'funnel' capability (grant it in the tailnet policy: nodeAttrs -> funnel)"
[ "$has_https" = "1" ] || die "HTTPS certificates are not enabled for this tailnet (admin console -> DNS -> HTTPS Certificates)"
[ "$port_ok" = "1" ] || die "Funnel is not allowed on port $FUNNEL_PORT for this node (funnel-ports capability)"

hostport="${dns}:${FUNNEL_PORT}"

# Reads the current serve config. Prints: ok|no , funnel flag on host:port , other handlers on host:port (comma list)
current_state() {
  local cfg
  cfg="$($READ_TMO tailscale serve status --json 2>&1)" || { log "tailscale serve status failed: $(squash "$cfg")"; return 1; }
  printf '%s' "$cfg" | python3 -c '
import json, sys
cfg = json.load(sys.stdin) or {}
hp, path, target = sys.argv[1], sys.argv[2], sys.argv[3]
handlers = ((cfg.get("Web") or {}).get(hp) or {}).get("Handlers") or {}
funnel = bool((cfg.get("AllowFunnel") or {}).get(hp))
mine = handlers.get(path) or {}
others = ",".join(sorted(p for p in handlers if p != path))
print("|".join(["ok" if (mine.get("Proxy") == target and funnel) else "no", "1" if funnel else "0", others]))
' "$hostport" "$APPLY_PATH" "$TARGET"
}

state="$(current_state)" || die "could not read the current serve config"
IFS='|' read -r ok funnel_on others <<<"$state"

if [ "$ok" = "ok" ]; then
  log "already published: ${base_url}${APPLY_PATH}/ -> ${TARGET}/ (no change)"
  printf '%s\n' "$base_url"
  exit 0
fi

# Funnel is per host:port. Turning it on here would also publish handlers that are tailnet-only today.
if [ -n "$others" ] && [ "$funnel_on" != "1" ]; then
  die "$hostport carries other tailnet-only handlers ($others); enabling Funnel would publish them. Move them to another port or enable Funnel for them deliberately, then re-run"
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "not root and sudo not found: tailscale funnel needs root or an operator user"
  SUDO="sudo -n"
fi
TIMEOUT=""
if command -v timeout >/dev/null 2>&1; then TIMEOUT="timeout $SET_TIMEOUT"; fi

log "publishing ${base_url}${APPLY_PATH}/ -> ${TARGET}/"
# Only this one mount is touched: never `serve reset` or `funnel reset`, which would wipe unrelated config.
# </dev/null: if the tailnet has not enabled Funnel the CLI prints an admin-console URL and waits; the timeout ends that.
set_out="$($TIMEOUT $SUDO tailscale funnel --yes --bg --https="$FUNNEL_PORT" --set-path="$APPLY_PATH" "$TARGET" </dev/null 2>&1)" \
  || die "tailscale funnel failed: $(squash "$set_out")"

state="$(current_state)" || die "published, but could not read the serve config back"
IFS='|' read -r ok funnel_on others <<<"$state"
[ "$ok" = "ok" ] || die "tailscale funnel returned 0 but ${APPLY_PATH} is not mapped to ${TARGET} with Funnel on"

log "published. Funnel relays can take 1-3 minutes to learn a new route; the first requests may reset."
printf '%s\n' "$base_url"
