# Switchable coding CLI (Claude Code ⇄ Antigravity) — plan + handoff

Status 2026-10-03: designed, not built. Branch `claude/feat-switchable-coding-cli` (off `origin/beta`
at `abce46ee`). Written as a handoff: the session that designed it compacted twice.

## Outcome

The founder assigns a task from Telegram to a named coding CLI, or switches the default, and the whole
loop (issue → executor → draft PR → review) runs the same way for either. First real use: Oplify office
tasks (`OplifyMessage/oplify-messaging-app`, `-api`).

## Founder-facing commands

| Command | Effect |
|---|---|
| `/task <work>` | as today, executor = current default |
| `/claude <work>` | same flow, executor = Claude Code |
| `/agy <work>` | same flow, executor = Antigravity |
| `/engine` | shows the default |
| `/engine claude` / `/engine agy` | sets the default |

The default lives in `~/.claude/coding-engine` (one word). The bot (founderos user) writes it; the dispatcher reads it.
The HITL card names the executor before approval ("… for Claude Code").

## Build list

TS (bot):
1. `src/gateway/coding-engine.ts`: `Engine = "agy" | "claude"`, `readDefaultEngine()` and `writeDefaultEngine()` on the file, `engineLabel(e)` → `engine:<e>`, and display names.
2. `src/tools/dispatch-antigravity.ts` plus `src/agents/agent-tools/antigravity.ts`: optional `engine` param, added to BOTH the zod schema and the explicit args pass-through. When it is absent, resolve the default at filing time. Always add the `engine:<x>` label. The card summary names the engine.
3. `src/gateway/task-command.ts`:
   - `stripTaskCommand` also strips `/claude` and `/agy`.
   - `buildTaskInstruction` adds `Pass engine exactly as "<x>".`
   - The repo-button path recovers the engine from `reply_to_message.text`'s command.
   - The force-reply prompt (`repo-picker.ts` `buildRepoPrompt`) gets an `Engine:` line, parsed back like `Repo:`.
4. Register `/claude`, `/agy` and `/engine` in `src/gateway/telegram.ts` (next to `bot.command("task", …)`), `src/gateway/command-menu.ts` (engineering group) and `OWNER_ONLY_COMMANDS` in `src/gateway/chat-access.ts`. `command-menu.test.ts` fails on a menu entry that has no handler.
5. Keep telegram.ts under 400 lines (it is at 370): put the handlers in task-command.ts or a new file.

Bash (VPS daemons):
1. `deploy/lib/claude-run.sh`:
   - `claude_run` takes the same args and outputs as `agy_run` in `deploy/lib/agy-run.sh`.
   - It runs as `antigravity`. The token comes from line 1 of `${AGENT_DISPATCH_CLAUDE_TOKEN_FILE:-$HOME/.claude/claude-code.token}`, goes in on stdin, and is exported as `CLAUDE_CODE_OAUTH_TOKEN`. It never goes in argv.
   - Command: `timeout T claude -p "$(cat prompt)" --model "${AGENT_DISPATCH_CLAUDE_MODEL:-sonnet}" --dangerously-skip-permissions --output-format stream-json --verbose`.
   - jq renderer: an assistant `tool_use` and `text` give the live Telegram progress; a user `tool_result` closes the step.
   - Text view: a result with `is_error:true` gives `Error: <result>`. A `rate_limit_event` with `status:"rejected"` gives `Error: usage limit reached · resetsAt=<epoch>`.
2. `deploy/lib/agy-failure.sh`: add quota patterns `hit your .*limit` and `usage limit reached`. The auth patterns already match `Not logged in`.
3. `deploy/lib/engine.sh`:
   - Functions: `engine_of_issue` (from the labels, otherwise the default file, otherwise `agy`), `engine_name`, `engine_run` (a case on the engine; one function per CLI), and `engine_blocked`.
   - Claude gets its own block file, `agent-dispatch.claude-blocked` (`epoch\nreason`). On quota, block until `resetsAt`. On auth, block until the token file's mtime changes, put the issue back to `agent:ready`, and send ONE message. Do NOT enter the global `down` pause; agy keeps working.
   - agy keeps `agent-dispatch.quota-until` and the global auth pause unchanged.
