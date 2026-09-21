# 2026-09-21 — Oplify onboarding: safety fixes to pr-brain and agent-dispatch

## What we did

Audited the multi-repo Oplify dispatch pipeline (`aa908cdc`, `2f038e66`, `999df835`, `8793f0ee`)
before the founder starts driving `OplifyMessage/oplify-messaging-{api,app}` from his phone. Found
that both `deploy/vps-daemons/pr-brain` and `deploy/agent-dispatch` had drifted from git: the live
`~/bin/pr-brain` on the VPS carried an `allowed_orgs` Oplify-discovery change and a "necessity
reasoning gate" prompt addition that existed in **no git branch at all** — hand-deployed, never
committed. Reconciled the live files into the repo before fixing them, rather than fixing the stale
tracked copies and re-introducing a regression on next deploy.

## What we fixed

1. **pr-brain never merges an employer/org repo.** `2f038e66` deleted the original main/master
   merge guard while leaving the comment above it claiming it still ran. Restored the guard, and
   extended it: `repo_owner` (read from `git remote get-url origin`, same technique
   `discover_repos()` already used) gates the merge step — `OplifyMessage` repos are always marked
   ready via `gh pr ready` and never merged, regardless of base branch or verdict. Everyone else
   keeps the original main/master skip plus the beta→main auto-promotion added since.
2. **Fixed `gh pr create --json`** in the same merge block — that flag does not exist on this `gh`
   version; the promotion PR's number was never resolved, `|| true` swallowed the failure silently,
   and beta→main auto-promotion never actually fired. Now captures the printed URL and resolves the
   number via `gh pr view <url>`.
3. **Telegram bot now checks the sender.** `src/gateway/telegram.ts` had no sender allowlist at all
   — any Telegram user who found the bot could trip the "engineering" intent and approve their own
   HITL card. Added a `bot.use` middleware gating on `ctx.chat.id === TELEGRAM_CHAT_ID` (the same
   value `sendToChat` already targets), dropped silently and logged for anyone else.
4. **Fixed the wrong-repo dispatch claim.** `pick_ready_issue()` returns `$FORCE_ISSUE` regardless
   of which `$REPO` is active in the per-repo loop, and `kickDispatchTick` (fired immediately after
   `issues.create`) passed only `--issue N`, no repo — so a freshly filed Oplify issue could get
   "claimed" against a same-numbered FounderOS issue on whichever repo the loop reached first.
   `kickDispatchTick` now requires a `repo` argument and passes `--repo owner/name`; the bash loop
   skips any repo that doesn't match when both `--issue` and `--repo` are given (no `--repo` = old
   behavior, unchanged, for manual invocations).
5. **Restored the `agy` model/key.** `2f038e66` reverted `ceefde77`+`955b09bf` without saying so —
   removed `--model`, removed the `GEMINI_API_KEY` export, leaving bare `agy` on the
   quota-exhausted OAuth default. Restored both: `AGY_MODEL` (default `gemini-3.6-flash-medium`,
   confirmed live-valid via `agy models` on the VPS, not assumed from the reverted commit) and
   `GEMINI_API_KEY` read from `$ENV_FILE` the same targeted-grep way `TELEGRAM_BOT_TOKEN` already
   is, passed into the sudo boundary as a positional arg (never interpolated) matching
   `as_antigravity`'s existing injection-safety discipline.
6. **Deleted `deploy/vps-daemons/agent-dispatch`** — a second, stale copy (530 lines, single-repo
   only, predates all Oplify work) that `deploy/vps-daemons/README.md` documented as canonical while
   the actually-live file was `deploy/agent-dispatch` at repo root the whole time. Fixed the README.
7. **Fixed a dead instruction** in `src/tools/create-project-repo.ts` — it told the founder to add a
   new repo to `AGENT_DISPATCH_REPOS` in the crontab; the variable the script actually reads is
   `ISSUE_REPOS`. Following the old instruction did nothing.

## Why

The founder is a direct collaborator (not an org member) on two private, unprotected-`main`
OplifyMessage repos. The VPS dispatcher authenticates as his personal GitHub account. Before this
fix, a `CLEARED` verdict on an Oplify PR would have squash-merged straight into a company's
production `main` with no human step — indistinguishable from the founder doing it himself, and
with no branch protection to catch it. Decision (confirmed with the founder): founderOS produces
tested branches and opens PRs like an employee would; a human always merges into Oplify.

## Metrics

`pnpm gate` — 0 exit code, 399 test files, 4,442 tests, all green. Two runs, both clean (one before
the `create-project-repo.ts` string fix, one after). `repo_owner` extraction verified against real
remote URL shapes (https/ssh, both orgs) and against all three live VPS review checkouts.
`gemini-3.6-flash-medium` confirmed present in live `agy models` output, not assumed from memory.

## Outstanding

Deferred to a later session, deliberately not touched here (see the plan's Phase 2):
- Oplify starvation — `MAX_CLAIMS` is a single global counter checked once per tick before the
  per-repo loop; a FounderOS `agent:ready` issue consumes the tick before Oplify is reached.
- The base-branch regression — `claim_and_implement` still branches from `origin/main` even when
  `target_branch` correctly detects `beta`, so a fresh founderOS PR is born behind its own base.
- No automated manual/QA testing in the loop for any repo, Oplify included.
- The turicks-brain `project`-scoping design (same table, enforced filter) — designed this session,
  not yet implemented.
