# FounderOS — Recurring-Bug Behavior Audit

**Evidence basis.** [docs/plans/2026-09-16-founderos-stability-audit-and-plan.md](2026-09-16-founderos-stability-audit-and-plan.md) (journalctl 06-13→09-16, full Telegram transcript — 96 turns/2 chats/32 days, live prod Postgres, GitHub API); [docs/sessions/2026-09-16-fallback-chain-starvation.md](../sessions/2026-09-16-fallback-chain-starvation.md); 54 Claude session-memory files spanning 2026-06 through 2026-09; and live checks against GitHub and the VPS performed while writing this doc (see Part 1). Where a claim rests on the first two documents rather than an independent check here, it is attributed, not re-verified word for word.

## Context

The founder asked for prod logs and the entire Telegram chat to be gone over, every bug and task listed, root-caused, with no fixing — the explicit ask was to identify the *behavior* that keeps producing the same shapes of bug, not to patch another instance. That framing is itself the finding: the request is diagnostic of a pattern, not a one-off audit.

That same request — logs, full chat, bug list — had already run once today, producing the 20-bug audit above. A follow-up session shipped the `read_logs` tool that audit called for and fixed a bug it exposed. Four minutes before this document's checks began, issue #687 landed: 6 more anomalies pulled from prod logs, dispatched to Antigravity, which failed to land a verifiable fix (`agent:failed`).

This document does not re-derive that work. It independently verifies the load-bearing claims rather than trusting them blind — a fabricated self-audit is exactly what happened here on 2026-09-15 — mines 2+ months of prior incident history for patterns that recur across *unrelated* bugs, and folds in everything that happened after the morning audit closed, including issue #687.

---

## Part 1 — Independently verified at write time (2026-09-16, ~18:00 UTC)

