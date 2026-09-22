# 2026-09-22 — QA audit of the agent dispatch loop, end to end on Oplify

## What we did

Audited and then **drove the full autonomous loop on a live repository** —
issue → `agent-dispatch` claim → branch → Antigravity (`agy`) → draft PR →
`pr-brain` review → Antigravity fix → re-review — on the two `OplifyMessage`
work repos, which had **never had a single `agent:ready` issue** before today
(`gh issue list --label agent:ready --state all` returned `[]` on both).

Static audit of `~/bin/agent-dispatch`, `~/bin/pr-brain`, `src/tools/dispatch-*.ts`,
crontab, workspaces and GitHub state; then a real dispatch, watched live.

The four arrows, with the evidence each was proven by:

| Arrow | Verdict | Evidence |
|---|---|---|
| Founder → issue | **PASS** | `dispatchAntigravityTool.execute()` run against prod's own build → `OplifyMessage/oplify-messaging-app#32`, labels `agent:ready, antigravity`. Allowlist accepted an Oplify slug. |
| Issue → branch → Antigravity → draft PR | **PASS** | `15:08:16Z claiming #32` → `task/issue-32-…` cut from `origin/main` → `15:15:22Z #32 -> PR #33 detected (1 commit(s))`. 7 min. +4/−0, exactly one file, spec followed. |
| PR → Claude review | **PASS** | `15:24:15Z verdict: CLEARED — marked ready for merge` and `15:24:16Z cleared — marked ready, merge withheld (OplifyMessage org)`. Employer-org guard held. |
| Review → Antigravity fix → re-review | **WAS DEAD; now fires, but the executor no-op'd** | See below. |

QA artifacts (`#32`, `#33`) were closed and the branch deleted. The employer repo is clean.

## What we fixed

**The review→fix arrow could never find its PR.** `release_stale_claims` and
`redispatch_unresolved_reviews` located an issue's PR with
`gh pr list --search "task/issue-N- in:head"`. That reads GitHub's *search index*,
which tokenizes and ORs. Measured live:

```
search 'task/issue-710- in:head'              -> EMPTY   (PR #711 exists)
search 'issue-710 in:head'                    -> [711]
search 'feat/autonomous-job-operator in:head' -> [707, 708]   (#708 head is feat/durable-worker-runtime)
```

Wrong in both directions. The false negative was **live**: issue #710 sat at
`agent:review` with draft PR #711 carrying a current-head `<!-- brain-reviewed:`
marker and 0 attempts, skipped by every 15-minute tick.

