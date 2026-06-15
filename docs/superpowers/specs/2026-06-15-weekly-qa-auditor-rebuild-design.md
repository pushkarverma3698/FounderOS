# Weekly QA Auditor — Rebuild Design

**Date:** 2026-06-15
**Status:** Approved design (all open questions resolved) — pending implementation plan
**Branch:** `feat/weekly-qa-rebuild`
**Supersedes:** the inline-bash `/opt/founderos/scripts/weekly-qa-audit.sh` (freshly installed 2026-06-15, never run)

---

## 1. Problem

The founder reviews production logs + chats almost daily, hunts hallucinations/bugs, and
fixes them. It is mundane and token-expensive. A weekly auto-QA cron was installed on the
VPS today (`weekly-qa-audit.sh`, cron `30 17 * * 0`) to automate this, but it has **never
run** (first fire is Sun 2026-06-21) and a review against the project's hard rules found
three P0 flaws that would make its first unsupervised run net-negative:

- **P0-1 — opens PRs on a broken build.** It runs `tsc`/tests but only *labels* the result;
  the PR is created regardless of `ERRORS`/`WARN`.
- **P0-2 — inverted hallucination detection.** It keyword-flags replies containing
  `"i don't have" / "cannot" / "sorry" / "no information"` — those are *honest refusals*
  (good behaviour). The canonical prod hallucination (rule #22: RAG empty → **confidently
  fabricated** a Turicks ICP) has none of those markers and is missed entirely. The
  detector rewards the wrong thing and would push the bot toward fabrication.
