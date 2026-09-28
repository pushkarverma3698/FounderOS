# 2026-09-28 — PR sweep, pr-brain outage spam, beta re-joined to main

## What we did

- **pr-brain notification volume** (`deploy/vps-daemons/pr-brain`, PRs #732, #736). A Claude outage
  is now one "PAUSED" message and one "resumed" message. A PR whose own gate fails is announced on
  attempt 1 and on give-up at attempt 3, and that head is not retried until a new push. App-gate
  screenshots go out once per head (issue #730). Deployed to `~/bin/pr-brain` by hand
  (`deploy/vps-daemons/README.md`); SHA-256 matched `main` after each copy.
- **PR #731 (chat-audit UX)** reviewed, two defects fixed on its branch, merged, deployed
  (`861ba0f`, service restarted 06:26:45 UTC), then driven through real Telegram with
  `scripts/telegram-probe.ts` on the VPS.
- **Closed unmerged, with evidence on each PR (branches kept):** #707 and #708 (worker milestones,
  ~11k lines, no founder-reachable entry point, two prod migrations), #711 (README test comment from a
  dispatch smoke test), #712 (a second LLM router on every Telegram message, plus a multi-repo loop
  already on main). Issues closed: #710 (smoke test), #725 (already fixed by #726).
- **beta re-joined to main.** Every line of `git diff main beta` was main-only content. #733 merged
  a commit with both parents and main's tree. After that, the automated sync PRs #699 and #734
  merged clean. `git diff origin/main origin/beta` is 0 lines.
- **Leftover branches.** 33 of the 49 branches with commits not on main belong to merged PRs; they
  are stale refs only. 5 belong to closed PRs. 9 have no PR, and none should land:

  | Branch | Why not |
  |---|---|
  | `feat/autonomous-ats-apply` | `submitOneRow` submits a real application from a headless browser with **no HITL gate** |
  | `fix/jobhunt-pipeline-audit-fixes` | adds unrequested filters (over-senior title regexes; skips a board after 10 failures without saying so) |
  | `feat/ind-sponsor-discovery` | only wiring is a schema addition; 22 days stale, conflicting |
  | `feat/ag-015-kernel-timeout{,-fix}` | AG-015 shipped in #702; these only add env knobs |
  | `feat/ag-016-fallback-health-check` | AG-016 closed as already fixed (#704) |
  | `feat/ag-020-env-drift-fix` | resolves `.env` from the script dir, which is the same as cwd in practice. The real `brain:sync` defect (local DB write reported as success) is untouched |
  | `docs/fresh-first-jobhunt-plan` | plan for a feature that already shipped |
  | `fix/gate-717-conflict-resolve` | merging it adds nothing |

- **PR #735** (another session: `search_memory` project scope) reviewed. Both columns it filters on,
  `memory_type` and `project`, exist on prod `brain.brain_memories`.

## What we fixed

| Defect | Found by | Fix |
|---|---|---|
| 72 "Gate FAILED" Telegram messages/day (09-26, 09-27) while Claude was over its weekly limit | `~/.claude/pr-brain.log` on the VPS | #732: every non-`ok` preflight reply counts as an outage, announced once |
| oplify-messaging-app#35 screenshots sent 6× in 100 min (issue #730) | log: `app gate: rendered` at 11:23…13:07 on 09-23 | #732: `~/.claude/pr-brain.photos/<repo>#<pr>` records the head that was sent |
| `/task repo:<name>` with no work: the founder's reply was never dispatched | review of #731 (the prompt had no `Repo:` line) | `buildRepoPrompt`. Verified live: the prompt now ends `Repo: pushkarverma3698/FounderOS` |
| Error replies deleted English words ("read from" → "read [query]") | review of #731 | SQL scrub is uppercase-only |
| **Regression I introduced:** the preflight prints `Error: Exceeded USD budget (0.05)` before it answers, #732 read that as an outage and paused all gating, and sent one false "PAUSED" message at 06:20 | the first live tick after deploy | #736: a budget-cap error means the call was billed, so Claude is reachable |

## Why

Two of these fixes follow from the same rule: a message goes to the founder only when something
changes. Output repeated every tick for a state that has not changed teaches him to ignore the
channel. The #736 regression happened because the preflight's real output was never checked; the
old script had passed `Exceeded USD budget` silently for weeks. **Before tightening a check, read
what that check actually returns in production.**

## Metrics

- `pnpm gate` exit 0 on each shipped head: 416/4674, 416/4681, 417/4691 (files/tests).
- pr-brain test file: 10 cases against the real script with stub `claude`/`gh`/`curl`. Removing any
  of the 8 guards fails at least one case.
- Live Telegram (MTProto, real transport): `/task repo:founderos` answered in 3 s with the `Repo:` line.
  `/remind` answered in 3 s with its usage text.
- Planner "did not return JSON": 3 on 09-16, 0 since. The in-band retry on main already fixes it.

## Outstanding

- **Gmail + Calendar are DOWN on prod.** `gws` returns `401 invalid_grant` (checked live 2026-09-28).
  The boot probe has alerted on Telegram at every restart since 09-23. Only the founder can re-run the
  OAuth login on the VPS.
- #735 surfaced a `DOTENV_PRIVATE_KEY_DEVELOPMENT` value that had leaked into 3 brain rows. The value
  is redacted now. Whether to rotate it is the founder's decision.
- NOT VERIFIED live: the stale-approval-card rejection (#731). Checking it needs a real HITL card
  that the MTProto probe does not tap.
