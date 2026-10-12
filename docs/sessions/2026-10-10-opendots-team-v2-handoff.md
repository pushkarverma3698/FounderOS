# 2026-10-10 — OpenDots team v2: handoff (silent cut-offs, phone token)

Brief for a fresh session. The session that wrote it compacted 4 times (the rule is stop after 2). Plan approved
by the founder 10-10 ~14:25Z. Branch `claude/chore-opendots-migration`, draft PR #1120 → `beta`. Read this file
and `deploy/opendots/README.md`; nothing else is needed.

## What we did
- Engineering team live on the sandbox `pushkarverma3698/opendots-sandbox`: Architect, Builder, Reviewer each work
  one item per 15-min OpenDots shift and hand over through GitHub labels; the Chief of Staff files issues and
  merges `agent:approved` PRs the founder names in chat.
- Committed what was already deployed: `opendots-turicks.patch` (replaces `opendots-turn-limits.patch`),
  `install.sh`, `setup-dots.sh` (Chief merges, `run-bg` LONG WORK rule, logins never overwritten on rerun).
  `/opt/opendots/deploy` on the VPS was byte-identical to this branch at 14:25Z (sha256 compared).
- Process proven once end to end: issue #8 → PR #9 → Reviewer approved → founder named it → Chief merged → #8 closed.

## What we found (checked in source `625452e` and live)
- **"Hallucination" = cut-off replies reported as done.** `src/server/dot-agent.ts:356` caps every model reply at
  `max_completion_tokens: 2200`. When a reply hits it inside a tool call, TanStack logs the argument JSON parse
  failure, sends the tool `{}` (`node_modules/@tanstack/openai-base/dist/esm/adapters/chat-completions-text.js`
  ~667-707), and the agent loop continues only on `tool_calls` (`node_modules/@tanstack/ai/dist/esm/activities/chat/index.js`
  ~1038, 1079), so the run ends "completed". Live: Builder shifts 13:40Z and 13:56Z stopped at "Fixing the probe
  path:" and "…and run the tests."; a 13:42Z probe wrote 200 of 1,200 lines and blamed an invented "command limit"
  (exec allows 8,000 chars; the command was ~5,300).
- **Different models:** OpenDots calls only `OPENAI_MODEL` (jev-router on OpenRouter); the router picks a model and
  reasoning effort per request. `~typesafe/jev-latest` has 0 endpoints, so it can't be pinned. Some picks need
  OpenRouter's 18+ confirmation: Builder shifts at 13:28Z, 13:38Z and 14:11Z failed with that 403.
- **Phone:** the Pixel was off the tailnet ~6 h (back since ~14:00Z). The web app keeps the owner token in
  `sessionStorage['opendots-token']` (`src/client/api.ts:1-6`), so each new tab session asks again; `app.ts:64-85`
  returns 401 without it. "Mobile" means the web app in a phone browser; there is no native app.
- **Native vs ours:** one overlap only (the Chief uses `gh` instead of a GitHub Connection; kept, proven on #9).
  Labels, `run-bg`, `dot-login` and the patch fill gaps OpenDots doesn't cover. Shell commands get no approval
  card (only page saves and non-read-only Connection tools, web app only, `docs/CONNECTIONS.md:15-21`).

## Founder decisions (10-10 ~14:20Z)
- A. Claude Code keeps writing the code; prompts unchanged.
- B. The web app remembers the owner token (`sessionStorage` → `localStorage`).
- C. On the phone the link loaded and asked for a token: that screen is the blocker.
- D. The founder confirms 18+ in OpenRouter themselves; jev-router stays. Don't touch OpenRouter settings or the model.

## Live state (14:25Z)
| Role | Dot | Shift task |
|---|---|---|
| Chief of Staff | `abe81ab1-e117-4798-8f09-6bf6cde37059` | none (chat) |
| Architect | `87475357-d16e-4585-8eb5-9f566209ac0b` | `76111de6-a91f-4f7f-b32d-3d25361ac1d9` |
| Builder | `4740d695-5ff7-45ea-8c70-9f9883de66e2` | `7c9e9f2f-e114-4046-9727-44e237056e98` (Shift conversation `83a237df-c6f6-408b-946c-638230b136d2`) |
| Reviewer | `22f04700-12bc-4ec3-82a4-dc90cec44849` | `cc5fc8c4-50e7-4e8e-83f2-3ed1efd42dcf` |

Sandbox: #10 `agent:building` (Builder's uncommitted work in `/workspace/repos/ws-truncate`, branch `feat/truncate`,
no PR yet). PRs #3 and #5 `agent:approved`, MERGEABLE (issues #2, #4 `agent:in-pr`). #6, #7 `agent:blocked` (founder
decides). #1, #8 closed; #9 merged.

