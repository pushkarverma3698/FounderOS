# Stability audit, 2026-10-03 → 2026-10-04

Scope: 73 non-merge commits, 285 files, +21k lines since 2026-10-03 (switchable CLI, NL control, turn log + recall,
jobhunt phone UX, /login, /review, /where, scheduler recurrence, model pools, pr-brain, deploy).
Rule: no new features until the P0/P1 list below is closed. Each item is a fix PR with a failing test first.

Method: prod journal (24h), CI state, local gate, three read-only code audits, then a second pass (2026-10-05) re-reading every
agent finding in the main session and auditing the leftovers. **C** = re-read in the main session at the cited lines; **A** = agent-reported,
not re-verified; **H** = hypothesis.

## Baseline
- Prod `/opt/founderos` = `26d55412` = origin/main at audit start (main has since moved to `a632bfd7`, #881). `NRestarts=0`. 30 stops in 24h are deploys (SIGTERM), not crashes.
- CI on `26d55412`: green. Local `pnpm gate`: lint/build/wiring/arch/doc-claims pass; 79 tests fail in 12 files, **all** bash-daemon
  tests (`agent-dispatch-*`, `pr-brain-*`), because macOS lacks `timeout`, `flock` and bash ≥4. They run only on CI/VPS.
  NOT VERIFIED locally.
- Prod log noise: Gmail + Calendar probe DOWN (`invalid_grant`, every boot); LangSmith export refused (intended);
  Slack MCP env unset (30×/day); `message is not modified` from kernel-progress (harmless); one worker 429 retry;
  one Postgres `CONNECT_TIMEOUT` on three scheduler sweeps.

## Needs the founder (cannot be fixed in code)
1. Gmail/Calendar `gws` token is expired: re-auth via `/login google`. Until then email/calendar answers are wrong or absent.
2. `JOBHUNT_SENDER_PROFILES` is **not set** on prod (`grep -c` = 0). Plain job commands from the wife's chat read the default
   (founder's) queue. Set it, then send one plain-English job message as her.
3. `/login agy` fails from Telegram (agy shows no sign-in link). Manual: `ssh -t founderos-vps 'sudo -u antigravity -i agy'`.

## P0 — wrong or unsafe output reaches a real person
| # | Where | Failure | Fix |
|---|---|---|---|
| 1 **C** | `src/gateway/cover-letter-delivery.ts:32,82`; caller `jobhunt-commands.ts:338` | `FOUNDER_CONTEXT` (guesthouse, studio, relocation) is passed for every profile. Wife taps 📝 Draft → letter to a real company carries the founder's biography. Also expires 2026-11-30. | Pass `row.profile_id`; context only for the founder's profile; none otherwise. |
| 2 **C** | `src/gateway/command-dispatch.ts:107-125` | `handleCommandCallback` never compares tapper to `entry.origin.from`. In the group, anyone can tap the founder's pending ✅ Run; the command replays with the founder's identity. | Reject unless `ctx.from.id === entry.origin.from.id`. |

## P1 — daily friction or silent wrongness
| # | Where | Failure | Fix |
|---|---|---|---|
| 3 **C** | `src/agents/model.ts:350-358` | Optional OpenRouter model with no key returns a client with `apiKey:"missing-openrouter-key"` instead of `null`. The worker "fail safe to primary" never fires; every worker/synth call 401s. | Return `null` when `optional` and no key. |
| 4 **C** | `src/gateway/model-fallback.ts` loop | A non-fallback error (401/400/402) on fallback N aborts the chain and throws N's error, not the primary's. | Record, continue, throw the primary's. |
| 5 **C** | `src/agents/model.ts:163` | `isQuotaExhaustedError` is unused; 402/credits-depleted does not trigger fallback. | Add to `isModelFallbackError`. |
| 6 **C** | `src/agents/worker-invoke.ts:166` | `buildFallbackModels()` without role: tailor-CV and cover-letter paths ignore `WORKER_FALLBACK_MODELS` and swallow all errors. | Pass `"worker"`; same retriable rule. |
| 7 **C** | `scripts/apply-prod-env-overrides.sh:136-148` | Worker primary + all 3 fallbacks are OpenRouter on one key. Credits out = every worker turn fails. | Last fallback is a direct `google-genai:` slug. |
| 8 **C** | `src/kernel/planner.ts:~366` | A mutating command turn is logged "Ran /task …" before the tap. Cancel/expire leaves recall and history claiming it ran. | Log "Asked to confirm /x" for non-read-only. |
| 9 **C** | `src/gateway/kernel-run.ts:148-166` | Approval hold drops new text ("send again"), unlogged; in the group a guest cannot approve, so one owner-only card blocks guests up to 2h. Unguarded `JSON.parse(callback_data)` can lock every turn. | Time-box guest holds; try/catch + expire row. |
| 10 **C** | `src/gateway/scheduled-task-run.ts:109-203` | Scheduled turns skip the pending-approval hold (the shared-checkpoint bug fixed for text turns in eef1c30d). | Same hold check, then defer. |
| 11 **C** | `src/agents/agent-tools/scheduling.ts:66` | `chat_id` hardcoded to `TELEGRAM_CHAT_ID`: wife's reminder fires in the founder's DM. | Use `config.configurable.thread_id`. |
| 12 **C** | `scheduling.ts:66` + `insertScheduledTask` | Idempotency key + ON CONFLICT DO NOTHING: re-creating a cancelled repeating task returns the dead row, replies "✅ set", schedules nothing. | Treat non-`scheduled` existing row as a miss. |
| 13 ~~C~~ | PR #880 | **Fixed:** #880 merged to beta 2026-10-04 17:41Z and promoted by #881 (main `a632bfd7`): timing is refused before the card. Prod deploy of `a632bfd7` NOT VERIFIED in this pass. | Re-check the card text once live. |
| 14 **C** | `src/db/conversation-turns-schema.ts`, `recall-conversation.ts renderTurn` | No sender column: in the group every message recalls as "You:". | Add `from_id`; render the name. |
| 15 **C** | `src/gateway/jobhunt-callbacks.ts` | Draft button: no try/catch (silent "Tailoring…"), no stage check (re-drafts applied rows), no in-flight guard (double tap = two 20-40s drafts blocking all updates). | try/catch + reason; early return if applied; in-flight set. |
| 16 **C** | `src/gateway/jobhunt-gaps-view.ts:53` | `/gaps ai` refused with ≥2 profiles (`ai` read as an unknown profile). | Pass reserved words / validity check. |
| 17 **C** | `jobhunt-compact.ts` | Buttons `📝 Draft — <company>` identical for several roles at one company. | `Draft 2 — Company`. |
| 18 **C** | compact card vs Show more | Card counts `do_today` unscoped; Show more re-renders a 24h slice; `/jobs`, `/today`, card disagree on "N ready". | One row set for both. |
| 20 **C** | `src/infra/boot-notice.ts:23` | Identical restart card suppressed 6h: a crash loop on one build is silent. | Bypass at ≥3 boots/30 min. |
| 21 **C** | `deploy/agent-dispatch` lock (~455-470) | Lock dir has no PID check: after SIGKILL/reboot /task silently stalls up to 90 min; a long tick (H) lets two writers share the workspace. | PID in lock, `kill -0`, notify on reclaim, trap removes only own lock. |
| 22 **C** | `src/kernel/lessons.ts sameObjective` | Exact-text objective match: lessons almost never apply (the leak fix made it effectively off). | Match worker + normalised intent. |
| 23 **C** | `src/db/conversation-turns.ts findConversationTurns` | Recall matches `reply`, so it finds its own earlier answers; "what did I just ask" returns up to 5 turns. | Match `user_input`; exclude recall turns; limit 1 for "just now". |
| 24 **C** | `recall-conversation.ts:169,171` | Regexes accept only `minute` or `hour` (plural optional): "20 mins ago", "2 hrs ago", "half an hour ago" refuse. ("this afternoon" works via the part-of-day rule.) | Accept `mins?`/`hrs?`/"half an hour". |
| 25 **C** | `src/db/keyword-search.ts tokenizeQuery` | Splits on `[^a-z0-9]+`; Devanagari/accented queries find nothing. | `\p{L}\p{N}` with `u` flag. |
| 26 **C** | `command-catalog.ts:21` (`halt` not in `READ_ONLY_COMMANDS`) | "stop everything" needs an extra tap. | `halt` read-only for plain words; card only for `resume`. |
| 27 H | `src/infra/hitl.ts:150-153` | Second gated call in one turn may expire the first live approval. | Check reachability, then key by tool-call id. |

## P2 — polish and hygiene
- Was P1 #19 (**C**, downgraded): `tasks-ready.ts:24-38` accepts any `brain-reviewed:` marker and pr-brain (`deploy/vps-daemons/pr-brain:787-792`) posts it after FAIL too, but `tasks-ready.ts:113` skips drafts and a FAIL turns the PR back to draft, so a failed PR shows as "ready" only if `gh pr ready --undo` itself fails. Forging needs repo write access. Fix: PASS-specific marker.
- Turn log: no retention; migration `0043` comment says "no emails" but replies can embed tool text; written lazily so the newest turn is invisible until the next message; held/halted/budget-blocked turns never logged. (A)
- `getPendingInterrupt` has no `ORDER BY` with `limit 1`. (A)
- `search_memory` episodic/knowledge types readable by group guests; turn recall is correctly thread-scoped. (A, known design limit)
- Wife sees "Tashi's queue" instead of "your queue" (`jobhunt-view.ts:268`). `jh:` Show more / CSV taps not owner-gated. `markRowApplied` read-then-write not atomic. `/login` swallows any digit-bearing single token ("2pm", "v2") for 10 min. Company names with `"` lose their Draft button. CSV filename date is UTC (off by a day 00:00–05:30 IST); CSV guard misses `\t` `\r`. Zero-applied progress line hides the stale-roles nag. (A)
- Shell: remaining `| grep -q` / `| head` under `pipefail` in `deploy/deploy.sh:74,166`, `deploy/agent-dispatch:526,588,682`, `deploy/sync-daemons.sh:142`, `deploy/onboard-repo.sh:101`, `deploy/vps-daemons/pr-brain:383`, `scripts/vps-*.sh`. #870/#871 fix only two sites; merge and sweep the rest. (`merge-tree` shows #870/#871 keep the `*.effective` writes.) (A)
- `deploy/deploy.sh:113` DB password via sed + `ALTER USER … '%s'` breaks on a quote or missing `:pw@`. `claude-run.sh` `timeout` without `-k`. `engine.sh record_claude_block` non-atomic write. `quota_reset_epoch` (agy) uncapped. `slugify` empty → `task/issue-N-`. Redispatch checkout failure never counts an attempt. (A)
- Freeze gate: `crash-fix`/`unfreeze` label has no actor check; a PR author can label their own PR. `apply-prod-env-overrides.sh` key sanitiser truncates silently. Planner pool slug `typesafe/jev-router` benchmarked at n=1. Watchdog + `StartLimitBurst` can leave a wedged unit un-restarted (H). `deploy.sh:51-55` bakes `WEB_GATEWAY_TOKEN` into a bundle the log says no longer exists (H). (A)
- `src/gateway/kernel-run.ts` is 398 lines and `recall-conversation.ts` 396: split a function out before fixes 9, 23, 24 or `verify:arch` fails.
- No dedicated tests found for `jobhunt-callbacks` and `boot-notice` (file listing only). NOT VERIFIED beyond that.

## Leftovers audit (2026-10-05)
The areas the first pass skipped: knowledge/context, ops commands, pipeline + open PRs. All three were audited read-only (no paid
calls, no ssh writes). The ops agent also ran 11 related unit files: 132 passed, 1 skipped.

### Knowledge and context
| # | Where | Failure | Fix |
|---|---|---|---|
| L1 **C** | `planner.ts:237` + `task-command.ts:169 buildTaskInstruction` | A `/task` turn is logged as the generated wrapper ("Dispatch this engineering task… verbatim: …"), not the founder's words. Recall returns boilerplate; searching "repository" matches every `/task`. | Carry the typed text in `configurable`; log that. |
| L2 **C** | `commands.ts:49-55 handleReset` | Turns are written lazily (next turn). `/reset` clears checkpoints first, so the last turn before a reset is never in the turn log. | Flush the previous turn, then clear. |
| L3 **C** | `dispatch-antigravity.ts:130-144 resolveDispatchRepo` | Plain-English coding request with no repo silently targets `ISSUE_REPO`/default. Only `/task` has the picker. The card names the repo, so one careful read catches it. | With >1 dispatchable repo and no `repo`, refuse "which repo?" before the gate. |
| L4 **C** | `scripts/sync-turicks-brain.ts:593` vs `queries.ts:970-1015` | `**Status:** Superseded` is written only to `brain_memories`. `knowledge_entries` (read by `search_memory` knowledge/all) has no status, so a superseded plan is still served as current. | In the sync, set `is_current=false` when status ≠ ACTIVE. |

P2 (A):
- `founder_request` is called "verbatim" but nothing checks it against the real message.
- The founder's quote fills both Problem and Evidence.
- `background-jobs.ts` hard-codes all 14 routines as `on`, so "Everything is running" proves nothing.
- `tryRead` puts the raw `err.message` in `attention`, which leaks the server's home path.
- `merge=` is parsed as `!== "0"`, so `false` reads as merging.
- A schedule text with a qualifier ("Superseded (section 3 only)") hides the whole doc.
- The planner's invented verification commands are never checked.
- `docs/plans/2026-10-04-nl-control-and-knowledge-audit.md` is stale and has no Status line. Mark it superseded by `docs/sessions/2026-10-04-memory-review-self-knowledge-recency.md`.

Checked correct (A):
- ILIKE is escaped (`likePattern`, bound parameter).
- Turn recall and `search_memory` are scoped by `thread_id` from config.
- The superseded filter on `brain_memories` covers both the vector and keyword legs.
- Recency weighting is applied before the top-K cut.
- The forced engine lives in per-invoke `configurable` and is restored on HITL resume.

### Ops commands (/login, /review, /where)
| # | Where | Failure | Fix |
|---|---|---|---|
| L5 **C** (likelihood H) | `login/command.ts:137` `looksLikePaste` | While a login is pending, a paste containing whitespace (wrapped token, URL with a stray space) is not consumed: it reaches the LLM, is stored in `conversation_turns`, and stays in the chat. | While pending, also consume anything containing `sk-ant-`, `code=` or `http://localhost`; delete and refuse. |
| L6 **C** | `review-command.ts:90-93` | `/review` says ON when pr-brain is paused (`pr-brain.down`, auth/usage). That is exactly when he asks. | Read `.down` (reader exists in `daemon-settings.ts`); print "ON, paused (reason) since X". |
| L7 **C** | `telegram.ts:340` `bot.start()` (no runner) | Updates run one at a time. `/login claude` finish can take ~165s; `/halt` and every message wait behind it. | Reply "working…", run finish detached. |
| L8 A | `login/command.ts:151` | Failed `deleteMessage` is silent: credential stays in chat, reply doesn't say so. | Append "delete your message yourself". |
| L9 A | `infra/claude-token.ts:78-79` | Two token files not written as a pair; second write fails → pr-brain and dispatch on different tokens while the reply says "Nothing was changed". | Write in order, roll back on failure. |
| L10 A | `login/adapters/google.ts:113-124` | Google finish never checks which account signed in: `/login google personal` approved with the work account silently swaps mailboxes. | Expected email per account; reject mismatch and restore. |
| L11 A | `claude.ts:337`, `agy.ts:226` | A refused paste kills the child, but the comment and flow promise the attempt stays open; the retry gets "attempt has ended". | Don't kill on a refused code, or drop the attempt and say "send /login again". |

P2 (A):
- `.before-login` and agy `.bak` backups keep old refresh tokens forever.
- agy `restore()` can bring back a stale `.bak`.
- `~/.claude.json` read-modify-write has no lock (H).
- An expired attempt's child process and its `/tmp` scratch HOME, which holds a live refresh token, stay until the next message.
- `/where` counts promotion PRs under Done, and Left includes items already shown as in flight and blocked. Journey B passes either way.
- `/where` caps at 100 open PRs, and one check-runs error makes the whole repo "unreachable".
- The `/login` status screen spends a real `claude -p` call.
- None of the cases above has a test.

Checked correct (A):
- `/login`, `/review` and `/where` are owner-only.
- No secret appears in argv or logs.
- Files are written at mode 600 via a temp file and rename.
- A token is verified before anything is written.
- Step 2 checks the org match.
- Google OAuth uses PKCE and checks `state`.
- `/review off|on` reads the file back before confirming.
- `/review` models now come from `*.effective` files, so the `NoNewPrivileges` crontab bug from the 10-04 audit is fixed in code (`review-command.ts:15-16`).

### Pipeline and open PRs
| # | Where | Failure | Fix |
|---|---|---|---|
| L12 **C** | `deploy/vps-daemons/pr-brain:1229` (head read once), `:983` | Stale head: the author pushes during the review (up to 30 min). Ready/undo and the merge act on the new head; `gh pr merge --squash` has no `--match-head-commit`. Branch protection still requires CI, but nobody reviewed the pushed commit. | Re-read `headRefOid` after `agy_run`; abort on change; add `--match-head-commit "$head"`. |
| L13 A | `pr-brain:679-686` | Workspace checks out `refs/pull/N/head` as it is now, not `$head`: the reviewer can read commit B while the marker stamps A. | Assert `rev-parse` equals `$head` after fetch. |
| L14 **C** | `scripts/verify-pr-scope.ts:50` | Freeze check exempts `chore/promote-*` / `chore/sync-*` by head-branch name only: any PR on such a branch skips Moves and frozen-path rules. | For those prefixes require the bot author or a merge-only diff. |
| L15 A | `scripts/journey-*.ts notifyFounder` | Returns silently if `TELEGRAM_BOT_TOKEN`/`CHAT_ID` is missing and never checks `res.ok`: a red journey can reach nobody. | Throw/log on missing env or non-ok. |
| L16 H | journeys A/B/C scheduling | No cron line in the repo (`sync-daemons.sh` installs none) and no heartbeat. If the VPS cron entry is absent, nothing runs and nothing alerts. VPS crontab not checked. | Heartbeat file + 26h staleness alert in the daily check. |
| L17 A | PR #861 (`tg-quiet.sh`) | Every `notify` is held 23:00–08:00 IST, including `down-state.sh` pause/outage, "Gate FAILED" and merge FAILED. Digest keeps only line 1 (drops verdict + URL). `curl -s` without `-f` deletes the queue on a 4xx/429. | 🛑/⚠️ bypass quiet hours; keep 3 lines + URL; `curl -sf`, delete queue after last chunk. |

P2 (A):
- Journey A goes green once the checks it has seen so far finish, so a slow check created later is missed.
- Journey C goes green on any bot post in 26h, an error message included.
- The freeze gate's `Moves:` parse rejects `- Moves:` and `**Moves:**`.
- The `retired-model` warn-once marker is never cleared.
- #861 needs a guard for a bad `TG_QUIET_HOURS` value; as written, `10#abc` kills the daemon.
- #861 needs a check for missing tzdata (H).

Freeze gate and fixes:
- A fix in `src/gateway`, `src/kernel`, `src/agents`, `deploy/` or `scripts/` needs only `Moves: A|B|C|D|crash-fix` in the PR body. #870, #871 and #880 passed that way.
- A fix touching `src/tools/jobhunt/`, `src/mcp/`, `src/proof/` or `src/evolution/` needs the founder's `crash-fix` or `unfreeze` label. In this list that is P0 #1 if it touches `src/tools/jobhunt/`, and #17/#18.

Checked correct (A):
- pr-brain's daily ceiling, carry-forward and marker-on-start-head.
- Retired model falls through to the next one.
- `ci-state.sh` reads `--required` only.
- Merge guards.
- Journeys DM on red and on a thrown error.
- `git merge-tree` of #861, #870 and #871 against beta shows no conflicts and keeps `write_effective`. This resolves the earlier hypothesis that they delete it.

| PR | State (2026-10-05) | Verdict |
|---|---|---|
| #861 quiet hours | Green, 54 behind beta | **Changes needed:** L17 (urgent bypass, digest detail, curl -f), then update-branch and merge. |
| #870 onboard-repo `has_line` | Green, mergeable, 39 behind | Update-branch, merge. |
| #871 deploy.sh pipefail | Green, mergeable, 39 behind | Update-branch, merge. Then sweep the remaining pipefail sites (P2). |
| #879 sync beta←main | Clean, 0 files | Merge with a merge commit (not squash). |
| #880 schedule validation | Merged + promoted (#881) | Done. |

## Carried over from the 10-04 audits
- **Fixed since:** UX P0-1, P0-3 and P0-4 (#833, #834); P0-5 labels (`brief-sections.ts` splits NOT LAWFUL); P1-3, P1-4 and P1-5 (33be4eb2, a9634c72, bea985af); P1-7 one-liners (a guessed path is filed as an unverified hint, `antigravity.ts:167`); P2-1 and P2-2 (d59da344, 7898efdb); P2-5 self-knowledge (addbc62e); `/review` crontab (380ac282).
- **Still open:**
  - P0-2: stable job ids. Positions still go stale on old alerts.
  - P1-1: quiet hours, which is PR #861.
  - P1-2: alert batching. Only the sheet line was removed (#850).
  - P1-6: partly open. `repo:` and the picker exist. Re-dispatch dedupe exists only in follow-ups (`antigravity-followup.ts:120`). The dispatch idempotency key (`antigravity.ts:81`) is title+scope, so a reworded request files again.
  - P2-3, P2-4, P2-6 and P2-8 have no commits.
  - P2-7 (no false promises) has no synthesizer guard.
  - From the agent-setup audit: the PR lookup fallback, a post-merge check, and goal → several issues.
- **Live checks still NOT VERIFIED:** `/review off` then `/review on` from Telegram; a recurring task row firing on its second occurrence; `/login claude` step 2 end to end (needs the founder's two taps).

## Founder-requested work (2026-10-05)

### T1. Login and logout for every account: verify end to end
Done means each row below is run once from Telegram, with the evidence kept: the reply, plus a real read through that account afterwards.

| Account | Sign in today | Sign out today | Must prove |
|---|---|---|---|
| Google built-ins (`src/core/accounts.ts`) | `/login google <acct>` (PKCE) | **none** | Signed-in email matches the target (L10). Gmail and Calendar read through the bot. A revoked refresh token shows as DOWN, not "ok". |
| Google added accounts | `/login google add <name>` | `/login google remove <name>` | Remove deletes the credential, and the next read says "not signed in". |
| Claude token (`pr-brain.token`, `claude-code.token`) | `/login claude` | **none** | Both files hold the same token (L9). The executor and pr-brain each make one real call. The status screen costs nothing (ops P2). |
| Claude host login (`~/.claude.json` / `.credentials.json`, step 2) | `/login claude` step 2 | **none** | The org matches the token. Old backups are cleaned up (ops P2). |
| agy (`antigravity` user) | `/login agy` (broken: no link) | **none** | A link appears. `agy models` passes after install. A stale `.bak` is never restored (L-ops P2). |
| GitHub `gh` (`antigravity` and `founderos`) | ssh only | ssh only | `/login` shows it at least read-only, so an expired gh token is visible before a dispatch fails. |
| Telegram MTProto session (journeys B/C, `qa:telegram`) | script only | n/a | An expired session turns a journey red with a DM, not a silent cron error. |

Missing behavior to build in the same PR series:
- A `/login <tool> logout` for Claude, agy and the built-in Google accounts. It deletes the credential, keeps no backup, and confirms with a real failed call.
- Paste safety (L5).
- Delete-failure notice (L8).
- A refused paste keeps the attempt open (L11).
- Tests for every row above.

### T2. Natural language on par with Claude Code
Target: any slash command or tool can be reached by plain words. A request that needs several steps is planned and run as one mission, with one approval where something writes. Nothing makes him know the command name.
1. **Coverage matrix:** every command in `COMMAND_MENU` and every agent tool, with one or more plain-English phrasings, in `src/eval/command-golden.ts` and run by CI's offline golden set. Today the golden set covers a subset. List the gaps, then close them.
2. **Multi-step orchestration:** golden tasks that need 2–3 tools in one turn. Examples: "check my open PRs and remind me at 6 to merge the green ones", and "draft Tashi's top job and tell me the gaps". Assert the plan, the receipts and a single card.
3. **Clarify, don't guess:** a missing repo (L3), profile or time leads to one question with buttons, never a silent default.
4. **Context:** L1, L2, #14, #23–#25 and L4. Recall must quote what he actually typed.
5. **Friction:** #26 ("stop everything" needs no tap), stable job ids (UX P0-2), empty states with an example (UX P2-3), and one-line model errors (UX P2-6).
6. **Proof:** one `pnpm qa:telegram` run after the series lands. The pass bar: 22/22 tasks answered without a slash command.

### T3. Coding pipeline ships production-ready PRs
Setup audit, 2026-10-05 (read-only on `founderos-vps`, **C**):

| # | Finding | Fix |
|---|---|---|
| S1 | **Automatic review is OFF.** `~/.claude/pr-brain.off` was "switched off from Telegram /review at 2026-10-04T18:32Z". Every sweep since logs "kill switch present — nothing dispatched", so agent PRs currently get no gate. | Founder: `/review on` if the off was not deliberate. Code: `/review` and `/where` show "review OFF since X" (pairs with L6). |
| S2 | The Claude executor runs as `antigravity` with no `~/.claude/CLAUDE.md`. agy gets the shared rules through `~/.gemini/GEMINI.md → /opt/agent-rules/AGENTS.md`, but Claude gets only the repo's own CLAUDE.md. The two engines follow different rules. | Symlink `/home/antigravity/.claude/CLAUDE.md → /opt/agent-rules/AGENTS.md` in `deploy/sync-daemons.sh` (or a CLAUDE.vps.md import). |
| S3 | Executor skills differ. agy has `production-ready`, `systematic-debugging` and `karpathy-guidelines`; Claude-as-antigravity has only `production-ready`. | Sync the same set from `/opt/agent-rules/skills` for both engines. |
| S4 | Both engines run with `--dangerously-skip-permissions`. The `deny` list blocks the `Read` tool, but nothing blocks `Bash(cat …)`. `.env` is 600 to `founderos`, so the executor cannot read it today (checked). The real exposure is the founder's `gh` login (`pushkarverma3698`, full scope) in `/home/antigravity/.config/gh`. "Agents never merge or approve" is enforced only by the prompt and branch protection. | A fine-grained token or GitHub App for the executor (PR create + push to `task/*` only), and a `deny` for `Bash(gh pr merge*)`, `Bash(gh pr review*)` and `Bash(gh api*merge*)`. |
| S5 | Models in use: executor `gemini-3.6-flash-medium` (agy) / `sonnet` (Claude); reviewers `claude-sonnet-5-5-medium` then `gemini-3.1-pro-high`; `PR_BRAIN_MERGE=0`. CLI versions: agy 1.2.16, claude 2.1.287. The flash executor is the A/B noted 10-04, and no result is recorded. | Record the A/B outcome (PR pass rate per executor) before keeping flash. |
| S6 | Journey crons exist (A every 3 days, B/C nightly), so the L16 "no cron" hypothesis is wrong. There is still no heartbeat. Journey B logged GREEN and then an unhandled gramJS `TIMEOUT` in the same run. | Disconnect the MTProto client before exit; add the heartbeat (L16). |
| S7 | Rules are in sync: `/opt/agent-rules/AGENTS.md` md5 equals the laptop's `~/.agents/AGENTS.md`. | — |

Quality work, in order:
- Pipeline fixes:
  - L12 (stale-head merge) and L13 (reviewed commit ≠ stamped commit).
  - #21 (dispatch lock).
  - L14 (freeze exemption by branch name).
  - L15 (journey alert can reach nobody).
  - #20 (crash loop silent).
- UX P1-6 dispatch dedupe by issue, not by title.
- From the agent-setup audit: the PR lookup fallback, a post-merge check (deploy moved + smoke test), and goal → several issues.
- A PR is "production-ready" only when:
  - CI is green on the head that was reviewed;
  - the body has What changed / How verified / NOT VERIFIED;
  - a reviewer of a different model family passed that exact head;
  - for a bug fix, the failing test is in the diff.
  pr-brain must check all four mechanically before stamping, not by prompt.

## Not audited
Video factory, web gateway, MCP server, eval harness, Oplify repos. Out of scope for "daily friction" unless a fix touches them.

## Proposed order (each its own PR, failing test first)
1. **Safety:** P0 #1 and #2, plus L5 (credential paste reaching the kernel) and L12 (stale-head merge). Small changes that close the real-harm paths.
2. **Model chain:** #3–#7. One OpenRouter outage would make every worker turn fail.
3. **Open PRs:** update-branch and merge #870, #871 and #879. Send #861 back for L17.
4. **Scheduling and approvals:** #11, #12, #10, then #8, #9, #27, #26. Split `kernel-run.ts` (398 lines) first.
5. **Context:** L1, L2, #14, #23, #24, #25, L4. Split `recall-conversation.ts` (396 lines) first.
6. **Jobhunt and ops friction:** #15–#18, L6, L7, L10, L11, then pipeline items #21, #20, L14, L15, L16 and the shell sweep.
