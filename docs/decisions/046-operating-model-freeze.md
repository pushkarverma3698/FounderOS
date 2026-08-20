# ADR-046 — The engineering operating model is frozen

**Date:** 2026-08-14
**Status:** Accepted — binding on Claude, Antigravity, and any future executor
**Supersedes:** nothing. Formalises what `docs/antigravity/ISSUE-DRIVEN-CONTRACT.md`,
`BRANCHING-STRATEGY.md` and `CLAUDE_REVIEWER_INSTRUCTIONS.md` already describe in parts.

## Decision

FounderOS changes reach production through exactly one path. It is frozen. Future work operates
*inside* this model; it does not get to add an orchestration layer because a feature would be
easier with one.

```text
Founder / FounderOS self-audit
            ↓
      GitHub Issue  ················ the coordination layer. Nothing is dispatched
            │                        that is not an issue.
        agent:ready  ··············· explicit intake gate
            ↓
    agent-dispatch (VPS, */15)  ···· mechanical only: claim, invoke, verify a PR EXISTS
            ↓
    Antigravity CLI  ··············· the implementation agent. Isolated workspace,
            │                        --new-project pinned, never its own grader.
     draft PR → beta
            ↓
       CI (2 required checks)
            ↓
    pr-brain (VPS, */20)  ·········· Claude. The SOLE review authority.
            │
   ┌────────┼─────────────────┐
 PASS   BLOCKER(fix)   BLOCKER(decide)
   │        │                 │
   │   Claude pushes     request-changes
   │   the fix           → agent-dispatch Pass B
   │        │            → Antigravity re-dispatch
   └────────┴─────────────────┘
            ↓
      reality testing
            ↓
     merge → main → deploy
            ↓
   production verification
            ↓
      FounderOS Brain  ············· institutional memory. NOT a source of truth
                                     for code — GitHub is.
```

## The four review outcomes

Named here because `pr-brain` has always had three *actions* but no published taxonomy, so
"BLOCKER" meant whatever the reviewing session decided it meant.

| Outcome | Definition | Action taken | Blocks delivery? |
|---|---|---|---|
| **PASS** | Gate green and the disproof pass found nothing. | `gh pr review --approve` + `gh pr ready` | no |
| **NON-BLOCKER** | Cleanup, maintainability, docs, an optional improvement, or a pre-existing condition this PR did not cause. | Named in the review body under "not blocking", PR still cleared. | **never** |
| **BLOCKER — Claude fixes** | A correctness, security, regression, false-success or missing-execution-path defect whose correct fix is unambiguous and small. | Claude pushes the smallest correct fix to the PR branch and comments what changed. | until fixed |
| **BLOCKER — needs a decision** | Same severity, but the fix requires a product call, a re-run of reality, or judgement Claude should not make alone. | `--request-changes` naming the failing scenario. `agent-dispatch` Pass B re-invokes Antigravity. | until resolved |

A NON-BLOCKER must never delay a merge. That is the failure this table exists to prevent: a
reviewer that treats every observation as a gate produces the same outcome as no reviewer at all,
because the founder starts overriding it.

**Green CI is never the verdict.** It is a necessary condition. The failure this whole division
exists to catch is a PR that is green and changes nothing.

## Responsibilities

| Component | Owns | Must never |
|---|---|---|
| **Founder** | Product authority. Merges to `main` when he chooses to. | — |
| **FounderOS** | Finds its own defects (`src/evolution/`), files ONE issue per cycle. | File more than one issue per run; dispatch a decision-shaped finding. |
| **GitHub** | The coordination layer and the source of truth for code. | — |
| **agent-dispatch** | Claim, invoke, lease, retry, terminal state. | Infer correctness from a PR existing. |
| **Antigravity** | Implementation, regression tests, evidence. | Grade its own work; merge; touch `/opt/founderos` or `/opt/review`. |
| **Claude / pr-brain** | The sole review verdict. | Approve on green CI alone; force-push; rewrite the executor's commits. |
| **CI** | Deterministic verification. | Be bypassed. |
| **VPS** | The execution and reality environment. | — |
| **Brain** | Institutional memory: incidents, root causes, failed approaches, decisions. | Become a second source of truth for code. |

## What is frozen, specifically

1. **Issues are the only dispatch mechanism.** No side channel, no direct prompt, no human relaying
   messages between Claude and Antigravity.
2. **The executor is never its own grader.** Holds for Antigravity, and for Claude when Claude
   wrote the code.
3. **`--new-project` on every unattended `agy` invocation.** `cd` alone has been proven to bind to
   the wrong project.
4. **Draft PRs target `beta`, never `main`.**
5. **One branch per unit of work.** Never shared, never resurrected.
6. **The four outcomes above.** A finding gets classified; silence is not an outcome.
7. **Production changes go PR → CI → approval boundary → merge → deploy → verification.** No
   autonomous production deployment, no unrestricted self-modification.

## What is deliberately NOT frozen

The *contents* of the analyzers, the benchmark rubric, the prompts, and the tool surface. Those are
expected to change constantly. The freeze is on the control flow, not the payload.

## Consequences

- A future improvement that requires a different orchestration shape must first argue that the
  model itself is inadequate, with evidence, not that a feature would be easier.
- Anything that cannot be expressed as an issue is not yet ready to be dispatched.
- **The model is only as available as its weakest external dependency.** Proven 2026-08-14: the
  entire chain executed correctly and stopped at `Individual quota reached` from the Antigravity
  subscription. The dispatcher marked `agent:failed` and claimed nothing — correct behaviour, and a
  reminder that quota is a production dependency, not a developer convenience.

## Evidence this model is real, not aspirational

| Link | Proven | Evidence |
|---|---|---|
| self-audit → issue | ✅ | Issue #491 filed unattended 2026-08-14T05:29:43Z, fingerprint `e66f4193…` |
| issue → claim → isolated workspace → branch | ✅ | `agent-dispatch.log` 05:30:03Z–05:30:07Z, `--new-project` pinned |
| Antigravity implementation | ❌ | Blocked: subscription quota exhausted |
| PR → Claude review, PASS path | ✅ | `pr-brain.log` gated #486 at 04:09Z and #487 at 05:29Z, both CLEARED |
| CI | ✅ | 2 required checks on `main`, green on every PR merged this session |
| dispatch failure is loud, not silent | ✅ | #491 → `agent:failed` + diagnostic comment + Telegram escalation |
