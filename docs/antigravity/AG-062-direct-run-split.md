# AG-062 — Direct-run split: FounderOS dispatches and gates, the coding tool does the work

**Source:** the founder's decision of 2026-10-09 ("go with direct-run split... clear layers"), based on
[the 10-09 audit](../audits/2026-10-09-coding-pipeline-why-no-bug-fixes.md).
**Relation to AG-060:**
- AG-062 removes the spec stage and FounderOS's coding instructions.
- AG-060's job row and label removal (its PR 2 and PR 3) still follow, and get simpler because the spec stage is gone.
**Branch:** `feat/direct-run-split`, cut from `origin/beta`. PR base: `beta`. One PR.
**Depth:** Full. The change covers cross-repo runs, an approval gate (HITL) and work that acts on the founder's behalf.
Read `~/.claude/skills/production-ready/SKILL.md`, [STANDARDS.md](STANDARDS.md) and `.claude/rules/prod-vps.md` first.

## Goal

A founder message like "fix the first bug in the oplify api" should run like this:
1. FounderOS shows one approval card. It names the repo, the issue (number and title), the founder's own words and
   the engine.
2. On the tap, one Claude Code or agy run gets those words and the issue. The run then works the way it would for
   a developer in that repo:
   - it reads the repo's own instructions and test setup;
   - for a bug, it writes a failing test first;
   - it fixes the bug and runs the repo's own checks;
   - it opens a draft PR whose body describes what it actually did.
3. The repo's CI and one pr-brain review decide the result. The founder gets one card: **Merge** if green, or
   **Fix it / Close** if blocked.

FounderOS never tells the tool which test framework to use, which folder to write tests in, or which commands to run.

## The four layers (each owns one thing)

| Layer | Owns | Code |
|---|---|---|
| 1. Intake (Telegram) | Which repo and which issue; the founder's exact words; one approval card | `src/agents/agent-tools/antigravity.ts`, `existing-issue-dispatch.ts`, `src/tools/dispatch-antigravity.ts` |
| 2. Job | One run per approved request; engine fallthrough on quota; exactly one outcome message | `deploy/job-run`, `deploy/agent-dispatch` (build and fix stages only) |
| 3. Tool | Everything about how the work gets done | Claude Code / agy, prompted by one repo-neutral prompt |
| 4. Gate | Repo CI plus pr-brain review, then the Merge or Fix-it card; `PR_BRAIN_MERGE=0` stays | `deploy/vps-daemons/pr-brain`, `deploy/lib/evidence-card.sh` |

## Problem (measured on beta 31211761)

1. The worker writes `founder_request` itself, and on 10-09 it wrote planner text, not the founder's words.
   - Issue #117 read "Pick the first open issue found in s1…", and agy built an "s1 dispatcher module" (Oplify PR #118).
   - The real text is already in `config.configurable.founder_text`, set at `src/gateway/kernel-run.ts:190` and used by
     `calendar-read.ts:38` and `comms.ts:148`.
2. The duplicate check `parseIssueReference` (`antigravity.ts:97`) scans only `founder_request` and `title`.
   "Fix issue #115" in `goal` filed duplicates #117 and #119.
3. Both build prompts are FounderOS-specific:
   - The old path (`deploy/agent-dispatch:1045-1058`) makes the tool read FounderOS's `ISSUE-DRIVEN-CONTRACT.md` and run
     `pnpm lint && pnpm verify:arch`. It also rejects issues that lack FounderOS brief headings (`check_brief_headings`).
   - The newer path (`AGENT_PIPELINE_V2`) adds a spec stage first (`deploy/lib/pass-p.sh`, 552 lines). That stage writes
     a vitest test under `tests/unit/` and runs it with vitest.
   - Oplify API tests with `node --test "test/**/*.test.js"`, so that test never runs in Oplify's CI. pr-brain blocked
     #116, #118 and #120 for this reason.
4. The Merge card exists only for PRs that came through an approved spec (`merge_or_card` → `ec_run`, `pr-brain:1054`).
5. Fix rounds never update the PR body. On #120, round 2 rewrote the test, but the body still showed round 1's output.
   pr-brain called it "fabricated".

## Expected behavior

1. **Intake.**
   - The dispatch tools take the founder's words from `config.configurable.founder_text`, never from a model-written
     argument. Drop `founder_request` from the tool schema.
   - On an approval replay, where the resumed run has no `founder_text` (see the `comms.ts:142` note), use the text
     stored with the approval row.
   - The issue reference is parsed from the founder's text first, then from title, goal, problem and evidence.
   - An existing issue is queued, never re-filed.
   - A request that names no issue files one issue: the founder's words verbatim, plus the model's title.
   - The approval card shows the repo, the issue number and its title fetched from GitHub, the founder's words and the
     engine.
2. **One prompt for every repo.** One function produces it, and a unit test covers it. It carries:
   - the issue title and body, and the founder's words, each fenced as data;
   - the branch and the base;
   - these rules:
     - follow this repository's own instructions (CLAUDE.md / AGENTS.md / CONTRIBUTING) and its own test setup;
     - for a bug, add a failing test first using that setup;
     - run the checks this repo's CI runs that you can run here;
     - commit on this branch and push;
     - open a draft PR to the base whose body has What changed, How it was verified (commands and their real output)
       and NOT VERIFIED.

   The fix-round prompt carries the same rules, plus the blockers. It ends with: "replace the PR body so it describes
   the code as it is now". No repo-specific command names appear in either prompt.
