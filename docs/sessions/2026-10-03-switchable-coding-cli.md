# 2026-10-03 — Switchable coding CLI (Claude Code ⇄ Antigravity)

## What we did

Built the engine switch at Full depth. The founder can hand a Telegram task to a named coding CLI or set
the default; the loop (issue → executor → draft PR → review) runs the same for either.

- `/claude <work>`, `/agy <work>`, `/engine`, `/engine claude|agy`. Default is one word in `~/.claude/coding-engine`.
- Daemon: executor per issue = its single `engine:*` label, else the default file, else agy. Per-CLI walls
  (`agent-dispatch.down` + `quota-until` for agy, `agent-dispatch.claude-blocked` for claude). The Claude token
  travels on stdin only. `pr-brain` never reviews an `engine:claude` PR with a `claude-*` model.
- Bot: the dispatch tool takes `engine`, files one `engine:*` label, the HITL card names the executor, and the
  engine survives the repo buttons and the force-reply prompt (`Executor:` line).
- PR: pushkarverma3698/FounderOS#818 (draft, base `beta`). Commits `7f742a2d`/`3be98efb` (daemon), `deb19a51`/`5300c7c9` (bot).

## What we fixed

- Temp-file leak when the rename in `writeDefaultEngine` fails: caught by writing the test first.
- `home-menu.test.ts` caught that the Build screen did not name the new commands (found by the full gate, not by the
  files I had listed).

## Why

Oplify office tasks are the first real use, and one CLI's quota or login wall must not stop the other. Selection is
pure code in two readers (bash and TS) that must agree on every file content, so both are strict: the first line with
whitespace removed is exactly `claude`, or the answer is agy. A typo never sends work to a CLI nobody picked.

Decisions worth keeping:
- `coding-engine.ts` is in `src/tools/`, not `src/gateway/`: the dispatch tool imports it and R1 forbids non-gateway
  code importing the gateway.
- The engine is resolved before `hitlGate` and passed to `execute` by name, so a `/engine` switch between card and tap
  cannot change who the approved card said would run it. The idempotency key includes the engine.
- `/engine` reads the file back after writing; "now X" is said only if the file says X.
- The approval card is the guard if the planner omits `engine`: it names the default that will run.

## Metrics

- Bot: `tests/unit/gateway` + `tools` + `agents` → 169 files, 2293 tests pass on the merged tree.
- Bash/TS parity table: 14 contents, identical answers.
- Daemon test files, run one at a time: engine 47, midrun 13, failures 39, quota 6, kick 22, intake 17, ci-red 10,
  review-spend 27, claude-run 30, onboard-repo 47, pr-brain-agy 49/50.
- macOS flake: BSD `mktemp` does not randomise `XXXXXX` when a suffix follows, so the bash-driven script tests collide
  when run in parallel. They pass alone. Pre-existing failures on base `714435cf`: `pr-brain-token` ×5, one `pr-brain-agy`.

## Outstanding

- Claude's success path on the VPS: needs the founder's token (`claude setup-token`).
- Live Telegram run (`/claude` → card → issue → daemon → PR) on a real Oplify task.
- `engine:agy` and `engine:claude` labels on the 4 `DEFAULT_REPOS` after merge.
- Planner prompt and `capabilities.ts` still describe dispatch as Antigravity-only.
- `down-state` "never puts a literal secret on any command line" fails on this Mac; unchanged file and test, not run on base.