4. `deploy/agent-dispatch`:
   - Load engine.sh and claude-run.sh in the lib loop (around line 201).
   - In `run_tick`, move the repo-level `quota_exhausted` skip into the per-candidate loop and Pass B, per engine.
   - `claim_and_implement` and `redispatch_unresolved_reviews` call `engine_run`.
   - Put the engine name in Telegram labels and outcomes.
   - After the PR lands, add the `engine:<x>` label via `gh api repos/R/issues/N/labels -f 'labels[]=engine:x'`. `gh pr edit --add-label` fails when the label is missing.
5. `deploy/vps-daemons/pr-brain`: for a PR labelled `engine:claude`, drop the `claude-*` candidates in `select_review_model`, so Gemini reviews Claude's work. Reviewer-engine switching is a later step.
6. Create the labels `engine:agy` and `engine:claude` on the 4 repos in `DEFAULT_REPOS`, and add them to the label list in `onboard-repo.sh`.

Tests (failing first):
1. `tests/unit/scripts/dispatch-sandbox.ts` needs a fake `claude` stub that records calls like the agy stub does.
2. New `agent-dispatch-engine.test.ts`:
   - a `engine:claude` issue runs claude, not agy;
   - the claude weekly-limit stream blocks claude only, and agy issues still run;
   - claude not-logged-in gives no global pause, the issue goes back to ready, and one message is sent;
   - with no label, the default file is used.
   The stream fixtures are below. The bash tests need GNU date, so run them in CI or on the VPS.
3. TS: parse `/claude x`, `/agy x`, `/engine`; the dispatch tool labels `engine:<x>`; the card names the engine.

## Real Claude CLI streams (captured live on the VPS, 0 tokens)

- Weekly limit (exit 0!): a `rate_limit_event` with `rate_limit_info.status:"rejected"`, `resetsAt:1791180000` and `rateLimitType:"seven_day"`, then `{"type":"result","is_error":true,"result":"You've hit your weekly limit · resets Oct 5, 6am (UTC)","api_error_status":429}`.
- Not logged in (exit 1): `{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}`.
- Success: `assistant.message.content[]` holds `tool_use{id,name,input}` and `text` items; `user.message.content[]` holds `tool_result{tool_use_id}` items.

## VPS facts

- The founderos user's Claude has hit its weekly limit until Oct 5 06:00 UTC. The `antigravity` user is not logged in. The executor needs its own token: the founder runs `claude setup-token` and puts the token on line 1 of `~/.claude/claude-code.token` (founderos user, mode 600).
- Codex and Gemini CLIs are not installed. Adding one means adding one `engine_run` case plus a `<cli>_run` lib.
- Check before the e2e run: Oplify repos may lack `docs/antigravity/ISSUE-DRIVEN-CONTRACT.md`, and the executor prompt tells the agent to read it.

## Remaining after the build

1. `pnpm gate`, then a draft PR to `beta` with evidence.
2. Promote: `chore/promote-<slug>` = `origin/main` + merge `origin/beta`, then merge on green CI. Watch the deploy, and confirm `~/bin/agent-dispatch` and `~/bin/lib/*.sh` changed on the VPS.
3. E2E through Telegram (MTProto, `scripts/telegram-probe.ts`): `/agy` with a real low-risk Oplify task, through card approve → issue → claim → PR → pr-brain verdict. `/claude` should give the classified block message until the token exists.
4. PR #803 (dispatch-loop-health): a subagent was fixing 4 blockers (no-CI counted as green, conflicting PRs, comment-list failure, pagination). Re-review its diff and tests, then merge. That merge closes #801.

## Done in the designing session

- #802 merged to beta (`abce46ee`). #791 closed (superseded by #794). #793 merged.
- Outcome C (job alerts to the family group) verified from DB heartbeats and sweep logs: 09:03 and 10:33 UTC on 10-03. NOT VERIFIED: that the messages visibly landed in the group.
