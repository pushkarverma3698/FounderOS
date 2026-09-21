# AG-016 — 503/fallback exhaustion: confirm whether this is already fixed before doing anything else

**Milestone:** issue #687 item 3
**Branch:** `task/issue-<N>-fallback-residual-check` — cut from fresh `origin/beta`. PR base: `beta`.
**Status:** ✅ CLOSED 2026-09-17 — verified already fixed by PR #683, no residual gap found. See
"Verification result" at the bottom.

**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## This is very likely already fixed — verify that first, don't assume new work is needed

Issue #687 item 3 ("Gemini 503 causing retry/fallback exhaustion") was created 2026-09-16T17:44Z.
Earlier the same day, PR #683 fixed exactly this failure shape in `src/gateway/model-fallback.ts` —
confirmed live in the current code:

```
$ grep -n "chainReserveMs\|primaryShareMs" src/gateway/model-fallback.ts
79:  const chainReserveMs = Math.min(attemptTimeoutMs, Math.floor(budgetMs / 2));
80:  const primaryShareMs = budgetMs - chainReserveMs;
91:        // against budgetMs made the chain structurally unreachable: a primary
```

The comment at line 91 is documenting the bug PR #683 already fixed. **Your first job is to
determine whether issue #687 item 3 describes:**
(a) stale log lines from before PR #683 landed (in which case this item is already resolved — close
it with evidence, no code change needed), or
(b) a residual gap PR #683 didn't close.

## The residual gap that plausibly is still open

[docs/sessions/2026-09-16-fallback-chain-starvation.md](../sessions/2026-09-16-fallback-chain-starvation.md)
notes the fallback chain is currently **2 deep, not the intended 4**, because two configured
OpenRouter fallback slugs 404 as unavailable on the free tier. If Gemini's primary AND both live
fallbacks are simultaneously in a 503 storm, exhaustion is still possible — narrower than before,
but real. This is also the residual gap
[[docs/plans/2026-09-16-mechanism-fallback-health-check.md]] is designed to catch on an ongoing
basis, not fix retroactively — that mechanism doc is the better home for "detect when a fallback
slug goes dead," not this brief.

## Goal

1. Check `journalctl`/`read_logs` for the actual timestamp(s) behind item 3's claim. If they predate
   `17:48:39 UTC` (when PR #683's deploy went live, confirmed via `ActiveEnterTimestamp`), this item
   is stale — close with that evidence, no further action.
2. If you find a post-deploy 503-storm trace that still exhausts the chain (both live fallback slugs
   also failing), that's a real residual bug — root-cause it specifically (is it the "2 deep not 4"
   gap, or something else?) and fix the smallest correct thing.

## Explicitly forbidden

- Do not re-implement or modify the `chainReserveMs`/`primaryShareMs` budget-splitting logic that
  PR #683 already fixed unless you have a *post-deploy* log trace proving it's still broken.
- Do not add a third OpenRouter fallback slug without confirming it's actually live and free —
  the two currently configured ones already 404.

## Verify

```bash
pnpm gate
```

Per rule #36: the PR body must state, with a `read_logs` timestamp, whether item 3 is stale
(pre-fix) or live (post-fix), before any other claim. **NOT VERIFIED — reason** is an acceptable
and expected outcome here if no post-deploy trace exists yet.

---

## Verification result (2026-09-17)

Ran directly against prod, per goal item 1:

```
$ ssh founderos-vps 'sudo -n journalctl -u founderos --since "2026-09-16 17:48:39" | grep -iE "503|fallback exhaust|all providers failed|chain exhaust"'
```

3 post-deploy `503 Service Unavailable` lines found, all on 2026-09-16 (18:00:01, 18:00:09,
18:57:58 UTC), all logged by `model-retry` with `msg: "Transient provider error — backing off
before retry"` — i.e. single-attempt transient errors that the retry/backoff already absorbed.
Zero hits for `"all providers failed"`, `"chain exhaust"`, or any terminal failure string, in the
full journal since the PR #683 deploy.

**Verdict: (a) — this item is resolved.** PR #683's `chainReserveMs`/`primaryShareMs` budget split
holds under real post-deploy 503 traffic; no residual chain-exhaustion event occurred. The
"2 deep, not 4" fallback-chain gap from
[docs/sessions/2026-09-16-fallback-chain-starvation.md](../sessions/2026-09-16-fallback-chain-starvation.md)
remains real but narrower risk, not an active defect — tracked separately by
[[docs/plans/2026-09-16-mechanism-fallback-health-check.md]], not reopened here per this brief's
own scope note. No code change made, per "explicitly forbidden" — the budget-splitting logic was
not touched.
