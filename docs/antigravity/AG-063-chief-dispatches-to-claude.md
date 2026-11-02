# AG-063: the Chief of Staff hands its work to claude (haiku), agy when claude is out

Founder decision 2026-10-11: "write the Chief brief and if claude limit is full it can use agy. And for basic
work it can use claude cli on haiku and then test properly and verify."

Depth: **Full** (acts on the founder's behalf: files issues, moves labels, merges PRs).
Base: PR #1120 branch `claude/chore-opendots-migration` (or the branch it lands on; check `gh pr view 1120`).
Live tests: `pushkarverma3698/opendots-sandbox` only.

## Why

Every OpenDots Dot step is a paid OpenRouter request that re-sends the whole run. The three engineers already
dispatch (one `team-shift` command per shift, 2–3 model calls). The Chief of Staff still does its own shell work:
`gh issue list`, `gh pr view`, label swaps, merges, each one a model step. A status chat on 2026-10-11 used 12
steps and hit the limit; the limit is now 30 (`opendots-turicks.patch`, `CHAT_MODEL_CALLS`). The Chief is now the
main OpenRouter cost.

Outcome: a Chief chat turn costs **at most 2 OpenRouter calls**. claude (subscription, haiku) does the gh work,
agy does it when claude hits its usage limit, and the script checks the result in code before it reports
"done".

## What exists (read these first)

- `deploy/opendots/team-shift`: the pattern to copy. It contains the claude allowlist, `LIMIT_RE`, `agy_settings()`
  (claude allowlist → agy `permissions.allow/deny`), the agy login check (`antigravity-oauth-token`), and the
  "a finished run is judged by the GitHub state, not by its exit code" rule.
- `deploy/opendots/run-bg`: OpenDots kills a shell command after 70 s. `run-bg wait` blocks for up to 60 s.
- `deploy/opendots/dot-login`: chat-driven claude/agy/gh login, present in every computer.
- `deploy/opendots/setup-dots.sh`: the `CHIEF` prompt (max 2000 chars, zod), plus `copy` and the `LOGINS`/`AGY`
  arrays. The Chief computer (`abe81ab1…`) has a gh login only; it has no claude or agy login.
- `deploy/opendots/team/*.md`: claude briefs per role. Add `team/chief.md` in the same style.
- `tests/unit/scripts/opendots-team-shift.test.ts`: fake `claude`/`agy`/`gh` binaries on PATH. Copy that harness.

## Build

1. **`deploy/opendots/chief-run "<founder's words>"`** (new script, installed like `team-shift` in `install.sh`):
   - Starts `claude -p --model haiku` with `team/chief.md` + the request, under `run-bg`. Then `run-bg wait`
     and print the result. If the run is still going after 60 s, print `still running: chief-<id>`. The next turn
     runs `chief-run --status chief-<id>`, which is one command and so one step.
   - Allowlist: `Bash(gh issue *)`, `Bash(gh pr view *)`, `Bash(gh pr list *)`, `Bash(gh pr checks *)`,
     `Bash(gh pr edit *)`, `Bash(gh pr merge *)`, `Bash(gh api repos/<REPOS>/*)` read only. Deny `git push`, `rm`,
     `curl`, edits. Only repos in `TEAM_REPOS`.
   - Model: haiku by default (`CHIEF_MODEL` overrides it). The Chief never writes code; engineering goes to the
     team as an `agent:plan` issue. So haiku is enough, and there is no in-model "is this basic?" routing.
   - On `LIMIT_RE` in claude's output: rerun the same request with agy (`agy_settings` from the same allowlist).
     With no agy login, print `claude is at its limit and this computer has no agy login; dot-login agy start`.
     Factor the shared pieces (`LIMIT_RE`, `agy_settings`) out of `team-shift` rather than copying them.
2. **Verify in code, not in haiku's words.** `team/chief.md` makes claude end with one line per action:
   `ACTION <kind> <repo> <number>` (kinds: `issue-created`, `label`, `merged`, `commented`). For each line,
   `chief-run` re-reads GitHub itself and prints `✓` or `✗ <what GitHub shows>`:
   - merged → `gh pr view N --json state` is `MERGED`
   - issue-created → the issue exists with `agent:plan`
   - label → the label is present
   Only ✓ lines may say done. A claimed action with no ACTION line, or an action GitHub doesn't show, prints
   `NOT VERIFIED - <reason>`.
3. **Merges stay founder-named.** `chief-run` refuses `merged` unless the PR number appears in the founder's
   request text and the PR has `agent:approved`. Enforce this in the script (the allowlist alone is not enough),
   with a unit test.
4. **Chief prompt** (`setup-dots.sh` `CHIEF`): "For any request, run exactly one command, `chief-run "<his exact
   words>"`, and relay its output in at most 5 lines. Login/logout requests: `dot-login`. Nothing else." Keep the
   "Chief of Staff" page duty only if it fits in the same turn; otherwise move it into `chief.md`.
5. **Logins for the Chief:** `setup-dots.sh` copies the Builder's `LOGINS` and `AGY` into the Chief computer
   (never overwriting, as for the others). Add a `dot-login` line to the prompt so the founder can switch it from
   chat.

## Tests (failing first)

In `tests/unit/scripts/opendots-chief-run.test.ts`, with fake binaries:
- haiku is passed (`--model haiku`), and `CHIEF_MODEL` overrides it
- a claude limit message → agy runs the same request; no agy login → the exact message above
- `ACTION merged` with `gh` showing OPEN → `✗` and no "done"
- a merge of a PR the founder didn't name, or one without `agent:approved` → refused
- a run still going after 60 s → `still running: chief-<id>`; `--status` returns the result
- the CHIEF prompt is ≤ 2000 chars (the existing setup test covers it, so extend it)

## Verify live (sandbox only)

1. `bash deploy/opendots/install.sh`, then `setup-dots.sh` on founderos-vps. Show that the Chief computer
   has `.claude-token` and `antigravity-oauth-token` without printing either.
2. In the Chief chat:
   - "status": expect one line per agent:* item
   - "new issue: add a /health route to the sandbox": expect ✓ issue-created with agent:plan
   - "merge PR 16" (if still approved): expect ✓ merged
3. Count model steps per turn from the OpenDots run record. Expect ≤ 2 per turn. Show the numbers.
4. Force the agy path once: run `CHIEF_FORCE_LIMIT=1` (a test hook that only fakes the limit text) through
   `chief-run` in the computer. Show that agy did the same request.
5. Update the PR #1120 body (What changed / How verified / NOT VERIFIED).

## Strongest argument against

A haiku run takes 10–40 s and adds subscription usage to every chat. Simple reads like "status" might be cheaper
as a fixed `gh` script with no model at all. If step 3 shows status turns dominate, add `chief-run status` as a
pure script, with no claude, before anything else.

## Never

Print tokens, change OpenRouter settings or the model, touch `/opt/founderos`, use
`--dangerously-skip-permissions`, or work outside `opendots-sandbox` in live tests.
