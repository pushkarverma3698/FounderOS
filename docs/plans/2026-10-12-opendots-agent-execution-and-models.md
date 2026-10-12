# Plan 2026-10-12: OpenDots Agent Execution, Prompt Overhaul, and Model Routing

## Outcome
1. OpenDots agents (Chief, Builder, Architect, Reviewer) handle ad-hoc questions and inspections directly via `claude` and `agy` CLIs on their computer without filing bogus GitHub issues.
2. The computer container image (`opendots-computer-turicks:1`) includes local PostgreSQL, Redis, and Playwright Chromium dependencies so repository test suites (such as Oplify's 379 integration tests) pass.
3. OpenDots model routing uses `deepseek/deepseek-v4.1-flash` as primary with automatic fallback to `google/gemini-2.5-flash` on OpenRouter.
4. Repository nicknames (e.g. `oplify`) resolve cleanly to full repo names (`OplifyMessage/oplify-messaging-api`).
5. All agent prompts in `setup-dots.sh` and `team/*.md` are audited, updated to eliminate rigid refusals, and kept strictly under the 2,000-character cap.

---

## 1. Problem & Root Cause

| Issue | Root Cause | Fix |
|---|---|---|
| Builder refused to check PRs/issues ("outside my lane") | Prompt in `setup-dots.sh` commanded: *"You only dispatch... Nothing else: no other commands, no reading files, issues, PRs yourself."* | Allow read-only direct inspections with `gh` and `claude -p` / `agy --print`. |
| Ad-hoc requests created noisy GitHub issues (#147, #148, #149, #150) | `team-shift builder --task` forced every prompt into `gh issue create ... --label agent:building`. | Differentiate queries/inspections from shipping code tasks; only code changes touch the issue/PR queue. |
| Strict repo name failures (`oplify` failed) | Exact matching `[[ $r == "$task_repo" \|\| $r == */"$task_repo" ]]` in `team-shift`. | Add fuzzy/substring and alias matching for team repos in `team-shift`. |
| 379 Oplify tests skipped; manual install failed | Container lacks PostgreSQL, Redis, and Playwright system libs; unprivileged Docker container blocks runtime `apt` and daemon startup. | Bake `postgresql`, `redis-server`, and Playwright libraries into `deploy/opendots/computer.Dockerfile`. |
| Outer Dot LLM broke character attempting raw OS commands | Imperative instruction ("Install postgres...") couldn't map to `team-shift`, causing fallback to unconstrained `computer_exec`. | Teach the Dot prompt its boundary and available computer services. |

---

## 2. Implementation Steps

### Step 1: Container Hardening (`deploy/opendots/computer.Dockerfile`)
- Add packages to `computer.Dockerfile`:
  - `postgresql`, `postgresql-contrib`, `redis-server`
  - Playwright Chromium system dependencies (`libnss3`, `libasound2`, `libgbm1`, `libatk1.0-0`, etc.)
- Add an entrypoint wrapper / service starter so local Postgres and Redis start automatically on boot for root/postgres test runs.
- Add Playwright installation: `npx -y playwright install --with-deps chromium` (cached in container).

### Step 2: Repository Fuzzy & Alias Matching (`deploy/opendots/team-shift`)
- In `deploy/opendots/team-shift`, expand repo resolution:
  - If `$task_repo` matches alias `oplify` → `OplifyMessage/oplify-messaging-api`
  - If `$task_repo` matches alias `oplify-app` → `OplifyMessage/oplify-messaging-app`
  - If `$task_repo` matches substring in exactly one team repo, auto-select it.
  - If ambiguous, print the matching candidates cleanly.

### Step 3: Differentiate Direct Inspection from Queue Building (`team-shift`)
- In `deploy/opendots/team-shift`:
  - Add `--inspect` or allow read-only queries: when task is a pure query (check issues, diffs, test run, code audit), run `claude -p` or `agy --print` directly via `run-bg` in the repo clone without filing a GitHub issue or setting labels.
  - Print the output directly to stdout for the Dot to relay.
  - Reserve `gh issue create` strictly for tasks that require branching, code changes, and PR shipping.

### Step 4: Prompt Overhaul (`deploy/opendots/setup-dots.sh`, `deploy/opendots/team/*.md`)
- **`BUILDER` Prompt (`setup-dots.sh`):**
  - Clarify: You are Builder. For ad-hoc queries, audits, or running tests: run `team-shift builder --inspect --repo <repo> --task '<words>'`. For code changes/PRs: `team-shift builder --engine <engine> --repo <repo> --task '<words>'`.
  - Remove robotic refusals. Keep under 2,000 characters.
- **`CHIEF` Prompt (`setup-dots.sh`):**
  - Allow Chief to directly answer repo status, open PRs, and triage summaries without requiring a 60-second background batch run for simple reads.
  - Keep state changes (merging approved PRs, label swaps) on `chief-run`.
- **`ARCHITECT` & `REVIEWER` Prompts (`setup-dots.sh`, `team/architect.md`, `team/reviewer.md`):**
  - Replace the 3-line refusal stub with active assistance: Architect answers design/plan questions; Reviewer explains PR blockers and CI test failures when asked in chat.

### Step 5: Model Routing Configuration (`.env`)
- In `/opt/opendots/app/.env`:
  - Set `OPENAI_MODEL=deepseek/deepseek-v4.1-flash,google/gemini-2.5-flash`
  - Verify OpenRouter fallback routing receives both slugs.
- In FounderOS `.env.example` and `src/agents/model.ts`:
  - Document `openrouter:deepseek/deepseek-v4.1-flash` with fallback `google-genai:gemini-3.8-flash`.

---

## 3. Verification & Evidence Plan

1. **Unit Tests:**
   - Update `tests/unit/scripts/opendots-team-shift.test.ts` to test:
     - Fuzzy repo matching (`oplify` -> `OplifyMessage/oplify-messaging-api`).
     - Pure read-only inspect tasks (starts claude/agy without filing GitHub issues).
   - Run `pnpm test tests/unit/scripts/opendots-team-shift.test.ts`.
2. **Container Build Verification:**
   - Verify `computer.Dockerfile` builds cleanly without apt or library errors.
   - Verify `pg_isready` and `redis-cli ping` succeed inside the built container.
3. **Prompt Character Limit Gate:**
   - Run character count checks in `setup-dots.sh` to ensure all prompts remain $\le 2000$ characters.
4. **Deploy & Live Smoke Check:**
   - Push to `beta`, promote to `main`, run `setup-dots.sh` on `founderos-vps`.
   - Ask Builder in chat: "Using agy check all the open issues in oplify repo".
   - Confirm it reports the open issues directly in chat without creating Issue #151 on GitHub.
