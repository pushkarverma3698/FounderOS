# Production Stabilization Memory — 2026-07-12

Why prod "didn't feel intelligent," what actually broke, and the invariants
that keep it fixed. Companion runbook: [RUNBOOK-PROD-NEVER-AGAIN.md](./RUNBOOK-PROD-NEVER-AGAIN.md).

## The five failure classes (all root-caused from live traces)

### 1. Env-render wipe/staleness (config class)
The deploy renderer (`scripts/apply-prod-env-overrides.sh`) rewrote `.env`
from the PROD_DOTENV snapshot. Any on-box key provisioned AFTER the snapshot
was wiped (APIFY_TOKEN, STORAGE_*/AWS_* — S3 went LIVE→MISSING between two
boots on 2026-07-12), and any STALE snapshot value silently downgraded working
config (`LINKEDIN_API_VERSION=202405` → every LinkedIn call 426'd;
`GWS_BIN=` empty → `execFile("")` → "The argument 'file' cannot be empty" on
every Gmail read).

**Fixes:** renderer preserves a named key list when the snapshot value is
absent OR empty; `getLinkedInApiVersion()` treats the code default as a floor
(env pin can only move forward); `getGwsBin()` falls back to `"gws"`.
**Invariant:** every manual `.env` edit on the VPS is followed IMMEDIATELY by
a PROD_DOTENV refresh (runbook §2). A key that exists only on the box is a
key scheduled for deletion.

### 2. Mock-drift (SDK class)
Composio probes called `getClient().connectedAccounts` — a surface that does
not exist in @composio/core 0.10.0. Unit tests mocked the imagined shape, so
CI stayed green while prod crashed. **Fix:** probes use the real instance
surface; `tests/unit/infra/composio-sdk-surface.test.ts` imports the REAL SDK
and asserts the surface. **Invariant:** any probe/tool against a vendor SDK
gets a real-import surface test.

### 3. Model-alias drift (provider class)
`gemini-flash-latest` is a rolling alias. When Google moved it, responses
started arriving as ARRAYS of content parts; the kernel extracted text with
`typeof content === "string"` and threw honest answers away — turns died with
"Worker did not finalize with JSON for text.summary" (d211fb74, 8c7e098f).
Separately, hardcoded model ids rot: `gemini-3-1-flash-image` (dash) 404'd;
the live id is `gemini-3.1-flash-image` (dot).

**Fixes:** `src/kernel/message-text.ts` `messageContentText()` used by
worker/planner/synthesizer; image ids pinned by test against the verified
live ids. **Invariant:** kernel nodes never read `.content` directly.

### 4. Checkpoint amnesia on hard failure (context class)
A turn that died hard (180s timeout, model exhaustion) left `reply=""` in the
checkpoint, so `summarizePreviousTurn` skipped it — the next turn planned with
NO memory of the failure. Live: "Try again" (33f64116) re-ran the email task
from two turns earlier instead of the LinkedIn task that had just died. This
was the single biggest "it's dumb" driver.

**Fix:** `src/gateway/failed-turn-fold.ts` writes `{last_turn, failure,
reply}` into the thread state from the gateway catch path, so the failed turn
lands in history as `[turn failed] …`. **Invariant:** every founder-visible
error also lands in thread history.

### 5. Free-fallback rate-limit clustering (model chain class)
Gemini 503 (seconds-long spike) → both free OpenRouter fallbacks 429'd
together (shared daily quotas) → turn died showing a raw SDK stack
(68eae59d). **Fixes:** post-chain single retry of the primary after 2.5s;
friendly "provider overloaded — try again in a minute" reply. Combined with
class 4, "try again" now actually works after provider blips.

## Verified state (2026-07-12)

- VPS `.env` fixed + service restarted 09:55 UTC: LinkedIn direct probe UP
  (was 426), gws executes and reports a real auth-needed message, PROD_DOTENV
  refreshed from box, Mac `.env.production` synced.
- All code fixes in PR #326 (branch `fix/prod-stabilization-seams` → beta):
  gate green 143 files / 1447 tests, kernel e2e double-run identical 14/14.
- NOT VERIFIED live: kernel code fixes on prod (await merge → deploy), image
  gen end-to-end (needs S3 keys), Gmail (needs `gws auth login`).

## Founder-only items (cannot be self-served)

1. **APIFY_TOKEN** — wiped by the render, unrecoverable on box. Re-provide
   from apify.com Console → Integrations, then runbook §2.
2. **S3/R2 storage keys** (STORAGE_BUCKET, AWS_ACCESS_KEY_ID,
   AWS_SECRET_ACCESS_KEY, optional STORAGE_ENDPOINT_URL) — same wipe, image
   delivery blocked without them.
3. **`gws auth login`** on the VPS (browser OAuth) — Gmail/Calendar backend.
4. **LinkedIn `r_member_social` scope** (optional) — real read-API access to
   own posts; until then the audit-log fallback (with text) covers it.
5. **Merge PR #326** to beta, promote to main → CD deploys the kernel fixes.