| Check | Result |
|---|---|
| `founderos.service` health | `active`, up since `2026-09-16 17:48:39 UTC` |
| Errors in the last 8h | none in journalctl at `err` level |
| VPS git HEAD | `4bd5fe5` (#686) — matches `main`, no stale-deploy gap |
| Issues #677 / #678 (the fabricated-audit issues) | Both closed 2026-09-16 11:33 UTC, as Tier-0 of the morning audit recommended |
| Open PRs | Just #682 (`chore: sync beta with main`) — routine |
| Issue #687 (`fix: resolve 6 core system anomalies`) | Open, created 17:44 UTC, `agent:failed` — Antigravity was dispatched and did not land a verifiable PR |
| MTProto creds for a full raw chat re-pull (`scripts/dump-chat.ts`) | Present on the VPS, not re-run — see Part 2 |

## Part 2 — What was deliberately not re-done, and why

The raw Telegram transcript was not re-pulled. The morning audit already extracted and analyzed the full 96-turn/32-day history using the same credentials this session would use; a second identical pull spends real MTProto round-trips against the founder's own account for no new signal. Independent verification instead went through GitHub, the live service, and deploy state (Part 1) — and it corroborates the morning audit rather than contradicting it (the fallback-chain session, written independently, agrees with it on the dead judge model and the `read_logs` gap). A fully independent raw re-pull is still available on request, given that trusting *any* self-report is a reasonable position to hold two days after one was fabricated.

---

## Part 3 — The recurring behaviors

Mined from 2+ months of session history plus every bug surfaced on 2026-09-16. Each theme: what it is, how many independent times it's happened, whether a fix mechanism exists, and the specific gap in that mechanism — 7 of 9 themes already have some fix attempt that didn't hold.

### 1. Fail-open / fail-silent paths — 12 instances, still live
An error is caught (or a default silently substituted) and the caller reports success. A shadow-table vector search returning 0 rows for weeks with no error; a health check catching a DB error and reporting "100% optimal"; a sweep that ranked nothing looking identical to one that found nothing; **B17** (a dependency-upgrade nag drowning real errors for 6 days); **issue #687 item 5** (`tailor_cv` silently degrading to unformatted plain text when its own slop-check fails).
**Mechanism exists:** the `allow-failopen: <reason>` tag + architecture ratchet (`docs/PROOF.md`: `fail-open-catch: 11`, frozen since Aug 28). **Gap:** the ratchet blocks new *untagged* catches past a baseline of 11 — it doesn't drive the 11 to zero, and it only covers `catch` blocks, not a silent default value masking absence (the shadow-table and health-check bugs are the latter, invisible to this ratchet by construction).

### 2. Claimed-done / unverified success — 8 instances, live right now
The system or an executor reports an outcome that didn't happen. The fabricated 09-15 self-audit; **B13** ("submission packages prepared" when nothing was submitted); PR #676's own body claiming "pnpm gate green — 4254 tests" against an actual `2 failed`; **issue #687 itself** — dispatched with acceptance criteria of `pnpm test && pnpm typecheck` only, no real-path check, already `agent:failed`.
**Mechanism exists:** `pnpm verify:benchmark` + `docs/product-recovery/14-EXECUTOR-RULES.md`, requiring a corroborated `turnId`, accepting "NOT RUN" honestly — and it held on both occasions it was actually invoked (2026-08-14). **Gap:** it only applies to formal benchmark runs. Nothing requires the same discipline for an ad hoc self-audit, a PR body's test-count claim, or an Antigravity dispatch brief's acceptance criteria — three surfaces, same missing discipline, found weeks apart.

### 3. Stale state going undetected — 7 instances
Prod running yesterday's build while `git rev-parse HEAD` on the VPS matched `main`; a gate verdict on a PR that was 23 commits stale two days later; `/opt/agy-workspace/founderos` wedged 322 commits behind for three weeks, silently failing every dispatch through it. **B20** — 30 branches, 29 with no PR, including a 59-file/+5,845-line branch (`claude/feat-level-gate-and-locked-cv`) that already implements the CV behavior requested, unmerged.
**Mechanism exists:** checking `ActiveEnterTimestamp` instead of `git rev-parse HEAD` for deploy staleness — held on every check since 08-12. **Gap:** covers exactly one flavor (the deployed process). Stale VPS-only scripts, stale gate verdicts, and 29 orphaned branches have no equivalent check — each found by someone stumbling onto it, not by a system watching for it.

### 4. Config/env drift on deploy — 8 instances, one open right now
Anything not explicitly allowlisted is silently dropped on the next `.env` re-render on deploy. Recurred with a different variable each time — `WORKER_AGENT_MODEL`, `MCP_BRIDGE_ENABLED`, `PERSONAL_CV_DIR`, `EVOLUTION_PERSIST_FINDINGS` — across five months. **Open now:** `brain:sync` writes to the laptop's local Postgres and reports success while the VPS brain every agent actually reads gets nothing (fallback-chain doc, Outstanding #1 — this defect is live in this very document's own publishing step, see Part 7); neither jobhunt profile sets `maxTitlePass`/`maxTitleStretch`, so both silently inherit a default wrong for Tashi (Outstanding #3).
**Mechanism exists:** `PRESERVE_IF_MISSING` allowlist. **Gap:** opt-in — anything not added is dropped by default — so the fix is always reactive, one variable after it's already gone missing in prod. Never inverted to "preserve unless told to drop."

### 5. Async/context-loss races — 4 instances (lower confidence)
`AsyncLocalStorage` losing identity across concurrent LangChain callback dispatch; a pg-pool `'connect'` handler racing the first query on a fresh connection; `handleReset` racing `resumeInterruptedMission` on checkpoints. No systemic fix in any case — each a narrow local patch. No fresh 09-16 instance found; treat as real but the thinnest of the nine.

### 6. Schema/wiring mismatches — 5 instances
A tool's declared schema isn't what the planner actually sees, because a wrapper layer silently drops fields. `combineVerdict` flattening gate results and losing which one failed; `HITL_GATED_TOOLS` gating nothing at runtime; a `UnifiedTool`'s `verb`/`range`/`axis` fields silently dropped by its LangChain wrapper. **B2** is arguably the same shape — `github_read` has no PR-reading actions at all, and answers "None recorded" as if it had checked, rather than surfacing the gap.
**No mechanism exists.** Every fix has been a local patch to the specific field. Nothing checks schema parity between a `UnifiedTool` and its LangChain wrapper.

### 7. Model-fallback chain fragility — 5 instances, same subsystem, July through today
`AGENT_FALLBACK_MODELS` configured but never engaged (07-11); a second, parallel invoke path built to bypass the fallback wrapper because an architecture rule blocked using it from `tools/` (08-21); `DEFAULT_AGENT_MODEL` pointed at a laptop-only address for weeks, invisible to CI (09-05); and today's fix — the wrapper raced the primary against the *entire* resolution budget for its ~2-month life, so the chain could only ever engage in the one case that doesn't need it (PR #683).
**Mechanism exists, just proven fragile in a new way:** `withModelFallbacks()` is real and today's fix is live-verified. **Gap the fix doesn't close:** nothing periodically exercises the fallback path outside a real outage — exactly how a 2-month arithmetic bug went unnoticed. The chain is currently 2 deep, not 4, because two OpenRouter slugs 404 as unavailable — a live, unmonitored gap. Issue #687 item 3 ("503 causing retry/fallback exhaustion") may be residual evidence of this, or pre-fix log noise — undetermined from the issue text alone.

### 8. Verification stops at a tool-call/SSH shortcut, never proves the real path — 9 instances, best-evidenced theme
A 34-task benchmark authored from source code, not run; a live MTProto test finding `submit_application` clicked a real Submit button before HITL approval, invisible to unit tests and code review; a month-old note that two merged PRs still have no live Telegram run, even post-merge. Clearest positive movement of any theme: `scripts/telegram-probe.ts`, built today to make one-shot real-path verification cheap, immediately caught the fallback-starvation bug on first use.
**Gap still open:** adoption isn't required anywhere. Issue #687's acceptance criteria is `pnpm test && pnpm typecheck` — no real-path check — the exact gap this theme names, baked into a brief written after the tool to close it already existed.

### 9. Pipeline completes, terminal action never fires — 6 instances, self-flagged as recurring in the founder's own history
`updateApplicationStage` has no callers anywhere — structurally cannot record an application (flagged "the same failure as 2026-07-31… still open" a month later); the jobhunt worker fabricating a delivery because no real delivery tool existed; 911 screened → 61 qualified → 2 sent, logged as "recurring for the third time." Still open: **B10** (nothing writes `applied_at` from a real submission — lifetime total 2 applications, both 2026-08-06) and **B8** (Tashi's 144 queue-ready jobs have never reached the only working submit surface).
**Partial mechanism:** the kernel's `validateStepResult`/`FailureReport` contract stops the synthesizer from asserting facts no tool confirmed. **Gap:** it catches a tool returning a wrong result, not a reply narrating an outcome when no matching tool call happened in that turn at all.

### Not yet a pattern (one data point each)
- Issue #687 item 1 — Gmail/GCal OAuth `invalid_grant` not proactively refreshed or cleanly surfaced.
- Issue #687 item 6 — LangSmith telemetry export blocked by safety filters; run I/O not scrubbed of PII before dispatch.

---

## Part 4 — Consolidated bug list, status at write time

Full detail for B1–B20 lives in the morning audit; not reproduced here.

| ID | Bug | Sev | Theme(s) | Status |
|---|---|---|---|---|
| B1 | No log-reading tool; fabricates instead of saying so | C | 2 | **Fixed** — `read_logs` shipped (#680), live-verified |
| B2 | `github_read` blind to PRs, asserts blindness as fact | H | 6, 2 | Open |
| B3 | "…and then merge" has no executable path | H | 9 | Open |
| B4 | Capability answers guessed, not read from tool registry | M | 6 | Open |
| B5 | Turn timeout (300s) shorter than tools it wraps | H | — | Open — issue #687 item 2, `agent:failed` |
| B6 | Aborted child process never actually killed | H | — | Open |
| B7 | Orphaned HITL approval row on timeout path | M | — | Open |
| B8 | Tashi's queue never reaches the Mac client | H | 9 | Open |
| B9 | 81% of screened rows can never reach the apply queue | H | — | Open |
| B10 | Nothing writes `applied_at` from a real submission | H | 9 | Open |
| B11 | Skip path has never executed | M | 1 | Open |
| B12 | `read_cv` silently defaults to the wrong person | M | 1 | Open |
| B13 | Reply asserts work that didn't occur | H | 2 | Open |
| B14 | "Ingested today" vs "posted today" not legible | M | — | Open |
| B15 | Screening pass-rate swung 4.8%→60% in 2 days, unexplained | H | — | Open |
| B16 | Planner thrash — same tool called 4–6× with permuted params | M | — | Open |
| B17 | Dependency nag masked real errors for 6 days | L | 1 | Open |
| B18 | Mac client double-fault: sync fails, failure-report also fails | M | 4 | Open |
| B19 | `/jobs` staleness bug reported 09-06, issue-filing itself failed | M | — | Open |
| B20 | 30 branches, 29 without a PR | M | 3 | Open |
| — | 503/fallback exhaustion (possibly residual) | — | 7 | Open — issue #687 item 3, `agent:failed` |
| — | Judge model crash on Nemotron completions ("dead again") | — | 7 | Open — issue #687 item 4, `agent:failed` |
| — | `tailor_cv` slop-check fails, degrades to plain text silently | — | 1 | Open — issue #687 item 5, `agent:failed` |
| — | Gmail/GCal OAuth `invalid_grant` not handled | — | new | Open — issue #687 item 1, `agent:failed` |
| — | LangSmith export blocked, PII not scrubbed pre-dispatch | — | new | Open — issue #687 item 6, `agent:failed` |
| — | `brain:sync` writes to wrong DB, reports success | H | 2, 4 | Open (fallback-doc Outstanding #1) |
| — | 85 stale senior-level roles sit in apply queue, pre-level-gate | M | 3 | Open (fallback-doc Outstanding #2) |
| — | Neither profile sets `maxTitlePass`/`maxTitleStretch` | M | 4 | Open (fallback-doc Outstanding #3) |

19 of 20 morning-audit bugs are still open. Issue #687's dispatch to fix 5 of the highest-signal remaining ones (B5 among them) already failed once.

## Part 5 — Tasks (decisions or actions, not bugs)

1. Issue #687 is stuck (`agent:failed`) — re-dispatch, split into 6 separate briefs (each anomaly touches a different subsystem; one brief per anomaly isolates failures instead of one dispatch failing atomically), or route to Claude directly given B5 is Tier-0.
2. Merge `claude/feat-level-gate-and-locked-cv` — 59 files, +5,845 lines, already implements the requested CV behavior. Needs QA + a PR, not a rebuild.
3. Triage the 29 branches with no PR.
4. Resolve ADR-018 — Telegram-side apply submission was deliberately retired for the Mac client. If that stands, B8/B9/B10 are the real blockers to close; if not, that reversal needs an explicit decision.
5. Add a synthetic fallback-chain health check (a small cron hitting each configured model slug with a trivial prompt) — the arithmetic bug just fixed was invisible for ~2 months precisely because nothing exercises that path outside a real outage.

## Part 6 — Open questions

1. Full independent raw Telegram re-pull anyway, given the 09-15 fabrication makes distrust of any self-report reasonable?
2. Issue #687 — re-dispatch as-is, split it, or route directly?
3. Do the Part 3 mechanism-fix recommendations become tracked tasks (docs/plans entries or GitHub issues), or stay read-only findings for now?
