# 2026-09-10 — the Claude↔Antigravity loop: what already existed, and the two gaps closed

## What we did

Started from a question — *"what is pr-brain when we have turicks-brain?"* — and ended up
auditing the whole autonomous loop. The headline finding is that **most of it was already
built and nobody knew the commands**, and that **the review half has been dead for 24 days**.

The three systems, which are unrelated despite the shared "brain" word:

| | What it is | Where |
|---|---|---|
| `turicks-brain` | MCP server — read/write access to the unified Postgres knowledge base | `src/mcp/turicks-brain.ts`, reached over SSH by `founderos-brain-mcp.sh` |
| `agent-dispatch` | Issue → headless Antigravity → PR | VPS cron `*/15`, `~/bin/agent-dispatch` |
| `pr-brain` | PR → headless `claude -p` running the `pr-adversary` skill → approve / fix / reject | VPS cron `*/20`, `~/bin/pr-brain` |

`agent-dispatch` and `pr-brain` together already form the full loop, including the
re-dispatch arrow: its **Pass B** finds PRs `pr-brain` reviewed and left uncleared, re-invokes
Antigravity on the same branch, and after `AGENT_DISPATCH_MAX_ATTEMPTS` (3) marks the issue
`agent:blocked`. An earlier claim in this session that the second arrow did not exist was
**wrong** and is corrected here; the VPS script was rewritten the same day (386 → 512 lines).

Two corrections to the docs came out of the audit:

1. **CLAUDE.md's "Antigravity is GUI-only, laptop-only, never cron or VPS" is stale.** That
   describes the `agentapi`/`language_server` mechanism the laptop `agy` wrapper drives. A
   genuine **headless Antigravity CLI** — a 201MB binary at
   `/home/antigravity/.local/bin/agy`, run as unprivileged user `antigravity` — is installed
   on the VPS and is what `agent-dispatch` invokes. Two different binaries share the name
   `agy` with incompatible interfaces (`new/send/status` vs `--new-project --print`).
2. `request-claude-review/SKILL.md` tells Antigravity to target `main`, while
   `doer-contract/SKILL.md` says `beta` only and `pr-adversary` flags a `main` base as a
   finding. The loop currently produces PRs its own gate would reject. Not yet fixed.

## What we fixed

**PR #673**, two commits, both `pnpm gate` green.

**1. `fix(security)`: pinned dispatch to a repo allowlist.**
`repo` on `dispatch_antigravity_task` was model-supplied and validated only as "contains a
slash", outranking both `ISSUE_REPO` and `SELF_IMPROVE_ISSUE_REPO`. The VPS `GITHUB_TOKEN`
carries `repo`, `admin:org` and **`delete_repo`**. New `src/tools/dispatch-repos.ts` is the
single choke point — hardcoded list, no env override, following
`VPS_RUN_PROFILE.imageAllowlist`. Both independent validators now share it, env vars pass
through the same gate, and three-part slugs are rejected instead of truncated.

It also fixed **an approval card that misreported its target**: the wrapper caught the resolve
failure and fell back to FounderOS, so a request naming another repo rendered a card reading
*"Open agent:ready issue on pushkarverma3698/FounderOS"*. The founder would approve a target
the card got wrong. Now refuses before the gate, purely, as the `hitlGate` re-run contract
requires.

**2. `feat(gateway)`: `/task`, plus the dispatch tick kick.**
`/task [repo:<hint>] <what you want built>`. Repo resolution is pure code before any model
call; `repo:` is honoured only as the first token so `/task mention repo:hulda in the readme`
cannot retarget the dispatch. The handler composes an instruction and hands it to the ordinary
kernel turn, preserving the HITL card.

## Why

Three design decisions worth not re-deriving:

- **The kick lives in the tool, not the `/task` handler.** `src/gateway/kernel-run.ts:203-208`
  returns as soon as the approval card is posted — minutes to hours before the issue exists.
  A kick in the handler would fire against an empty queue. At the tool layer it also covers
  the plain-English path and the self-improvement loop.
