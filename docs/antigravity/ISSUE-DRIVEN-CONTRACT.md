# Issue-driven autonomous loop — BINDING

**How a GitHub Issue becomes a PR without a human relaying messages between Antigravity and
Claude.** Read this together with [STANDARDS.md](STANDARDS.md) (how code is written — referenced,
not restated here), [BRANCHING-STRATEGY.md](BRANCHING-STRATEGY.md) (one branch per issue, never
shared, never resurrected), and [CLAUDE_REVIEWER_INSTRUCTIONS.md](CLAUDE_REVIEWER_INSTRUCTIONS.md)
(the review side of this same loop, run by `pr-brain`).

## The state machine

```text
agent:ready → agent:working → agent:review → (merged | agent:blocked | agent:failed)
```

`agent:ready` is an **explicit intake gate**, applied only once an issue actually satisfies the
template in `.github/ISSUE_TEMPLATE/agent-task.md`. Everything downstream of it is unattended.

Two things may apply it, and nothing else scans for it:

1. **A human**, on any issue.
2. **The self-improvement acting loop** (`src/evolution/dispatch-findings.ts`), which renders a
   template-shaped body from one ranked self-audit finding. It is bounded by construction: **at most
   one issue per run**, deduplicated on the finding's fingerprint against its own `evolution:auto`
   history (read with `state: "all"`, so a closed issue still suppresses a re-file), and findings
   whose resolution is a *decision* rather than an implementation — `cost-hotspot`,
   `orphan-module`, `dead-export`, `oversized-prompt`, `loc-pressure` — are never dispatched at all.
   They still appear in the audit report; only the robot handoff is withheld.

First unattended use: issue #491, 2026-08-14T05:29:43Z.

## Division of authority — read this before anything else

**The dispatcher (`agent-dispatch`, VPS cron) manages state and dispatch only. It never infers
correctness from a PR existing, from a commit landing, or from Antigravity's own summary of what it
did.** Its only questions are mechanical: is there an eligible issue, is there a branch, is there a
PR, is a lease stale, has the retry budget run out. "A PR exists" is a dispatch signal, not a
verdict.

**Claude, via `pr-brain`, is the sole review authority.** Its evidence-backed verdict is what
determines whether work continues, not anything the dispatcher or Antigravity itself claims. This
mirrors the standing rule in [README.md](README.md#review-discipline--non-negotiable): the executor
is never its own grader.

The verdict is one of exactly four outcomes, defined in
[ADR-046](../decisions/046-operating-model-freeze.md#the-four-review-outcomes): **PASS**,
**NON-BLOCKER** (named but never blocking), **BLOCKER — Claude fixes** (smallest correct fix pushed
to the PR branch), **BLOCKER — needs a decision** (`--request-changes`, which returns the work to
Antigravity through dispatcher Pass B). Silence is not an outcome.

## The 20-step contract (what Antigravity does inside each invocation)

1. Read the complete issue — title, body, every template section.
2. Inspect the current architecture relevant to the issue's stated files/subsystem.
3. Inspect relevant git history (`git log -p`, `git blame`) for that area.
4. Reproduce the problem when the issue describes one that can be reproduced.
5. Identify the smallest root cause — not the first plausible one.
6. Check whether another branch or open PR already addresses this. If so, say so and stop rather
   than duplicating work.
7. Implement the smallest correct fix.
8. Add regression coverage (a bug fix starts with a failing test — STANDARDS.md §9).
9. Run the verification commands named in the issue.
10. Create a task-specific branch (`task/issue-<N>-<slug>`) in `/opt/agy-workspace/founderos` only.
11. Commit the implementation.
12. Push the branch.
13. Open the PR as **draft**, targeting `beta`.
14. Stop. Do not keep iterating once the PR is open and ready for review.
15. Consume Claude's findings **only through GitHub** (`gh pr view <n> --json comments`,
    `gh pr checks <n>`) — never through anything relayed by the founder.
16. If a finding is a BLOCKER: fix it.
17. Re-run verification.
18. Push the update; do not open a second PR.
19. **Never merge.** Not to `beta`, not to `main`.
20. **Never touch `/opt/founderos` or `/opt/review/founderos`.** The isolated workspace is the only
    tree Antigravity may write to.

Every completion report must contain evidence — the actual verify command output, not "fixed" on
its own. This is the same rule STANDARDS.md §12 already states; it applies here too.

## The `--new-project` invariant

**Every unattended `agy` invocation MUST pass `--new-project` (or an explicitly pinned
`--project <id>`).** A prior session proved `agy --print` can silently execute against the wrong
project when only `cwd` is changed via a shell `cd` — it reused a stale workspace from an earlier
run despite being launched from the correct directory. Never rely on `cd` alone. The dispatcher
enforces this in code; nothing above should override it.

## Reality-test policy — risk-adaptive, not blanket

The full 35-task live-Telegram suite (`pnpm qa:telegram`) is a milestone gate, not a per-PR check —
it costs real model calls and exercises the real production bot. It is never auto-run by the
dispatcher.

Whether a PR needs a live/manual check at all is read from the issue's own **Acceptance criteria**
section, not decided by the dispatcher:
- If the issue states a concrete user-visible outcome (e.g. "the founder sends X and receives an
  actual Y in Telegram"), that check is flagged for a **human-triggered**, narrowly-targeted probe
  of exactly that outcome — not the full suite — before merge.
- If the issue's acceptance criteria are fully covered by `pnpm gate` (unit/integration/
  architecture), no additional live check is required.

This mirrors the L1–L6 verification hierarchy already in place: `pnpm gate` covers L1–L3, HITL unit
tests cover L4, a targeted live probe covers L5, and the kernel's own `VERIFIERS` map
(`src/kernel/verify.ts`) is L6, running continuously in production regardless of this loop. Never
infer a higher level from a lower one — a passing `write_artifact` unit test is not evidence a
Telegram attachment was delivered.

## Bounded retries, leases, and the terminal state

- A claim (`agent:working`) carries a `<!-- agent-claimed: <ISO> -->` marker comment. If it's more
  than 45 minutes old with no linked open PR, the dispatcher releases the issue back to
  `agent:ready` and says why — this is the crash-recovery path, not a human action.
- A PR carries a `<!-- agent-attempt: N -->` marker. Each automated Claude-finding → Antigravity-fix
  cycle increments it. At `N >= 3`, the issue moves to **`agent:blocked`**, a terminal state: the
  dispatcher stops touching that issue and PR entirely, posts the evidence, and escalates on
  Telegram. Only a human re-labeling `agent:ready` resumes it.
- A CI failure is handed to Antigravity as the raw failing job log, never dressed up as a Claude
  review finding — they are different failure classes with different fixes.

## What this loop never does

- Never merges a PR (to `beta` or `main`) — that stays a human decision.
- Never deploys anything outside the existing `deploy.yml` → `deploy/deploy.sh` pipeline, which only
  runs after a human-approved merge to `main`.
- Never runs two claims on the same issue concurrently (dispatcher lock, mkdir-atomic — same
  mechanism as `pr-brain`'s).
- Never touches the production (`/opt/founderos`) or Claude-review (`/opt/review/founderos`) trees.
