# AG-064: the Builder takes direct tasks, picks claude or agy, and shows progress

Founder request 2026-10-11: "I want to assign more tasks to the builder directly, and it calls agy or claude,
whichever I tell it to, and does my work. Will the builder give complete reasoning at the end and show what is
happening in between? Will I see the terminal running in the chat?"

Depth: **Lite** (OpenDots scripts and prompts; no money, auth or prod data). Base: PR #1120 branch
`claude/chore-opendots-migration` after AG-063 (826923e8). Live tests: `pushkarverma3698/opendots-sandbox` only.

## Answer to "will I see the terminal in the chat?"

No. An OpenDots chat shows Dot replies, not a live terminal. The run is a tmux session inside the Builder's
computer. What the founder gets instead: "what's happening" returns a ≤5-line snapshot of the run (the last
tool calls and text), and the run ends with a WHAT I DID / WHY / WHAT'S LEFT / RESULT block.

## Build

1. **Direct task.** `team-shift builder --engine claude|agy --task '<words>' [--repo owner/repo|name]`:
   - The repo must be a team repo (`/workspace/team-repos`). With one team repo, `--repo` is optional.
   - One Builder run at a time: an open job prints `Busy: ...` and files nothing.
   - `--engine agy` with no agy login on the computer refuses before filing anything (`dot-login agy start`).
   - Files the task as an issue labelled `agent:building` (labels and the audit trail keep working), then starts
     the chosen engine on it through the existing `start()`. The prompt says the issue body is the plan.
   - claude stopping on its usage limit still hands over to agy (founder decision 2026-10-11), and says so on
     the issue.
2. **Progress.** claude runs with `--output-format stream-json --verbose`. A jq filter turns each event into one
   readable log line (`> Bash: <command>`, `> Edit: <file>`, assistant text), so `run-bg tail`, the RESULT and
   limit greps keep working. agy has no stream output; its progress is "running N min" plus whatever it printed.
   `team-shift <role> --progress` is read-only and prints at most 5 lines: the run header plus the last 4 log
   lines, each cut to 160 characters.
3. **End-of-run reasoning.** `team/team.md` makes every run end with four lines: `WHAT I DID:`, `WHY:`,
   `WHAT'S LEFT:`, `RESULT:`. `Done:` prints that block (falls back to the RESULT line alone).
4. **Builder prompt** (`setup-dots.sh`, ≤2000 chars): the task, progress and shift commands; about claude or agy
   it runs `dot-login status` and never answers "the Chief handles that".

Permissions stay an explicit allowlist. No `--dangerously-skip-permissions` (standing founder rule).

## Tests first

`tests/unit/scripts/opendots-team-shift.test.ts`: direct task files an issue and starts the named engine; repo
outside the team is refused; busy Builder refuses; agy without login refuses; claude gets stream-json and still
no skip-permissions; `--progress` ≤5 lines and read-only; Done prints the reasoning block; Builder prompt ≤2000
chars, contains `--engine`, `--progress` and `dot-login status`.

## Live proof (sandbox)

`/tmp/od-say 4740d695-5ff7-45ea-8c70-9f9883de66e2 new "Builder, use claude: <task> in opendots-sandbox"`, then
"what's happening", then read `/app/od-hist.mjs`. Show the issue, the progress lines and the final block.
