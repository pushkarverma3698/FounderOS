# FounderOS — Production Wrap-Up

*What's left to call production "done." Written 2026-06-14, the day we went live.*

We are live: `main` auto-deploys to the VPS, the bot runs 24/7, and the real
founder path (route → draft → HITL → send → audit) works end-to-end. This doc is
the short list of what turns "it runs" into "I trust it unattended."

Each item is scored against the project's own bar (rule #17): it ships only if it
produces a **real outcome**, closes a **named reliability/hiring gap**, and is
**mostly reuse**. Anything that fails that test is parked in §4.

---

## 1. Do now — the unattended-trust gap (highest impact)

These are the difference between "I have to babysit it" and "it pages me only when
something is actually wrong."

| # | Item | Why it matters | Effort |
|---|------|----------------|--------|
| 1.1 | **Boot-time key _validation_, not just presence** | The first deploy booted "fine" on stale keys and then failed every LLM call with `400 API_KEY_INVALID`. `config.ts` checks keys exist; it does not check they work. Add a one-shot live ping per integration to `boot-report.ts` (Gemini/GitHub/Composio — the curl checks are already in DEPLOYMENT.md §3) and log `LIVE/INVALID/MISSING`. Optionally fail-fast on an invalid LLM key in prod. | S |
| 1.2 | **Uptime + crash alerting to Telegram** | `/health` is loopback-only; nothing tells you if the box died. Add the 5-min `/health` cron from DEPLOYMENT.md §7 that pings you on failure. Closes the "silent death" gap. | S |
| 1.3 | **Verify the nightly backup actually runs + test a restore** | `deploy/backup-db.sh` + the cron are documented, but a backup you have never restored is a hope, not a backup. Confirm the cron is installed, the dump lands, and do one restore drill into a throwaway DB. Add off-box sync (Hetzner Storage Box). | S |
| 1.4 | **Rotate the keys flagged during QA** | The E2E sweep surfaced rc-file key exposure (OPENAI/OPENROUTER/gateway) and we churned through several Composio/GitHub keys. Rotate anything that was printed or pasted, confirm the new values validate (§3 curls), re-sync `PROD_DOTENV`. | S |
| 1.5 | **Confirm the `/halt` kill switch is on the live build** | ADR-020's flag-file kill switch lets you pause all work without killing the process. Confirm it's deployed and test `/halt` → `/resume` once on the real bot. | S |

## 2. Do next — make the data real

The system runs; its memory is mostly empty in prod (QA T06 returned "no business
context stored yet").

| # | Item | Why it matters | Effort |
|---|------|----------------|--------|
| 2.1 | **Populate `turicks-brain`** — run `pnpm brain:sync` on the box | Until the knowledge store is seeded, `search_knowledge` returns nothing and the supervisor falls back to asking you basics. Sync `docs/**` + decisions into `knowledge_entries`. | S |
| 2.2 | **Seed the context store** | One-time `update_context` with current priorities/active clients so "what do you know about me" answers from real data. | S |
| 2.3 | **Confirm the RAG vector path** | Memory notes two turicks-brain systems (Postgres ILIKE vs Chroma/pgvector). Confirm which the live box uses and that it returns relevance-ranked results, not recency. | M |

## 3. Harden the pipeline (CD maturity)

| # | Item | Why it matters | Effort |
|---|------|----------------|--------|
| 3.1 | **Post-deploy smoke + auto-rollback** | `deploy.sh` keeps the old process up until the last step, so a bad build never takes prod down — but there's no automated "did the new build actually answer a message?" check. Add a post-restart smoke (curl `/health` + one office invoke) and roll back to the previous git SHA on failure. | M |
| 3.2 | **Deploy notifications to Telegram** | A one-line "deployed `<sha>` ✓ / ✗" message per CD run so go-lives are visible without watching the Actions tab. | S |
| 3.3 | **SOPS-encrypted `.env.production` in-repo** | The DEPLOYMENT.md upgrade path: replace the base64 `PROD_DOTENV` secret with a SOPS+age encrypted env committed to the repo — get a git diff per env change instead of an opaque secret blob. | M |

## 4. Explicitly NOT now (parked — fails the triple-filter)

Naming these stops them creeping in.

- **Containerizing the app / Kubernetes** — the single-instance long-polling bot + the
  `claude` CLI executor make native-systemd the right call (DEPLOYMENT.md). No real
  problem solved by a container here.
- **Load balancer / horizontal scale / read replicas** — single-tenant. YAGNI until
  Phase E.
- **Redis** — already wired as SaaS-phase; no boot dependency. Don't activate it for
  ephemeral state we don't yet have at volume.
- **Multi-region / managed DB (RDS)** — revisit only at the SaaS pivot.

---

## Definition of "production done"

Production is wrapped when **all of §1 is shipped** and **§2.1–2.2 are seeded**:

- [ ] Invalid-but-present keys are caught at boot (1.1)
- [ ] A dead box pages you within 5 minutes (1.2)
- [ ] A restore has been performed at least once, off-box copy exists (1.3)
- [ ] Every exposed key rotated + validated (1.4)
- [ ] `/halt` verified on the live build (1.5)
- [ ] `turicks-brain` + context store seeded (2.1, 2.2)

§3 is CD maturity — valuable, not blocking. Everything in §4 waits for the SaaS
pivot (Phase E), and only if a real customer need pulls it in.