- **P0-3 — fixes with no reproducing test (violates rule #19).** Claude edits from a
  one-line issue description and self-validates only that *existing* tests still pass. No
  regression test is added, so the bug class can silently return and there is no proof the
  fix worked.

Secondary flaws: blind to DB/audit state (journalctl only — can't see empty RAG store,
missing `action_log` rows, HITL integrity, dead tool-keys — rule #22 says verify *state*);
no cross-week memory → duplicate PRs (date-stamped branch defeats the 422 guard); unbounded
write surface (`--add-dir /opt/founderos`, no diff cap / protected-file denylist); fragile
field-name parsing that can silently yield "(none)" forever; embeds 500 raw log lines every
run (token cost the founder explicitly wants to avoid).

**The architecture is right** (weekly funnel → Claude confirms → PR for a human to merge).
The implementation is the problem.

## 2. Goal

One token-frugal engine that turns a week (or an on-demand window) of production reality
into a small, bounded, evidence-backed digest, hands **only the digest** to Claude for
root-cause + regression-test-first fix proposals, and opens a PR a human merges. Same engine
behind two triggers: the **weekly cron** and an **on-demand `pnpm logreview`**.

Non-negotiables it must honour: rule #16 (deterministic logic out of the LLM), #17 (reuse,
one engine), #18 (write findings to memory), #19 (reproduce + regression test before fix),
#22 (verify prod *state*, name the real failing component), and "humans merge" (PR only).

## 3. Architecture — 3-stage funnel, repo-based, unit-tested

Raw logs/chat **never** enter Claude's context. A deterministic TypeScript harvester +
detectors (in the repo, unit-tested) do Stages 1–2 for **zero Claude tokens**. Claude enters
only at Stage 3, reading a hard-capped digest.

```
Stage 1 HARVEST (0 tokens)        Stage 2 TRIAGE (0 tokens)              Stage 3 REASON (bounded)
─────────────────────────         ──────────────────────────            ────────────────────────
journalctl --since (prod, JSON)   detectors.ts (pure fns, 1/signal):    Claude reads digest.json only:
prod Postgres STATE:              • error/503/400/409, crash             • judge borderline turns
  action_log, episodic,           • recursion/wedge abort                  (hallucination/frustration/
  dept_signals, hitl_approvals,   • send w/o action_log row                routing) — Claude owns this
  founder_context, RAG counts     • double-exec / phantom-success        • cluster → root causes
Telegram history                  • "Done." w/ NO row (silent fail)      • cross-ref code
  → timeline.ts: Turn[] by        • /reset, repeated user message        • write FAILING regression
    turnId (reuses seam trace)    • latency/cost spike (turn.out)          test FIRST (rule #19)
                                   • empty-store / dead tool-key (state)  • minimal fix, re-run test
                                   → digest.ts: every hard anomaly +      • PR (human merges)
                                     borderline candidates, capped at     • write report + episodic
                                     MAX_DIGEST_TURNS; healthy → counts      (carry open items to next wk)
```

### Module layout (`scripts/log-review/`)
Small, single-purpose, each independently testable:

| File | Responsibility | Pure? |
|------|----------------|-------|
| `sources.ts` | Pull raw inputs: journalctl (SSH/local), Postgres queries, Telegram history. Each source typed, independent. | No (I/O) |
| `timeline.ts` | Merge sources → `Turn[]` keyed by `turnId`. | Yes |
| `detectors.ts` | One pure fn per **hard** signal → `Anomaly \| null`. Unit-tested against committed prod-shaped fixtures. | Yes |
| `state-checks.ts` | DB-state assertions: RAG row+embedding counts > 0, sends have audit rows, no orphaned HITL, tool-key liveness. | No (DB) |
| `digest.ts` | Assemble bounded `digest.json` (hard anomalies + borderline candidates, capped; healthy collapsed to counts). | Yes |
| `harvest.ts` | CLI: sources→timeline→detectors+state→digest. Writes `digest.json` + plaintext summary. **Zero Claude tokens.** | No |
| `types.ts` | `Turn`, `Anomaly`, `Digest`, `Severity`, `SignalType`. | — |

### What changes vs. the current `.sh`
- The inline keyword-grep hallucination detector is **deleted**. Hallucination is judged by
  **Claude in Stage 3** over a bounded candidate set (the funnel pre-filters; Claude judges).
  Deterministic detectors only catch the *hard* signals they can prove.
- The `.sh` shrinks to a thin orchestrator: `pnpm logreview --since 7d --json` →
  feed digest to `claude -p` with the Stage-3 prompt → gate the PR on **green tsc+tests**
  → open PR. No inline python parsing, no raw-log embedding.
- Stage 1 now queries **Postgres state**, not just journalctl (fixes the rule #22 blind spot).

## 4. The three P0 fixes, concretely

1. **Gate the PR on a green build.** `harvest`/orchestrator treats `tsc != clean` or
   `tests != pass` as a **hard stop** — no PR; instead it posts the digest + failure to the
   founder (Telegram/file) for manual review. A red build never becomes a PR.
2. **Replace inverted detection.** No keyword hallucination grep. Deterministic detectors
   flag only provable faults; Claude judges fabrication over the capped candidate set, with
   the prod-learned framing ("a confident answer with no supporting tool-call/RAG hit is the
   hallucination; an honest refusal is correct").
3. **Regression-test-first fixes.** Stage-3 prompt requires: for each confirmed issue, write
   a **failing** test that reproduces it, *then* the minimal fix, then prove the test passes.
   PR body shows the new test. No test → no fix in the PR.

## 5. Cross-week memory (rule #18)

Each run reads the last audit record (open items) and writes its own:
`docs/reviews/YYYY-MM-DD-prod-review.md` + an `episodic_memory` entry. Branch naming keys on
a **content hash of the issue set**, not the date, so an unmerged issue does not spawn a
duplicate PR next week — the 422 "already exists" guard finally works.

## 6. Write-surface guardrails

- **Isolated QA workspace (decided).** The auditor never touches the live `/opt/founderos`
  checkout that systemd runs from. A **dedicated git clone at `/opt/founderos-qa`**, owned by
  an unprivileged `founderos-qa` user, is the only directory Claude can write. Each run:
  `git fetch origin && git reset --hard origin/main` in the QA workspace (clean, deterministic
  base), branch, fix, push, PR. Claude's `--add-dir` is scoped to **`/opt/founderos-qa` only**
  — it can read the prod logs/DB (Stage 1 is run by the harness, not Claude) but cannot edit
  the running deployment. Full Docker-sandbox isolation is stronger but adds claude-auth-in-
  container + bind-mount complexity; deferred as documented future hardening (the tool is
  PR-only / never-merge, so the workspace boundary + denylist is sufficient now). See ADR.
- Diff-size cap — **precise** (decided): abort the PR (escalate to founder for manual review)
  if the proposed change exceeds **3 files OR 120 changed lines** in a single run. Tight by
  design: an auto-fix should be a small, surgical, single-issue patch; anything larger is a
  human decision, not an unsupervised one.
- Protected-file denylist (`config.ts`, `schema.ts`, anything under secrets handling,
  `.env*`, CI workflows under `.github/`) — Claude may flag but not auto-edit; those escalate
  to manual.
- PR only, never merge. `GITHUB_TOKEN` moved off the git cmdline (use a credential helper /
  `GIT_ASKPASS`), out of `ps`/log surface.

## 7. Token guarantees

- Raw logs/chat never enter Claude context.
- Digest hard-capped at `MAX_DIGEST_TURNS`; healthy turns collapse to a single count line.
- Same input → same digest (Stages 1–2 deterministic) → reproducible, cacheable.
- On-demand `pnpm logreview` (Stages 1–2 only) costs **zero** Claude tokens; the Claude pass
  is invoked separately and only reads the capped digest.

## 8. Testing (rule #19)

- Every detector: unit tests against **committed prod-shaped log fixtures** (captured once
  from real journalctl JSON — verify the actual seam field names, fixing the P2 fragility).
- `timeline.ts` / `digest.ts`: pure-function unit tests (cap enforced, healthy-collapse,
  dedup).
- `state-checks.ts`: integration test against a seeded test DB.
- Orchestrator: a dry-run mode that builds a digest from a fixture and asserts PR-gating
  (red build → no PR).

## 9. Out of scope (YAGNI)

- No Ollama in the triage path (the founder chose Claude-judges-in-Stage-3; Ollama stays an
  optional later dedup lever, not built now).
- No auto-merge, ever.
- No real-time/streaming monitoring — weekly + on-demand only.
- No new dashboard UI — Markdown report + Telegram digest is enough.

## 10. Resolved decisions (was open questions)

1. **Stage-3 runs on the VPS** — self-contained, where `claude` is already authed. It runs in
   the isolated `/opt/founderos-qa` workspace (§6), not the live deployment.
2. **On-demand digest notifies both** — writes the Markdown report to
   `docs/reviews/YYYY-MM-DD-prod-review.md` **and** sends a Telegram summary to the founder.
3. **Diff-size cap is precise** — abort/escalate above **3 files or 120 changed lines** (§6).
4. **`state-checks.ts` reuses `src/db/queries.ts`** where read functions already exist (rule
   #17, no parallel query layer); it adds only the few **read-only** count/integrity helpers
   not already present (RAG row+embedding counts, orphaned-HITL check, send-without-audit
   check). No writes, no duplicated SQL.
5. **Isolated Claude workspace on the VPS** — dedicated `/opt/founderos-qa` clone under an
   unprivileged `founderos-qa` user; `--add-dir` scoped to that path only; live deployment
   untouched (§6). Container sandbox deferred as future hardening.