- **`/task` routes through the kernel rather than rendering its own approval card.**
  `formatApprovalCard` hardcodes `approve`/`reject` callback payloads and `telegram.ts`
  routes every such callback to `resumeKernel` — a bespoke card would mean tapping Approve
  resumes an unrelated paused checkpoint. Free text also has to become a five-field
  template-shaped brief, and filing a stub with `agent:ready` would burn a real Antigravity
  run on an unusable brief.
- **`repo` stayed `z.string()`, not `z.enum`.** LangChain validates the Zod schema before the
  tool body runs, so an enum throws a generic schema error instead of the actionable refusal.
  Tools here return messages, they do not throw. The allowlist is named in the field
  description so the model still sees the choices, and enforced at runtime.

Two CI facts that shaped the work: `src/core/config.ts` is at **397 lines** and six files
already exceed the 400-line ratchet, so adding a `.refine()` there would have failed
`verify:arch` — policy belongs at the dispatch path anyway. And a second cron line for a
second repo cannot work: `agent-dispatch` holds one global `mkdir` lock for up to 1800s, so
the second repo would be starved by construction.

## Metrics

| | |
|---|---|
| `pnpm gate` | EXIT=0 — 385 test files, **4,229 tests** passed |
| New source files | `dispatch-repos.ts` 109 · `task-command.ts` 140 · `dispatch-tick.ts` 62 (budget 400) |
| Architecture ratchet | unchanged — loc-budget 6, gateway-imports 0, kernel-purity 0, fail-open-catch 11 |
| New test cases | 17 allowlist · 13 `/task` · 5 kick · 6 refusal cases across existing suites |
| `pr-brain` consecutive auth failures | **1,725**, since 2026-08-16T18:20Z |
| Issues stuck at `agent:review` | #669, #670 — unreachable by Pass B while the reviewer is down |

## Outstanding

**Founder-only, blocking everything else:**

1. `ssh founderos-vps` → `claude` → `/login`. Until this is done the loop's review half stays
   dead and Pass B can never fire, because no `<!-- brain-reviewed: -->` marker can appear.
2. `scp founderos-vps:bin/agent-dispatch ~/Projects/scripts/ai-tools/agent-dispatch` —
   the laptop copy is the stale 386-line version. **Direction matters**: copying the other way
   destroys the rewrite.
3. Decide on the pr-brain notify throttle — it Telegrams on *every* failed sweep, which is
   what produced ~1,725 pings.

**Built but unproven (needs a live run):**

- `/task` has never been sent through real Telegram. Per rule #24 that is the only thing that
  proves the planner routes to `dispatch_antigravity_task`.
- The kick has never spawned a real process; whether it works from inside
  `founderos.service` (cgroup, PATH) is untested.

**Not started (Phases 3–5 of the approved plan):** multi-repo `agent-dispatch` loop,
`agent-task` local trigger, `agent-loop-doctor`, House-of-Hulda provisioning. Gated behind
item 1 deliberately — shipping them into a dead reviewer would widen a clogged drain.

**Logged, out of scope:** `~/.cursor/mcp.json` and `~/.gemini/config/mcp_config.json` hold
plaintext API keys where the Claude configs use `${VAR}`. The `founderos` MCP server fails
from every worktree (`.mcp.json` passes a relative `--env-file=.env`; `.env` exists only in
the main checkout).

---

## Second pass — command audit, new-project repos, QA

### The command audit found nothing to delete

The ask was "register all the commands and delete which are not usable and are stale."
**All 29 commands are registered and none are stale** — and that is not an assumption:
`command-menu.test.ts` already asserts the menu and the `bot.command(...)` registrations
agree in BOTH directions, and `advertised-commands.test.ts` already blocks a `/start`
screen that names a command which does not exist. A sweep of every slash-shaped token in
`src/` returned only regex alternations, filesystem paths, HTTP routes, and the header
comments in `capability-message.ts` / `command-menu.ts` that deliberately record the
twelve commands deleted with v2. Those are history, not drift.

Two real gaps, both discoverability rather than staleness:

1. **`/start` never mentioned `/task`.** The command built in the first pass to close a
   discoverability gap was itself invisible on the first screen the founder sees. Fixed.