## Steps for the fresh session
1. **Source tree** (in your scratchpad): `git clone https://github.com/CopilotKit/OpenDots.git od`,
   `git -C od checkout 625452e`, `git -C od apply <worktree>/deploy/opendots/opendots-turicks.patch`,
   `git -C od add -N tests/turicks.test.ts`, `cd od && npm ci`. Baseline: `npm run typecheck` exit 0,
   `npm test` 49 files / 306 tests passed.
2. **Loud cut-offs, test first** in `tests/turicks.test.ts`: script a reply with `finish_reason: "length"` using
   `completion(...)` from `tests/fixtures/model-stream.ts`; the run must end in `RUN_ERROR`, not `RUN_FINISHED`.
   Then raise the cap 2200 → 16000 (`dot-agent.ts:356`) and map a `length` finish to `RUN_ERROR` "The model's reply
   was cut off at the output limit.": in the subscription `next` handler (`dot-agent.ts` ~376-415, beside
   `timeLimitError()`) if `RUN_FINISHED` reaches it with `finishReason` (NOT VERIFIED that it survives
   `this.inner`), else in a TanStack middleware `onFinish` (`runOnFinish(ctx, {finishReason, …})`). With the retry
   patch, a cut-off shift then shows failed and retries one interval later.
3. **Phone token:** `src/client/api.ts` `sessionStorage` → `localStorage`. Check every `setToken` caller: lock-out
   and a wrong token must still clear it via `setToken('')`. One test.
4. **Regenerate** `git -C od diff HEAD > <worktree>/deploy/opendots/opendots-turicks.patch`; typecheck and tests green.
5. **Deploy:** `scp` the patch and README to `founderos-vps:/opt/opendots/deploy/` (owned by founderos, no sudo),
   then `ssh founderos-vps 'bash /opt/opendots/deploy/install.sh && bash /opt/opendots/deploy/setup-dots.sh'` (both
   idempotent; logins kept, tasks never duplicated). README: cap 16000 + cut-off behaviour, phone (Tailscale
   Always-on VPN, token remembered), 18+ note. Commit by explicit path, push, update the PR #1120 body
   (What changed / How it was verified / NOT VERIFIED).

## Verification (real path; output goes in the PR body)
1. Direct jev-router call with the Builder prompt and one long tool call, at 2,200 and at 16,000: record
   `finish_reason`, `usage.completion_tokens_details.reasoning_tokens` and `model`. Use `OPENAI_API_KEY`,
   `OPENAI_BASE_URL`, `OPENAI_MODEL` from `/opt/opendots/app/.env`, read inside the ssh shell, never printed.
2. #10 end to end: Builder PR → Reviewer verdict → founder names it to the Chief → Chief merges → #10 closes.
3. Founder asked for this: the Chief merges #3 and #5; #2 and #4 close with a link to the PR. (#9 went through an
   owner-API task "Merge PR 9." in a Chief conversation.)
4. Live view: during a Builder shift, a read-only Intelligence subscriber on the VPS (the `IntelligenceAgent`
   pattern in `src/server/headless.ts`, same threadId) receives events while the run is still going.
5. Next 4 shifts per role: no "completed" run ends mid-sentence; any cut-off shows as failed.

## Gotchas
- Owner API on `127.0.0.1:4310/api`, bearer `OWNER_TOKEN` from `/opt/opendots/app/.env`. Read it inside the ssh
  shell (`T=$(grep '^OWNER_TOKEN=' … | cut -d= -f2-)`); never print it, never type it into a browser.
- `GET /api/tasks/:id` lists `runs` newest first (`.runs[:N]`); `result` is a JSON string or an object
  (`if type=="string" then (try fromjson catch {text:.}) else . end`). All tasks: `GET /api/state` → `.tasks`.
- `POST /api/tasks/:id/actions {"action":"run"|"pause"}`. Kill switch: pause the three shift tasks.
- Prompts live in `setup-dots.sh` (≤ 2000 chars each; the script overwrites edits made in the app).
- Logins inside a computer are readable by any code running there (proven 10-10); the founder narrows tokens later.
- Hooks block `rm -rf` and pushes to `main`. Write/Edit want the plain `/Users/pushkarverma/Projects/...` path.

## Outstanding (founder)
1. OpenRouter → Settings → Preferences: confirm 18+.
2. Pixel: Tailscale → Always-on VPN. After step 3 deploys, paste the owner token once
   (`ssh founderos-vps 'grep ^OWNER_TOKEN= /opt/opendots/app/.env'`, moved through a password manager).
3. Decide blocked issues #6 and #7.
4. Revoke the GitHub PAT and Claude setup-tokens pasted in chat earlier; narrow the GitHub token later.
5. Second Claude account: tell that engineer "log in to claude" when switching.
