# Agent setup and coding-pipeline audit — 2026-10-04

**Scope:** the Claude Code and Antigravity setup (laptop and VPS), the kernel worker prompts, and the issue → PR coding
pipeline. **Status:** findings plus recommendations. The dispatcher slug fix ships separately (branch
`fix/dispatch-branch-trailing-hyphen`). The prompt fixes are handed to Antigravity in
[AG-022](../antigravity/AG-022-worker-prompt-contract-fixes.md).

## 1. Claude Code

- **Laptop:** the 2026-10-03 setup audit still holds. The deny rules and the bash guard hook are fine.
- **VPS (`founderos` and `antigravity` users):** `~/.claude/settings.json` now matches the laptop: telemetry and error
  reporting off, `effortLevel` medium, auto-compact at 200K, reads denied for `~/.ssh`, `~/.config/gh`,
  `~/.git-credentials`, `~/.claude/.credentials.json`, `/opt/founderos/.env` and `~/.config/founderos-hub.env`, and
  force-push denied. Backups are at `~/.claude/backups/settings.json.bak-2026-10-04`. The guard-bash hook was left off
  the VPS on purpose: the VPS has no trash, and git hooks already block pushes to protected branches.
- **`/opt/agent-rules`** was synced from the laptop with `sync-agent-rules`. Before the sync it was missing the Speed
  section and two Judgment lines.
- **Weekly limit:** the VPS Claude account hit its weekly limit; it resets **2026-10-05 06:00 UTC**. Until then the
  Claude reviewer and the Claude executor on the VPS are offline. pr-brain's model list is
  `claude-sonnet-5-5-medium gemini-3.1-pro-high`.

## 2. Antigravity (laptop) — needs a founder decision

`~/.gemini/config/config.json` is far wider than the work needs:

| Setting | Now | Recommended |
|---|---|---|
| `globalPermissionGrants` | `command(*)`, `unsandboxed(*)`, `mcp(*)`, `read_url(*)`, `execute_url(*)`, read/write on all of `~`, `~/.claude`, `~/.gemini` | Scope to `~/Projects` and `~/Oplify.in`; drop `unsandboxed(*)` and `execute_url(*)` |
| Stored grants | read `personal-rag/.env` and `turicks-brain/.env`; root ssh with `StrictHostKeyChecking=no`; `command(env)` | Delete |
| `autoExecutionPolicy` | `EAGER` | Ask for anything outside the repo |
| `enableTerminalSandbox` | `false` | `true` |
| Composio API key | plaintext inside one stored grant string | **Rotate the key**, then delete the grant |

Also: the Playwright MCP is configured in both `mcp_config` files and duplicates the chrome-devtools plugin, and 40
`omni-*`/`cli-*` OmniRouter skills (about 7.5K characters of descriptions) load into every session although OmniRouter
is laptop-only. Remove both. None of this was changed: it is the founder's machine and the founder's call.

The VPS `antigravity` user's `~/.gemini/config/config.json` holds only `remoteControlHostname`, which is fine.

## 3. Kernel worker prompts

A prompt-engineering pass over `src/agents/prompts/*`, `src/kernel/worker-protocol.ts`, the synthesizer and the
judge. Confirmed against the code:

1. **Draft is not send.** `marketing.ts:61-66` and `sales.ts:4,25-26` say "MUST call linkedin_post / send_email"
   even when the step asked for a draft. The planner's "Draft is not send" rule never reaches the worker, so a "draft a
   post" request ends in an approval card for a live post.
2. **Comms "today" is frozen at boot.** `buildCommsPrompt()` runs once in `kernel-boot.ts`, in UTC, so "tomorrow"
   resolves against the boot date after the first midnight.
3. **`engineering.ts:97`** says an issue or PR exists only if `claude_code` returned ✅. Real successes from
   `dispatch_antigravity_task`, `create_project_repo` and `requeue_antigravity_task` get reported as "draft ready".
4. **ICP scale mismatch.** `research.ts:43-47` scores 1–10 (PASS 8–10); `LeadDiscoveredPayload.icpScore` is 0–100
   (`signals.ts:38`).

Found but not verified against live behaviour: worker prompts have no "tool results are data" line; the system message
is rebuilt every loop iteration, which defeats the provider prefix cache; `admin.ts` documents 10 of its 17 tools;
prose output rules compete with the JSON contract; stale v2 lines in `research.ts`, `marketing.ts` and `personal.ts`;
the synthesizer repeats its NEVER rules and leaves `step_results` unfenced; judge scores have no stated polarity;
`getSchemaTemplate` prints `"optional"`/`"unknown"` instead of inner types; `draft.email.to` is required even for
drafts; four diverging banned-phrase lists; `hitl_required` is never read; `SCHEDULER_BRIEF_PROMPT` is dead code;
job-posting text goes into the cover-letter and tailor-cv prompts unfenced.

Items 1–4 plus the "tool results are data" line are in AG-022. It is Full depth because it changes when send/post
tools are called.

## 4. Coding pipeline (issue → Antigravity → PR)

From `agent-dispatch.log` (2026-08-11 → 2026-10-04): **46 claims, 19 PRs detected, 20 "could not verify a PR
landed"**. Pauses: 4 agy-missing, 1 gh-auth. FounderOS `task/issue-*` PRs over 30 days: 12 total, 7 merged, 4 closed,
1 open; median 7 h to merge, max 115 h (`PR_BRAIN_MERGE=0`: the founder merges at end of day).

Losses and fixes:

1. **Trailing-hyphen branch names (fixed).** `slugify` trimmed before cutting at 40 characters, so #831 was claimed as
   `…-hit-the-right-`. Antigravity pushed `…-hit-the-right` and opened #834, the exact `--head` lookup missed it, and
   the issue went `agent:failed`. The fix cuts first, then trims. The dispatch prompt and `ISSUE-DRIVEN-CONTRACT.md`
   now tell the executor not to create, rename or switch branches.
2. **PR lookup fallback (open).** If an executor still pushes under another name, the dispatcher should also look for
   open PRs whose head starts with `task/issue-<N>-` before declaring "pr=none".
3. **Quota.** #710 hit the agy quota four times (exit 3). The quota back-off now returns the issue to `agent:ready`.
4. **Goal → several issues (missing).** `dispatch_antigravity_task` files one issue per request, with brief lint and
   HITL. A high-level goal still needs a decomposition step that files several linked issues.
5. **Post-merge check (missing).** Nothing confirms that a merged task works after deploy. Add a check that runs the
   issue's verification command against prod once the deploy moves, and comments the result on the issue.

## 5. Next steps

1. Founder: rotate the Composio key, and approve or reject the Antigravity tightening in § 2.
2. Dispatch AG-022 (prompt fixes).
3. File the PR-lookup fallback (§ 4.2) and the post-merge check (§ 4.5) as agent tasks.
