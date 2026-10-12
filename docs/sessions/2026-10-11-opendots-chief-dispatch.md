# 2026-10-11: The OpenDots Chief dispatches to claude (AG-063)

PR #1120 (draft, `claude/chore-opendots-migration` → beta), head 42bdb092. Deployed to founderos-vps OpenDots.

## What was built
- `deploy/opendots/chief-run`: one shell call per Chief chat turn. It runs claude haiku through `run-bg` with a
  `gh <cmd> -R <team repo>` allowlist and falls back to agy on a usage limit (shared `team-lib.sh`). Code checks
  every `ACTION` line on GitHub.
- Merges are done by the script, never by claude: only a PR the founder named, and only with agent:approved.

## What we learned
- A claude `--allowedTools` prefix rule depends on argument order: `gh pr view 16 -R R` is refused under
  `Bash(gh pr view -R R:*)`. The brief now shows `-R` right after the subcommand.
- The Dot model sometimes sends one request as 2–3 parallel `computer_exec` calls in a single step.
  `chief-run` joins identical words within 90 s.
- The computer tool's description pushes a `computer_snapshot` first. The prompt has to forbid that, or every turn
  pays an extra model call.
- Thread messages live in CopilotKit Intelligence, not the local sqlite. Count model calls by driving a turn
  through `IntelligenceAgent` (the scratch helper `od-steps.mjs`).

## Result
Each Chief turn takes 2 model calls (target was ≤2): status 22 s; new issue #17 in 18 s; merge PR 16 into beta in
19 s, checked on GitHub. Forced-limit agy fallback answered status correctly.

## Open
A real claude limit; agy doing a write action; issue close after a merge with a linked issue; the founder answering a
blocked item in chat.