3. **Delete the spec stage.**
   - Remove pass P, the spec card and its callbacks, the task contract, the executor contract prompt, the fail-first
     runner, the brief-heading gate (`check_brief_headings`, `reject_brief`), and the `agent:spec` /
     `agent:spec-review` / `agent:needs-brief` handling.
   - Remove the `AGENT_PIPELINE_V2` flag; the one remaining path is the only path.
   - Before deleting a file, grep its importers. These are the importers measured on 10-09:
     - `task-contract.ts` is imported by 9 files.
     - `pipeline-pending.ts` is imported by 10, including `blocked-callbacks.ts` and `scripts/blocked-review-card.ts`.
   - Keep whatever the blocked card and the Fix-it tap still need. Report `wc -l` of everything removed.
4. **Merge card for every job PR.**
   - When pr-brain clears a PR, the founder gets the Merge card.
   - When pr-brain blocks it, he gets the existing Fix it / Close card.
   - The card is keyed on the job, not on a spec contract. pr-brain still never merges by itself.
5. **One outcome.** `deploy/job-run` keeps its single EXIT-trap message. The stages are now only `build`, `fix` and
   `promote`; `spec` is refused.

## Files in scope

- `deploy/agent-dispatch`, `deploy/job-run`, `deploy/lib/*.sh`, `deploy/vps-daemons/pr-brain`
- `src/agents/agent-tools/antigravity*.ts`, `src/agents/agent-tools/existing-issue-dispatch.ts`,
  `src/agents/prompts/engineering.ts`
- `src/tools/dispatch-*.ts`, `src/tools/pipeline-*.ts`, `src/tools/spec-gate.ts`, `src/tools/task-contract.ts`,
  `src/tools/executor-prompt.ts`, `src/tools/existing-issue.ts`, `src/tools/fail-first.ts`,
  `src/tools/contract-store.ts`, `src/tools/pr-evidence*.ts`
- `src/gateway/coding-cards.ts`, `src/gateway/coding-callbacks.ts`, `src/gateway/blocked-callbacks.ts`
- `scripts/pipeline-*.ts`, `scripts/blocked-review-card.ts`, `scripts/oracle-report.ts`
- The tests for all of these, and the tombstone list in `scripts/verify-architecture.ts`: deleted modules must not
  come back.

## Explicitly forbidden

- Any test-framework name, test path or repo script name (`vitest`, `tests/unit`, `verify:arch`, `node --test`) in the
  prompts. The tool finds them in the repo.
- New prompt rules that patch a code defect.
- A new daemon, a new label, or a second source of truth.
- Auto-merge. `PR_BRAIN_MERGE=0` stays.
- Editing `/opt/founderos` on the VPS.

## Tests first (each fails on beta 31211761)

1. Worker input with `founder_request` "Pick the first open issue found in s1…" and `configurable.founder_text`
   "work on oplify-messaging-api issue 115": the filed or queued request carries the founder text, and queues #115.
2. Goal "Fix issue #115", with title and request naming no number: queues #115 and files nothing.
3. Prompt builder for a repo whose package.json test script is `node --test`: the prompt contains none of the
   forbidden strings and does contain the founder's words fenced.
4. pr-brain clears a job PR with no contract: a Merge card is sent and no merge is attempted.
5. `job-run` with `"stage":"spec"`: refused with one message.

## Verification

```bash
pnpm gate > /tmp/g-$$.log 2>&1; echo "exit=$?"
```

Live path, after the PR deploys:

1. Check the walls first:
   - `~/.claude/agent-dispatch.claude-blocked` (Claude's weekly limit runs until 2026-10-11 00:00 UTC);
   - `~/.claude/agent-dispatch.quota-until` (the agy quota).
2. Send "fix the first bug in the oplify-messaging-api issues" with `scripts/telegram-probe.ts`. Then tap the approval
   card.
3. Expect a draft PR on `pushkarverma3698/oplify-messaging-api` whose new test runs under its own `node --test` CI.
4. pr-brain runs on it through `job-run`; `pr-brain --pr` runs even while the `pr-brain.off` sweep switch is set.
5. Expect a Merge or Fix-it card in Telegram. Paste the card text, the PR URL, the CI run and the `action_log` row.

## Acceptance criteria

- `pnpm gate` green, with the output in the PR body.
- The removed-lines count is in the PR body.
- One real Oplify bug goes from the Telegram message to a Merge or Fix-it card. The PR's test runs in Oplify's own CI.
- If either engine wall blocks the live run, the PR says NOT VERIFIED with the wall's text, and stays a draft.

## The strongest argument against

Removing the spec card removes the founder's preview of what the agent will build before tokens are spent. On 10-09
that preview did not stop a wrong build: the card was approved for a billing test that matched no issue. The new
approval card shows the issue title and the founder's own words, which is what a preview needs. The PR gate catches
the rest.
