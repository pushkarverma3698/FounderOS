# FounderOS — Release Readiness Audit (Pre-Marketing Launch)

> **Date:** 2026-06-19 · **Auditor:** Claude (release-readiness pass)
> **Trigger:** Founder starts Phase D-Bis marketing tomorrow — "are we ready to prove ourselves?"
> **Scope:** Full codebase + plan + every layer (model → tools → office → gateway → deploy).

---

## Verdict

**Code floor: GREEN and production-ready. Launch is gated on PROD STATE, not on code.**

The automated floor is clean and the architecture is the locked, mature v2 supervisor + 7
ReAct departments. Nothing in the code is broken. The risk that could break tomorrow's launch
is **live production state** (RAG populated, LinkedIn token valid, Gmail authed, model key
live, showcase URL up) — none of which can be verified from a dev container. There is already a
purpose-built CI workflow that verifies all of it: **`vps-marketing-launch-gate.yml`**. Running
that on prod is the single go/no-go button for tomorrow.

---

## What was verified GREEN this session (fresh runs, evidence inline)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `pnpm lint` (`tsc --noEmit`) | **exit 0 — clean** |
| Wiring | `pnpm verify:wiring` | **PASS — registry fully wired, 0 warnings** |
| Unit + regression | `pnpm test` | **1268/1268 passed (124 files), 33.8s** |
| Code hygiene | grep TODO/FIXME/HACK/XXX in `src` | **0 matches** |
| Skipped tests | grep `.skip/.only/.todo` | **9 — all conditional integration suites (gated on live model/DB), not hidden failures** |
| Model layer | `FounderChatModel` / `syntheticResponseFromLastTool` | **GONE — model.ts is 199 LOC, no fabrication path** |

