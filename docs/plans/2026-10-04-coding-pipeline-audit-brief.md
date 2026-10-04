# Brief: audit and test the FounderOS coding pipeline (Telegram → issue → Antigravity → PR → pr-brain → merge → prod)

Paste this whole file as the first message of a fresh session. Depth: **Full** (deploy, CI, cron, acts on the founder's behalf).
Read `CLAUDE.md`, `docs/rules/SHARED-DIRECTIVES.md`, `docs/antigravity/ISSUE-DRIVEN-CONTRACT.md` and
`~/Projects/prompts/brain-doer-division.md` before acting.

## 1. What the founder wants (judge everything against this)

The founder types one sentence in Telegram ("add a 'ready to merge' section to /tasks") and gets a PR the same day that he can
merge without reading code. On his phone he looks at three things: what changed, the proof it works, and what is still
unverified. If he merges, it works in prod. He never babysits an agent, never debugs a branch name, and is never told "done"
when it is not.

Success, measurable:
- **Lead time:** Telegram request → mergeable PR in under 2 h for a small task (now: median 7 h to merge, max 115 h; most of that is the founder's end-of-day merge, `PR_BRAIN_MERGE=0`).
- **Yield:** at least 80% of claimed issues end in a PR that passes the gate on the first or second review (now: 46 claims → 19 PRs detected, 20 "could not verify a PR landed", from `agent-dispatch.log` 2026-08-11 → 10-04).
- **Truth:** 0 PRs approved with false evidence; 0 merged PRs broken in prod.
- **Founder effort:** one tap to merge; Telegram messages only at start and at done/failed; no silent failures.

## 2. The pipeline today (verify each line: these are leads, not facts)

1. Founder → Telegram → kernel planner → `dispatch_antigravity_task` (HITL card) → GitHub issue labelled `agent:ready`.
2. `~/Projects/scripts/ai-tools/agent-dispatch` (VPS cron, runs as `antigravity`):
   - Claims the issue and creates branch `task/issue-<N>-<slug>` in `/opt/agy-workspace/founderos`, which is hard-reset on every run.
   - Runs `agy --new-project --print … --dangerously-skip-permissions` with **no `--model`/`--effort`**, so it gets Gemini 3.8 Flash High. Timeout is 1800 s.
   - Finds the PR by exact `--head`.
3. `pr-brain` (VPS cron):
   - Picks open PRs that have no `brain-reviewed:<sha>` marker.
   - Runs headless Claude (`claude-sonnet-5-5-medium`, $5 budget per PR, at most 3 per sweep and 20 per day) with the `pr-adversary` skill.
   - The review re-runs the gate, tries to disprove "done", then approves, pushes a fix or requests changes.
   - Skips promotions, red CI and retired model names.
4. The founder merges to `beta` at end of day. The promotion goes `chore/promote-*` → `main` → deploy.
5. Nothing checks the feature in prod after deploy.

Known defects and gaps (2026-10-04 audits):
- **PR lookup:** a trailing-hyphen slug lost #831 (fixed in #837). Lookup has no fallback when the PR's head differs from the claimed branch.
- **Quota:**
  - The dispatcher, laptop use and experiments all share one Antigravity Google quota.
  - A 429 (`exit 3`) puts the issue back to `agent:ready`, but nothing tells the founder when it will resume.
  - On 10-04 the Claude-in-agy quota ran out for about 6 days.
- **Missing features:** no goal → multi-issue decomposition and no post-merge prod check.
- **Worker prompt contract bugs:** draft vs send, a frozen "today", success-claim rules and ICP scale. AG-022 tracks these.
- **Sandbox:** headless runs skip permissions and are not sandboxed. The `antigravity` user holds a GitHub token with write scope.
- **Instruction layering:**
  - Repo `AGENTS.md`, `GEMINI.md` and the global rulebook all load.
  - STANDARDS.md says "read in full", which is advisory; it is not a `trigger: glob` rule.
  - Five off-topic Apify skills in `.agents/skills/` load every session.

## 3. Model evidence so far (2026-10-04 A/B on 3 merged issues, offline, history-free checkouts)

| Issue | Model | Time | Diff (reference PR) | All gates + reference tests |
|---|---|---|---|---|
| #831 | Gemini 3.8 Flash High (default) | 1021 s | +181 −65 (ref +160 −59) | pass |
| #831 | Gemini 3.1 Pro High | 516 s | +96 −39, 5/5 ref files | pass |
| #828 | Gemini 3.8 Flash High | 1465 s | +124 −21, 7/10 ref files | pass |

The other 6 cells hit quota. That is not enough to pick a model.

The harness is reusable: `/opt/agy-workspace/ab-test/ab.sh` on the VPS, run as `antigravity`. It fetches PR refs, builds
history-free checkouts, and scores lint, arch, tests and reference tests.

## 4. What to audit

A. **Intake.**
   - Does a vague Telegram request become an issue with a testable acceptance criterion and a verification command?
   - Does the planner ask for a missing field instead of guessing?
   - Check the last 20 `dispatch_antigravity_task` issues.
B. **Dispatch.** Walk claim → branch → workspace → agy → PR lookup through every exit path:
   - success, timeout, quota
   - agy missing, gh auth failure, dirty workspace
   - PR pushed under another head, two issues at once

   Each path should send one honest Telegram message and set the right label.
C. **Executor quality.**
   - Model and effort pinning.
   - The prompt: the contract, STANDARDS and the issue body.
   - Instruction layering and size, which skills load, and the sandbox.
   - Does each PR body carry What changed / How verified (with output) / NOT VERIFIED?
D. **Gate (pr-brain).**
   - Does `pr-adversary` really re-run `pnpm gate`, check the evidence against the diff, and catch a planted defect?
   - Measure false-approve and false-reject rates.
   - Freshness: a new push must re-open the gate.
   - Check the budget and daily caps.
E. **Merge → deploy → prod.** Promotion speed, deploy confirmation and the missing post-merge check.
F. **Founder experience.**
   - Count Telegram messages per task.
   - Every failure needs a reason and a next action (#26).
   - `/tasks` must show the true state.
G. **Safety.**
   - Tokens and scopes held by the VPS users.
   - `--dangerously-skip-permissions`.
   - Kill switches: `pr-brain.off` and the dispatcher pause.
   - What an instruction injected into an issue body could make the executor do.

## 5. What to test, and what it costs

Free ($0, run these first):
1. **Unit tests for the dispatcher's pure logic:** slugify, PR-lookup fallback, label transitions and quota back-off. Port the bash logic, or test it through fixtures.
2. **Dry runs:** run `pr-brain` and `agent-dispatch` in dry-run mode (add one if missing) against the live repo and list what they would act on.
3. **Log replay:** replay the last 30 days of `agent-dispatch.log` and `pr-brain.log` into a table of claim → PR → review → merge → deploy, with the reason each lost issue did not make it.

Paid (one run each, after the free tests). Check quota first and run only while the dispatch queue is idle:
4. **Golden task set:**
   - Pick 5 small, already-merged issues of different shapes: bug fix, feature, docs, test-only and multi-file.
   - Run the A/B harness on them with 2–3 models after the quota resets.
   - Pin the winner with `--model` in `agent-dispatch`.
5. **Planted-defect gate test:**
   - Open 3 draft PRs on a throwaway branch: one correct, one hiding a failing test behind a passing claim, one claiming "done" without evidence.
   - pr-brain must approve the first and reject the other two.
   - Close all three afterwards.
6. **One real end-to-end task through Telegram** (`scripts/telegram-probe.ts`): request → issue → PR → review → founder merge → deploy → prod check, with a timestamp at every hop.
7. **Fault injection, one run each:** quota 429 (stub agy with exit 3), agy timeout, PR pushed under a different head name, dirty workspace.

## 6. Improvement ideas, ranked by impact on the founder

1. **Pin the executor model and effort** after the golden-set run. On a 429, fall back to another model instead of waiting hours.
2. **Acceptance criteria in every issue:**
   - The planner refuses to file an issue without a verification command.
   - The PR must show that command's output.
   - pr-brain checks it.
3. **PR-lookup fallback** (`task/issue-<N>-*`), plus a single "where is my task" line in `/tasks` (claimed / running / PR / review / merged / live).
4. **Post-merge prod check:** after deploy, run the issue's verification command against prod, comment the result on the PR, and message the founder on Telegram if it fails.
5. **Quota awareness:** read the reset time from `AGY_ERROR` and tell the founder once ("paused until 12:40 UTC"). Keep experiments off the production quota.
6. **Sandbox headless runs** with `agy --sandbox`, and narrow the `antigravity` GitHub token to the repos it works on, as long as push and `gh` still work inside the sandbox.
7. **Instruction hygiene:**
   - Keep one repo instruction file for Antigravity.
   - Move STANDARDS.md to `.agents/rules/*.md` with `trigger: glob` on `src/**`.
   - Remove the off-topic Apify skills.
8. **Goal decomposition:** one high-level request files several linked issues, each small enough to finish in one run.
9. **Faster merge:** when the founder opts in, pr-brain merges low-risk PRs (Lite depth, docs or test-only) to `beta` on green. Full-depth PRs stay founder-merged.

## 7. Deliverables

1. `docs/plans/YYYY-MM-DD-coding-pipeline-audit.md` containing:
   - the funnel table from §5.3
   - every finding, with file:line or log evidence
   - the NOT VERIFIED items
2. Unit tests for the dispatcher and pr-brain pure logic, merged through the normal gate.
3. The golden-set A/B results and the pinned model, as a one-line change to `agent-dispatch`.
4. The planted-defect gate results: the approve/reject verdict for each PR.
5. An Antigravity brief (`docs/antigravity/AG-NNN-*.md`) for each improvement the founder approves, smallest first.

## 8. Constraints

- **Freeze:** the 30-day freeze allows only outcomes A–D. This work is outcome A (coding PRs), so every PR carries `Moves: A`.
- **Shared trees:** never edit `/opt/founderos`; review checkouts go in `/opt/review/<repo>`. Run `agy-guard` before touching a shared tree.
- **Paid runs:** `pnpm test` is $0. Name every paid run and run it once. Watch the Google quota, because the live dispatcher shares it.
- **Killing processes over ssh:**
  - Never `pkill -f <pattern>` when the pattern appears in your own command line. It kills your own shell (this happened on 10-04).
  - Kill by PID instead.
- **Ending:** close with "Outstanding from your end".