Replaced both call sites with `pr_for_issue()` — exact `headRefName` prefix match
over `gh pr list --json`, filtered in real `jq`. Same determinism
`claim_and_implement` already had from `--head "$branch"`.
[PR #721](https://github.com/pushkarverma3698/FounderOS/pull/721), gate green
(401 files / 4482 tests, exit 0). Hot-patched onto the VPS so the live loop works now.

Before / after, same tick command:

```
before:  tick complete — claims=0                                     (nothing for #710)
after:   DRY RUN would re-dispatch Antigravity for PR #711 (issue #710, attempt 1)
real:    15:00:06Z PR #711 reviewed at e83d398b and left draft — re-dispatching (attempt 1)
```

## Why

The loop is the product: the founder's stated goal is for FounderOS to carry his
engineering work on the employer's repos. A loop with a silently dead arrow does
not fail — it *stalls*, and a stalled issue looks exactly like a busy one. Rule #34:
every arrow needed a command run and output shown, not an assertion that it works.

## Metrics

- Dispatch → draft PR on a cold repo: **7 min** (15:08:20 → 15:15:22).
- Draft PR → review verdict: **4 min** (15:20:11 → 15:24:15).
- Full loop, issue filed to PR cleared: **~23 min**.
- `agent:ready` issues ever seen on either Oplify repo before today: **0**.
- Issues currently stranded at `agent:failed`, still open: **8**, oldest 2026-08-18.
- Issues stranded at `agent:review` whose PR already merged: **2** (#669, #670).

## Outstanding

Open defects found, not fixed here (ranked):

1. **`GOOGLE_GENERATIVE_AI_API_KEY` is world-readable in the VPS process table.**
   `run_agy_with_progress` passes it as a positional arg to
   `sudo -u antigravity bash -lc`. `/proc/<pid>/cmdline` is mode `0444`; confirmed
   readable from the unprivileged `founderos` account while a run was in flight.
   Same class as the 2026-08-12 `.env` leak. Exposure ≈30 min per invocation.
   Needs the key rotated *and* the passing mechanism changed (stdin or `sudo -E`,
   not argv). The in-code comment claims positional args are the safe choice —
   they defeat *shell injection*, not `ps`.

2. **`main`'s `deploy/agent-dispatch` is a half-applied fix.** It declares
   `target_branch` and uses it in the prompt text, but the real `git checkout` still
   hardcodes `origin/main`, and `claims_done` is a scalar (one claim anywhere blocks
   claims in the other repos that tick). `beta` is byte-identical to the live VPS copy
   (`md5 d411728c…`); `main` is not. Any redeploy from `main` regresses the loop.

3. **The Oplify agent contract lives only as untracked files in a disposable
   workspace.** `docs/antigravity/{ISSUE-DRIVEN-CONTRACT,STANDARDS}.md`, `CLAUDE.md`
   and 40+ codebase docs existed only in `/opt/agy-workspace/oplify-*`, untracked.
   `claim_and_implement` runs `git clean -fdq`. **Issue #32's claim deleted all of
   them** — verified after the fact. The dispatch prompt's first instruction is to
   read two of those files, so the Oplify agent ran its first task with no contract.
   Backed up to `founderos-vps:~/oplify-docs.tgz` + `~/oplify-api-docs.tgz` (43 files).
   Either commit them to the Oplify repos or stop pointing the prompt at them.

4. **Pass B counts an attempt even when the executor changed nothing.**
   `redispatch_unresolved_reviews` posts `<!-- agent-attempt: N` unconditionally —
   no exit-code check, no head-SHA check (Pass A checks both). On PR #711 the run
   started `pnpm gate` in the background, hit agy's "root agent idle" path, waited
   5s, killed it and exited. Head unchanged, zero commits, attempt 1/3 burned.
   Three such no-ops mark the issue `agent:blocked` with no real fix ever tried.

5. **No path out of `agent:review` except `agent:blocked`.** The only transition is
   the 3-attempt escalation. A cleared PR leaves its issue open at `agent:review`
   forever — #669 and #670 have sat there since 2026-09-09 with **merged** PRs.
   (The founder does get a Telegram verdict from `pr-brain`, so this is bookkeeping
   noise rather than lost signal — but the issue queue is not a usable work list.)

Lower severity, recorded for completeness:

6. `AGENT_DISPATCH_BIN` is unset in prod `.env`, so `kickDispatchTick` is a permanent
   no-op and `src/tools/dispatch-tick.ts` never runs in production. Every dispatch
   waits for cron. Cron is the guaranteed path by design, so this costs ≤15 min —
   but the "seconds, not minutes" behaviour does not exist and nothing says so.
7. Neither Oplify repo has CI workflows or branch protection on `main`. `pr-brain`'s
   `ci_failed` re-dispatch branch can therefore never fire there, and the only gate on
   an agent PR is `pr-brain` itself. The employer-org merge guard (#713) is what makes
   this safe; it is a single `case` statement and should be treated as load-bearing.
8. `pr-brain`'s `notify()` discards the Telegram API response (`-o /dev/null … || true`),
   so delivery is unverifiable from the log. Notification *firing* is confirmed; arrival
   is **NOT VERIFIED**.

Verified healthy (checked, no action needed): prod build carries the 4-repo allowlist
and was built 5s before the service started; `pr-adversary` skill on the VPS is
byte-identical to the laptop copy; `/opt/review` auto-discovery finds all three repos;
`pr-brain`'s own-author filter correctly ignores colleagues' PRs; both kill switches absent.