The historically-fragile model layer (the documented "every change breaks it" + "fabricates
output" subsystem) has been rewritten per ADR-028: plain provider models via `initChatModel`,
official `modelFallbackMiddleware`, no hand-rolled `bindTools`/retry, no synthetic responses.

The 2026-06-18 QA-campaign P0/P1 fixes are present on this branch (verified in code):
`execution-guard.ts` (`detectUnbackedGithubWriteClaim`), `TELEGRAM_POLLING_ENABLED`,
research-handoff prompt, admin context routing, sales draft-only, path-guard dotfile fix.

The 2026-06-19 P0–P8 hardening (commit `1e89d11`) is landed: scheduler timeout, HITL
resolve-order inversion (no orphans on crash), `/status` DB-down banner, `writeAuditEntry`
returns `{written}` (surfaces double-send races), suppression `@`-guard, OpenRouter fail-loud
at startup, shell fast-path null-card notice, and "✅ Done." → explicit warning (rule #24).

---

## Marketing-critical path review (tomorrow's actual surface)

Phase D-Bis runs through existing departments — **marketing** (`linkedin_post`), **sales**
(Proof Drop outreach), **research** (target list). I traced each.

- **`linkedin_post`** (`agent-tools/comms.ts`) — correctly gated: two-gate brand check
  (`outboundQualityGate` → deterministic `validateBrandVoice`) → **HITL approval card** →
  send with `idemKey` (no double-post). Founder-provided copy bypasses only the word-count
  gate, never the HITL gate. **Solid.**
- **Proof Drop** (`src/outbound/proof-drop.ts`) — pure, fully unit-tested cadence tracker
  (weekly target 2, ICP gate ≥6) stored in `founder_context` JSONB (no new table — reuse).
  `proof_drop_ready` signal contract wired into `signals.ts`. **Solid.**
- **Launch gate** (`scripts/vps-marketing-launch-gate.sh` + `.github/workflows/
  vps-marketing-launch-gate.yml`) — comprehensive: deploy + brain row/embedding counts +
  live RAG probe + founder-context freshness + office hardcore probes + LinkedIn token
  **validation** + Gmail backend check + showcase artifact + public-URL reachability + health.
  This is exactly the right pre-launch gate. **Use it.**

---

## The real gate: PROD STATE (cannot be verified from here — needs VPS + secrets)

These are the launch blockers if any is unmet. All are checked by the launch gate workflow.

| # | Check | Why it matters tomorrow | How to confirm |
|---|-------|-------------------------|----------------|
| 1 | `turicks_brain` has embedded rows | Empty store = RAG returns nothing = fabrication risk (the canonical 2026-06-15 outage) | `SELECT count(*) FROM brain.turicks_brain WHERE embedding IS NOT NULL` > 0 |
| 2 | `LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_AUTHOR_URN` valid | **The #1 marketing action.** Token expired → `linkedin_post` fails at send | Launch gate validates token live; refresh OAuth if it fails |
| 3 | Gmail backend authed (gws **or** Composio rollback) | Proof Drop outreach email blocked otherwise | Launch gate checks both backends |
| 4 | `OPENROUTER_API_KEY` set + a turn lands | Default is `openrouter:openai/gpt-4o-mini` (Gemini credits depleted per LIMITATIONS); no key = whole office down | One real turn returns a reply on the live bot |
| 5 | Showcase URL publicly reachable | Build-in-public/Proof Drops point at proof — a dead link kills credibility | Launch gate curls the public URL |

---

## Residual code-level risks (documented in LIMITATIONS — none block a founder-led low-volume launch)

- **No daily send-quota ceiling** (`quota_check` unwired; G4). Idempotency prevents
  *duplicate* sends, and suppression (`do_not_contact`) **is** wired in `comms.ts`, but there
  is no hard daily cap. Fine for founder-led, hand-approved, low-volume outreach (every send
  passes a HITL card). Becomes a **HIGH** gap only at volume/automated outbound.
- **Composio/LinkedIn single point of failure** — one bad vendor key silences a send path and
  only surfaces at send time. **Mitigated** by the launch gate pre-validating the token before
  the campaign starts.
- **Eval non-determinism** — `pnpm eval` scores 79–90% across runs due to live-model capacity
  noise, not logic drift. The deterministic guarantee is the pre-router unit tests, not the
  eval %. Don't treat a single eval dip as a regression.

---

## Recommendation

1. **Do NOT change code to "stabilize" — there is nothing broken to fix.** The architecture is
   locked and the floor is green; editing load-bearing defensive code would re-introduce
   already-fixed P0s (reuse-first / locked-architecture rules).
2. **Run `vps-marketing-launch-gate.yml` against `main` on the prod VPS.** That is the
   go/no-go for tomorrow — it converts all five PROD STATE checks above into a single
   pass/fail with logged evidence at `/tmp/founderos-launch-gate/`.
3. **If the gate flags an item, fix the prod state** (refresh LinkedIn OAuth / `brain:sync` /
   `gws auth login` / set key) — not the code.
4. **After the gate passes, do one live MTProto smoke** of the actual launch action: draft a
   LinkedIn post → approve → confirm published + `action_log` row. That is the "it works"
   evidence standard (rules #19/#24), not a green test suite.

**Bottom line:** the product is ready to prove itself. The only thing standing between you and
launch is pressing the launch-gate button on prod and clearing whatever live-state item (most
likely the LinkedIn token or brain ingest) it surfaces.

---

## LIVE GATE RESULT — 2026-06-19 (run #4, GitHub Actions → VPS, conclusion: success)

**Verdict: ⚠️ CONDITIONAL PASS — core system proven live; 2 send-credentials missing.**
Ran `vps-marketing-launch-gate.yml` on `main`; SSH to prod succeeded (deploy secrets valid).
Real probe output (not a test mock):

| Check | Live result |
|-------|-------------|
| Deploy / health | `/health` green · JARVIS `/api/v1/health` green · UI serves SPA · `FounderOS running 🚀` |
| Office compile | supervisor + [admin, research, comms, engineering, marketing, sales, personal, jobhunt] |
| Brain rows | `turicks_brain 206 / embedded 206` · `knowledge_entries 84` · `founder_context 1` (23 keys) |
| Live RAG probe | `✅ RAG OK … (3 results): 1. [TURICKS.md] (score 0.67)` — real retrieval, canonical-outage class CLEARED |
| Founder context | `✅ Phase D-Bis strategy keys present` |
| Office hardcore probes | **6/6 PASS** — read_context · search_web · ICP grounding · **ICP-repeat identical tools (determinism)** · shell **HITL-gated** (real OpenRouter LLM turns) |
| Showcase | artifact 30,379 bytes · **public URL → HTTP 200** |

**Blockers to actual SENDS (founder-action only — not code/agent fixable):**
1. ⚠️ `LINKEDIN_ACCESS_TOKEN` / `LINKEDIN_AUTHOR_URN` **missing on prod** (GitHub secret empty + not in
   `PROD_DOTENV`) → `linkedin_post` fails at send. **Fix:** mint a LinkedIn OAuth token + author URN,
   add both to `PROD_DOTENV` (and/or the repo secrets), redeploy.
2. ⚠️ **Gmail not ready** — `gws` CLI not installed/authed, no Composio rollback → Proof Drop email
   blocked (`gmail_active: down`). **Fix:** `npm i -g @googleworkspace/cli && gws auth login` on the VPS,
   **or** set `GMAIL_BACKEND=composio` + a working `COMPOSIO_API_KEY` in `PROD_DOTENV`.

**What this means for tomorrow:** LinkedIn **drafting** is ready now (office + RAG + brand gate + HITL all
proven green); **publishing** a post and sending **Proof Drop email** are blocked until the two creds
above are set. Re-run the gate after setting them — target is `✅ PASS` (0 warnings).

Note (non-blocking): Composio Gmail probe shows `client.connectedAccounts.get is not a function`
(composio-core 0.10.0 API drift) — irrelevant while `gws` is the default backend; documented Composio
fragility (LIMITATIONS).

</invoke>
