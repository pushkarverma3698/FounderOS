# Prod Runbook — Never Again (1 page)

## 1. "The bot feels dumb" — diagnose in 5 minutes
```bash
ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12
cd /opt/founderos && git log --oneline -1          # what's deployed
journalctl -q -u founderos --since "-6h" -o cat \
  | grep -o '"seam":"[a-z.]*"' | sort | uniq -c    # turn health at a glance
journalctl -q -u founderos --since "-6h" -o cat \
  | grep '"seam":"turn.error"'                     # the actual failures
```
Read the failing turnId's full trace: `journalctl ... | grep <turnId>`.
Classify before touching anything: config (env), provider (4xx/5xx), kernel
(validation failure), or context (wrong task retried).

## 2. Any manual .env edit on the VPS → refresh the snapshot IMMEDIATELY
```bash
cp .env .env.bak.$(date +%Y%m%d-%H%M)              # on the VPS, before editing
# ...edit .env...
sudo systemctl restart founderos && sleep 15
journalctl -q -u founderos --since "-1m" -o cat | grep '\[boot\]'   # verify
# then FROM THE MAC (never print the contents):
ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12 \
  'base64 -w0 /opt/founderos/.env' | gh secret set PROD_DOTENV --repo pushkarverma3698/FounderOS
scp -i ~/.ssh/founderos_deploy founderos@95.217.162.12:/opt/founderos/.env \
  ~/Projects/founderos/.env.production
```
A key that lives only on the box WILL be wiped by the next deploy.
New runtime-owned keys also go into `PRESERVE_IF_MISSING` in
`scripts/apply-prod-env-overrides.sh`.

## 3. Boot report is the health contract
After every restart/deploy: every line of `[boot]` + provider probes must be
LIVE/UP or explainable. A MISSING that "should be set" means either the wipe
(§2) or a key absent from `envSchema` in `src/core/config.ts` (Zod strips
unknown keys — the report reads only parsed env).

## 4. Provider rules
- Model ids and API versions live in CODE with a test pinning them; env may
  only pin FORWARD (`LINKEDIN_API_VERSION` floor pattern).
- Rolling aliases (`gemini-flash-latest`) can change response SHAPE — kernel
  text extraction goes through `messageContentText()` only.
- Vendor SDK upgrades: the real-import surface tests
  (`composio-sdk-surface.test.ts`) fail if the SDK shape moves.

## 5. Fix discipline (unchanged, now with teeth)
Failing test FIRST → fix → `pnpm gate` → PR to **beta** (never main) → founder
merges → CD deploys → verify the live seam (turn.in → tool.call → turn.out in
journal) → update memory docs. If any step is skipped, say NOT VERIFIED.
