# RCA — Prod Hardcore QA failure (2026-07-01)

**Trigger:** `VPS Prod Hardcore QA` run `28539839922` on `main` (`504c029`) → **PARTIAL/failure**
(exit 1) after ~9 min. Evidence: GitHub Actions job `84610535209` log.

**One-line summary:** The agent itself behaved *correctly* — the failure was entirely
**deploy/config plumbing** in one shared script (`scripts/apply-prod-env-overrides.sh`),
which is the **last writer of `/opt/founderos/.env`** in every workflow. It silently
(1) reverted the Gemini 2.5 Pro pin back to Flash and (2) clobbered the live MTProto
tester session. A third, separate issue took Gmail down. None of these are model/agent
bugs.

---

## What actually passed (important — the product is not hallucinating)

Run on the model that was *actually* live (**Flash**, see Finding 1), on the real prod graph:

- **DB state populated** (rule #22): `turicks_brain=263`, `embedded=263`, `knowledge_entries=102`, `founder_context=1`.
- **Live RAG probe:** `success:true`, real ICP hit at score 0.68.
- **Office hardcore probes: 6/6 PASS** — incl. `T24-icp-repeat` where the *repeat* call passed **both** times (no loop), and `T25-shell-hitl` correctly gated.
- **Hallucination stress: 7/7 PASS, 0 fail** — the model **honestly refused** when it lacked data ("I couldn't find specific information about Turicks' ICP…") and **honestly surfaced** the email outage ("I am unable to read your emails… The email read failed") instead of fabricating. This is exactly the "know when you're blocked, don't hallucinate" behaviour we want.

So: the reliability story is *good*. The run went red purely on the four issues below.

---

## Finding 1 — 🔴 CRITICAL: Gemini 2.5 Pro was never actually live

**Symptom:** We "deployed Pro" (PR #257) and I claimed it was live off the deploy log line
`==> Patched .env: AGENT_MODEL=…gemini-2.5-pro`. That was wrong.

**Root cause:** `scripts/apply-prod-env-overrides.sh` runs **after** `deploy.yml`'s inline
patch (deploy.yml calls it at the end) and **hard-coded** the old model:
```sh
printf '%s\n' 'AGENT_MODEL=openrouter:google/gemini-2.5-flash'
printf '%s\n' 'AGENT_FALLBACK_MODELS=anthropic:claude-haiku-4-5'
```
Because this script is the **last** writer of `.env`, it overwrote the Pro pin every time.
The deploy log proves the sequence: `…pro` at 17:05:35, then `Rendered .env from PROD_DOTENV`
+ `Patched .env: AGENT_MODEL` at 17:05:36 (the shared script re-writing Flash). PR #257 only
edited `deploy.yml` — not this script — so prod stayed on Flash. **The entire Pro trial, and
the 6/6 + 7/7 passes above, ran on Flash.**

**Fix (applied):** `apply-prod-env-overrides.sh` now pins
`AGENT_MODEL=openrouter:google/gemini-2.5-pro` and `AGENT_FALLBACK_MODELS=…flash,…haiku`,
matching `deploy.yml` + CLAUDE.md. This script is now the single source of truth for the
prod model.

**Lesson (rule #22/#24):** verify prod *state* (the final `.env` / running model), not one
intermediate log line. A later step can undo an earlier one.

---

## Finding 2 — 🟠 HIGH: MTProto E2E always fails (`AUTH_KEY_DUPLICATED`)

**Symptom:** `✗ RPCError: 406: AUTH_KEY_DUPLICATED` the moment `e2e-telegram-qa.ts` connects
→ E2E exit 1 → whole run marked failure.

**Root cause:** `TELEGRAM_TESTER_SESSION` is a runtime artifact written on the box by an
on-box re-login; it is **not** in `PROD_DOTENV`. `apply-prod-env-overrides.sh` re-renders
`.env` from `PROD_DOTENV` **without preserving** it, so the live session is replaced by the
stale one baked into the secret → Telegram revokes the auth key. The preservation fix
existed **only** in `deploy.yml`'s inline block — but since the shared script runs *last* and
lacks it, the inline fix is immediately undone. Every deploy/QA leaves the box with the stale
session, so MTProto QA can never authenticate.

**Why the existing test didn't catch it (rule #19):** `scripts/test-deploy-env-render.sh`
tested a *copy* of the deploy.yml block, never the real `apply-prod-env-overrides.sh` — green
test, shipped bug.

**Fix (applied):** `apply-prod-env-overrides.sh` now captures the on-box
`TELEGRAM_TESTER_SESSION` before the render and re-injects it after. `test-deploy-env-render.sh`
now invokes the **real** script and asserts both the session preservation and the Pro pin.
(⚠️ If the current on-box session is *already* revoked from prior clobbers, a one-time re-login
is needed: `npx tsx --env-file=.env scripts/telegram-tester.ts login`, then re-run QA.)

---

## Finding 3 — 🟡 MEDIUM: Gmail is down in prod (read/send non-functional)

**Symptom (health `degraded`):**
`gws not ready: The argument 'file' cannot be empty. Received ''` and, on the composio
fallback, `client.connectedAccounts.get is not a function`.

**Root cause(s):**
- **gws backend:** `getGwsBin()` used `envOr("GWS_BIN") ?? "gws"`. `??` only falls back on
  `undefined` — an **empty** `GWS_BIN=` (very likely from the rendered prod `.env`) passes
  through as `""`, and `execFile("", …)` throws exactly "The argument 'file' cannot be empty".
- **composio fallback:** `composio-core@0.10.0` is outdated (`connectedAccounts.get` removed);
  it can't serve as a fallback.

**Fix (applied, partial):** `getGwsBin()` now uses `|| "gws"` so an empty value falls back to
the default binary (regression test added). **Still needs box-side verification (I can't SSH):**
confirm the `gws` CLI is installed + authed on the VPS, and that `GWS_BIN` in prod `.env` is
either unset or a valid path. If the `gws` binary genuinely isn't installed/authed, the code
fallback isn't enough — install/auth it or set `GMAIL_BACKEND=composio` after upgrading
`composio-core`.

**Note:** this did **not** cause the run to fail (the hallucination suite passed *because* the
bot honestly reported the email failure) — but Gmail read/send are unusable until fixed.

---

## Finding 4 — 🔵 LOW: Observability off in prod

**Symptom:** `[boot] Observability (LangSmith) MISSING — tracing off`.
**Cause:** `LANGCHAIN_API_KEY` / `LANGCHAIN_TRACING_V2` unset in prod `.env`.
**Fix:** set both in `PROD_DOTENV` if per-turn tracing is wanted. Not blocking; the budget
seam (`turn.out`) still logs cost/tokens.

---

## Deeper root cause (the pattern behind Findings 1 & 2)

**Deploy `.env` logic is duplicated between `deploy.yml` (inline) and
`apply-prod-env-overrides.sh` (shared), and the shared one runs last but was the
less-correct copy.** Fixes were made to the workflow copy; the shared copy silently overrode
them. **Remediation direction (follow-up, not yet done):** make
`apply-prod-env-overrides.sh` the *single* source of truth for rendering + preserving +
pinning, and reduce `deploy.yml` to just call it — so there is one place to be correct and
one place the test must cover.

---

## Fix status

| # | Issue | Severity | Fix | Verified |
|---|-------|----------|-----|----------|
| 1 | Pro pin reverted to Flash | CRITICAL | `apply-prod-env-overrides.sh` pins Pro | ✅ regression test (real script) |
| 2 | `AUTH_KEY_DUPLICATED` | HIGH | session preserved in shared script | ✅ regression test (real script) |
| 3 | Gmail gws empty-binary | MEDIUM | `getGwsBin()` `\|\|` fallback + unit tests | ✅ unit; ⚠️ box gws install NOT verified (no SSH) |
| 4 | LangSmith off | LOW | set env in PROD_DOTENV | ⛔ needs founder |
| — | Deploy logic duplicated | — | consolidate into shared script | ⛔ follow-up |

All applied fixes: `tsc` clean, `test-deploy-env-render.sh` PASS, `provider-config` 9/9.

## Next step (founder decision)

Deploying these fixes will, for the first time, put **Gemini 2.5 Pro genuinely live** (the
~30× cost profile). That is a conscious cost decision — hence this is documented and left for
explicit go-ahead rather than auto-deployed. On merge + deploy: re-run the hardcore QA; if the
on-box tester session was already revoked, do the one-time `telegram-tester.ts login` first.