2. **`docs/DEVELOPER.md` § "Adding a Telegram Command" was stale in a way that actively
   misleads.** It claimed 4 touch points in 2 files, told you to hardcode help text
   inside `handleCommands` (not how it has worked since `command-menu.ts` became the
   single list), imported a `handleDirectQ` that died with v2, and said a missing
   registration is "silently ignored by Telegram" — `unknownCommandReply` has answered
   those for weeks. Anyone following it would have failed CI and shipped an invisible
   command. Rewritten to the real 5 touch points across 3 files, with the Forget→Error
   table naming the test that catches each omission.

### Starting a new project

`github_write create_repo` already made repos and always could. The gap was that a repo
created that way was **not dispatchable** — `DISPATCH_REPO_ALLOWLIST` is compiled in, so
anything created after the last deploy was refused as off-list. "Start a new project and
build me X" stopped at the second half, with the founder's own new repo locked out until
a code change shipped.

`create_project_repo` creates AND registers in one approved action. The allowlist's
security property survives because **naming a repo is still not how one gets in**: the
only entry is creation, which uses `createForAuthenticatedUser` (owner is always the
founder), is HITL-gated with a card that says approving grants the unattended loop write
access, and registers only after GitHub confirms the repo by its returned `full_name`.

The registry is `action_log`, not a new table — a repo is dispatchable BECAUSE a durable
row attests the founder approved creating it. One fact, one row, no second store that can
disagree with the first, and **no migration** (the drizzle journal has silently no-op'd on
prod before). `registerDispatchRepo` has exactly one caller and no model-reachable path
can forge the action string; `assertDispatchableRepo` re-validates registry rows rather
than trusting them, and a read failure degrades to the hardcoded list rather than taking
dispatch down for the two provisioned repos.

`/newproject <name> <what it is>` is the command surface. Note the grammar: `/newproject
my cool thing` means a repo called `my` — the approval card prints the resolved name,
which is where that gets caught.

### QA audit of the first pass

Four claims checked against reality rather than re-read:

| Claim | Verdict |
|---|---|
| `--issue N` is a real `agent-dispatch` flag | ✅ line 197 of the VPS script, documented at line 25 |
| `docs/rules/TOOL-STANDARDS.md` says tools never throw | ✅ exists, line 28 says exactly that |
| The new `ISSUE_REPO` throw cannot fire on prod | ✅ crontab pins it to `pushkarverma3698/FounderOS`; `SELF_IMPROVE_ISSUE_REPO` unset |
| `String(isPrivate)` is what `github.ts` parses | ✅ `github.ts:329` accepts `"true"` or `true` |

No defects found in the first pass. Two test bugs of my own were found and fixed while
extending them (a substring that did not appear in the fixture; an input I called invalid
that the grammar legitimately accepts).

**A finding outside this scope, logged not fixed:** `docs/DEVELOPER.md` § "Adding a
Department" describes the **v2 LLM supervisor** — `createSupervisor` and
`office-invoker.ts`, both of which now survive only in comments and are tombstoned in
`verify-architecture.ts`. The section is marked with a warning; it needs a rewrite.

### Metrics (second pass)

| | |
|---|---|
| `pnpm gate` | EXIT=0 — 386 test files, **4,270 tests** |
| New source files | `create-project-repo.ts` 197 · `project-repo.ts` 110 (budget 400) |
| Architecture ratchet | unchanged — loc-budget 6, gateway-imports 0, kernel-purity 0 |
| New test cases | 17 create-project-repo · 12 allowlist registry · 7 `/task`+`/newproject` |
| Commands registered | 30 (29 + `/newproject`), menu agreement enforced both directions |

### Still outstanding after this pass

Unchanged and still blocking: **pr-brain's auth**. Everything above is producer-side; the
reviewer half has now been dead 24 days.

New and specific to this pass: `create_project_repo` returns the VPS provisioning
commands but **does not run them**. `agent-dispatch` has no `git clone` anywhere — it
fetches and resets ONE pinned workspace — so until Phase 3 (multi-repo loop) lands, an
issue filed against a newly created repo is an issue nothing will ever claim. The tool
says so in its own output rather than failing silently.

Neither `/newproject` nor `create_project_repo` has been exercised on the live Telegram
path. **NOT VERIFIED** per rule #24.
