# Green Main, Rulebook Split, and Prod Catch-Up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unbreak `main`'s CI, land uncommitted work, catch prod up to `main` and live-verify it end-to-end (Spec A) — then consolidate four drifted instruction files into one CI-enforced Tier-1 rulebook plus RAG-retrievable Tier-2 context, with a machine-checked branch-naming standard (Spec B2).

**Architecture:** Two independent pushes. Push 1 (Spec A) fixes the two bugs that broke CI on `957ac81`, lands three uncommitted files, cherry-picks the one genuinely unmerged fix across 28 branches, archives the rest, and drives a live-verified deploy under a hard €0.50 cap. Push 2 (Spec B2) only starts once Push 1 is confirmed live on prod — it touches only docs and one CI script, zero runtime risk, but depends on nothing from Push 1 except a stable baseline to diff against.

**Tech Stack:** TypeScript (Node 22), vitest, GitHub Actions, Drizzle/Postgres (VPS), pnpm.

**Task ownership:** Tasks 1–3 and 8–10 are dispatched to fresh subagents (mechanical/multi-file code and doc edits with a complete, unambiguous spec). Tasks 4–7 are executed directly by the controller (this session) — they are irreversible or budget-sensitive operations (branch deletion, direct push to `main`, watching a real deploy, spending real LLM tokens against a hard cap) that the subagent-driven-development skill's own model-selection guidance places outside "mechanical implementation," and which this repo's CLAUDE.md separately requires the acting agent (not a sub-delegate) to watch through to completion ("WATCH THE DEPLOY").

---

## Context every subagent needs (do not make them re-derive this)

- Repo root: `/Users/pushkarverma/Projects/founderos`. Branch to work on: `pr-423-local` (already checked out, already ahead of `origin/main` by one docs-only commit `cd85948`).
- `origin/main` HEAD is `957ac81`. CI failed on it — see Task 1 and Task 2 below for the exact two bugs.
- **Never run `pnpm eval`, `pnpm test:integration`, `pnpm qa:telegram`, or any live-model script.** Every task below is $0 (mocked tests only). Live verification is Task 7, executed by the controller, capped at €0.50.
- Run `pnpm test <path>` for a single file, not full `pnpm test`, to keep iteration fast — the full suite is 2797 tests / ~100s.

---

## Task 1: Fix CI step ordering (`verify:runtime-assets` before `build:all`)

**Files:**
- Modify: `package.json` (scripts block, after line 32 `"gate": ...`)
- Modify: `.github/workflows/ci.yml:24-33` (the `quality` job steps)

**Problem:** CI run [31239271804](https://github.com/pushkarverma3698/FounderOS/actions/runs/31239271804) failed with:
```
✗ dist/ not found — run `pnpm build` first.
```
because `.github/workflows/ci.yml` runs `pnpm verify:runtime-assets` (line 30) *before* `pnpm build:all` (line 31). The local `pnpm gate` script runs them in the correct order but CI describes its own separate, wrong order — the exact drift that caused this outage.

- [ ] **Step 1: Add a `ci:quality` script that is the single source of truth for this ordering**

In `package.json`, immediately after the `"gate"` line (currently line 32:
`"gate": "pnpm lint && pnpm build:all && pnpm verify:runtime-assets && pnpm verify:wiring && pnpm verify:arch && pnpm test",`), add a new script that is exactly `gate` minus the `&& pnpm test` suffix — this guarantees the two can never drift again, because one is textually a prefix of the other:

```json
    "ci:quality": "pnpm lint && pnpm build:all && pnpm verify:runtime-assets && pnpm verify:wiring && pnpm verify:arch",
```

- [ ] **Step 2: Replace the 5 separate `run:` steps in the `quality` job with one call to `ci:quality`**

In `.github/workflows/ci.yml`, the `quality` job currently ends with:
```yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm verify:arch
      - run: pnpm verify:wiring
      - run: pnpm verify:runtime-assets
      - run: pnpm build:all
```
Replace the five `pnpm lint` / `verify:arch` / `verify:wiring` / `verify:runtime-assets` / `build:all` lines with a single line:
```yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm ci:quality
```

- [ ] **Step 3: Verify locally**

Run:
```bash
pnpm ci:quality
```
Expected: exits 0. This is the same command CI will now run — if it passes locally, CI's quality job cannot fail on ordering again, because there is no longer a second place for the order to be written.

- [ ] **Step 4: Commit**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "ci: single ci:quality script so CI and local gate can't drift on step order

CI ran verify:runtime-assets before build:all (dist/ didn't exist yet),
while pnpm gate ran them correctly — two descriptions of the same
ordering drifted apart. ci:quality is textually a prefix of gate now,
so they can't diverge again."
```

**Self-review:** Confirm `pnpm gate` locally still passes end-to-end (it will re-run `ci:quality`'s steps plus `test` — this is expected, not wasted work, since `gate` is the full pre-deploy check).

Report DONE with the `pnpm ci:quality` output, or BLOCKED with the failure.

---

## Task 2: Fix `project-workflow.test.ts` ENOENT on CI runners

**Files:**
- Modify: `tests/unit/tools/project-workflow.test.ts:200-236` (the "read_file truncation" describe block)

**Problem:** Both tests in this block call:
```ts
const dir = mkdtempSync(join(homedir(), "Projects/founderos-test-"));
```
which fails with `ENOENT: no such file or directory, mkdtemp '/home/runner/Projects/founderos-test-XXXXXX'` on GitHub-hosted runners, because `~/Projects` doesn't exist there. This is the same bug class already fixed once in `deploy-static-site.test.ts` by commit `473e1a7` — same fix, different file.

Current exact content (lines 200-236):
```ts
// ── read_file truncation (prevents Gemini 400 on large files) ─────────────────

describe("read_file truncation", () => {
  it("returns full content for files under 6000 chars", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { projectWorkflowTool } = await import("../../../src/tools/project-workflow.js");

    const dir = mkdtempSync(join(homedir(), "Projects/founderos-test-"));
    const small = "x".repeat(100);
    writeFileSync(join(dir, "small.ts"), small);

    const result = await projectWorkflowTool.execute({ action: "read_file", path: dir + "/small.ts" });
    expect(result.success).toBe(true);
    expect(result.data as string).toBe(small);
  });

  it("truncates files over 6000 chars with a clear notice", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { projectWorkflowTool } = await import("../../../src/tools/project-workflow.js");

    const dir = mkdtempSync(join(homedir(), "Projects/founderos-test-"));
    const large = "y".repeat(8_500);
    writeFileSync(join(dir, "large.ts"), large);

    const result = await projectWorkflowTool.execute({ action: "read_file", path: dir + "/large.ts" });
    expect(result.success).toBe(true);
    const data = result.data as string;
    // Must be capped at 6000 chars of content + truncation notice
    expect(data.startsWith("y".repeat(6_000))).toBe(true);
    expect(data).toContain("chars truncated");
    expect(data).toContain("grep");
```
(the block continues a few more lines after — do not touch anything past the `mkdtempSync` calls).

- [ ] **Step 1: Check how `473e1a7` fixed the same bug in `deploy-static-site.test.ts`**

Run: `git show 473e1a7 -- tests/ | grep -A5 -B5 mkdirSync` and read the actual fix pattern used there, to match this repo's established convention rather than inventing a new one.

- [ ] **Step 2: Add a `mkdirSync(..., { recursive: true })` call before each `mkdtempSync`**

In both `it(...)` blocks, change:
```ts
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { projectWorkflowTool } = await import("../../../src/tools/project-workflow.js");

    const dir = mkdtempSync(join(homedir(), "Projects/founderos-test-"));
```
to:
```ts
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { projectWorkflowTool } = await import("../../../src/tools/project-workflow.js");

    mkdirSync(join(homedir(), "Projects"), { recursive: true });
    const dir = mkdtempSync(join(homedir(), "Projects/founderos-test-"));
```
(apply to both the "returns full content" and "truncates files over 6000 chars" tests — two edits, same pattern).

- [ ] **Step 3: Run the fixed tests**

```bash
pnpm vitest run tests/unit/tools/project-workflow.test.ts
```
Expected: all tests in the file pass, including the two "read_file truncation" tests.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/tools/project-workflow.test.ts
git commit -m "test: fix project-workflow.test.ts ENOENT in CI by ensuring ~/Projects exists

Same bug class 473e1a7 already fixed in deploy-static-site.test.ts —
mkdtempSync assumed ~/Projects exists, which is true on the founder's
Mac but not on a fresh GitHub-hosted runner."
```

Report DONE with the vitest output, or BLOCKED if the fix pattern in `473e1a7` differs materially from what's specified here (re-check with the controller before deviating).

---

## Task 3: Wire `ingest:claude`, land the uncommitted Claude-session-ingestion work

**Files:**
- Modify: `package.json` (scripts block)
- Add (already exist on disk, untracked): `src/lib/claude-transcript.ts`, `scripts/ingest-claude-sessions.ts`, `scripts/tui-dashboard.ts`, `tests/unit/lib/claude-transcript.test.ts`, `tests/unit/infra/scheduler-cron-wiring.test.ts`, `tests/unit/infra/self-improvement-wiring.test.ts`
- Stage (already modified, uncommitted): `scripts/sync-turicks-brain.ts` (the market-intel ingestion block)

**Context:** A prior session wrote `scripts/ingest-claude-sessions.ts` (253 lines) and `src/lib/claude-transcript.ts` (156 lines) — this is the mechanism that lets Claude Code's own session history flow into `brain.turicks_brain` so future agents (including other Claude sessions) can retrieve "what did I already try." It has tests but was **never wired into `package.json`** — the script exists, but there is no `pnpm` command to run it. This task is pure landing/wiring, not new design.

- [ ] **Step 1: Read the ingestion script's entry point to confirm the exact invocation shape**

```bash
head -30 scripts/ingest-claude-sessions.ts
```
Confirm how it expects to be run (look for `process.argv`, `import.meta.url` main-guard, or a straight top-level `await main()` — match whatever pattern the file already uses; do not add a new CLI framework).

- [ ] **Step 2: Add the `ingest:claude` script to `package.json`**

Add it next to the other `ingest:*` / `sync:*` scripts (near `"ingest:chats": "node --env-file=.env --import tsx/esm scripts/ingest-external-chats.ts",`):
```json
    "ingest:claude": "node --env-file=.env --import tsx/esm scripts/ingest-claude-sessions.ts",
```

- [ ] **Step 3: Run the existing tests for the new files (do not run the script live — it needs a real DB + real session files, out of scope for this task)**

```bash
pnpm vitest run tests/unit/lib/claude-transcript.test.ts tests/unit/infra/scheduler-cron-wiring.test.ts tests/unit/infra/self-improvement-wiring.test.ts
```
Expected: all pass ($0 cost — these are unit tests against fixtures/mocks, confirm by reading the test files if unsure before running).

- [ ] **Step 4: Run the full test suite once to confirm nothing else broke from staging these files**

```bash
pnpm test
```
Expected: same pass count as before this task started, plus the newly-added tests, zero new failures.

- [ ] **Step 5: Commit the ingestion feature and the market-intel brain-sync addition together**

```bash
git add package.json src/lib/claude-transcript.ts scripts/ingest-claude-sessions.ts scripts/tui-dashboard.ts tests/unit/lib/claude-transcript.test.ts tests/unit/infra/scheduler-cron-wiring.test.ts tests/unit/infra/self-improvement-wiring.test.ts scripts/sync-turicks-brain.ts
git commit -m "feat(brain): wire pnpm ingest:claude for Claude session ingestion, add market-intel to brain:sync

ingest-claude-sessions.ts and claude-transcript.ts existed with tests
but no package.json entry point — the brain-sync mechanism for
Claude's own session history was built but unreachable. Also lands
the docs/market-intel ingestion block already staged in
sync-turicks-brain.ts."
```

**Do NOT commit** (explicitly out of scope, flag to controller instead of deleting): `.agents/scratchpad/*.log`, `mac-client/cv-backend.pdf`, `mac-client/cv-frontend.pdf`, `mac-client/your-cv.pdf`, `mac-client/tests/test_apply.py`, `test-artifacts/`, `eval-report.md`, `docs/market-intel/README.md` (only the script wiring, not this doc — check if it's already tracked; if untracked and empty/placeholder, leave it for the controller to decide).

Report DONE with test output, or NEEDS_CONTEXT if `mac-client/tests/test_apply.py` looks like it belongs with an in-progress mac-client feature the controller should know about before it's left uncommitted.

---

## [CONTROLLER] Task 4: Cherry-pick the one genuinely unmerged fix, close PR #424

Not delegated — single git operation requiring judgment about conflict resolution against Task 3's changes to the same file.

- [ ] Cherry-pick `a706b97` (`fix(jobhunt): generate valid UUID for free sweepId in free-ingest`) from `cursor/fix-free-ingest-uuid-d523` onto the working branch:
  ```bash
  git cherry-pick a706b97
  ```
- [ ] If it conflicts on `scripts/sync-turicks-brain.ts` (likely, since PR #424 also touched that file and Task 3 just committed a different version): resolve by keeping Task 3's version of `sync-turicks-brain.ts` in full (it is the superset — confirmed during design that PR #424's 56-line addition to that file was a different, older draft of the same market-intel block already landed in Task 3) and taking only the `src/tools/jobhunt/free-ingest.ts` + `randomUUID` import changes from the cherry-pick.
- [ ] Verify: `grep -n "randomUUID\|sweepId = " src/tools/jobhunt/free-ingest.ts` shows `sweepId = randomUUID()`, not the timestamp-based version.
- [ ] Run `pnpm vitest run tests/unit/jobhunt/` to confirm nothing in the jobhunt suite broke.
- [ ] Commit if the cherry-pick needed manual conflict resolution (otherwise the cherry-pick itself is the commit).
- [ ] Close PR #424 as superseded: `gh pr close 424 --comment "Superseded — cherry-picked the sweepId fix directly onto main via $(git rev-parse HEAD)."`

---

## [CONTROLLER] Task 5: Archive and delete the 26 already-merged branches

Not delegated — destructive git operation (branch deletion) explicitly gated by this repo's safety rules to require direct, careful execution, not delegation.

- [ ] **Group 1 — genuinely 0 commits ahead of `origin/main`** (confirmed during design-phase audit; re-verify each with `git rev-list --left-right --count origin/main...origin/<branch>` immediately before deleting, since new commits may have landed since the audit):
  ```
  chore/cv-market-scan chore/docs-cleanup-case-studies chore/jobhunt-board-registry-prune-and-grow
  chore/remove-composio chore/repo-docs-cleanup claude/elegant-sutherland-fc35de claude/nice-tu-afc9e6
  cursor/fix-beta-main-merge-conflict-d523 cursor/readme-hiring-rewrite-d523 docs/evidence-console-design
  feat/founderos-growth-readme feat/jobhunt-apply-loop feat/jobhunt-apply-loop-impl
  feat/jobhunt-cadence-and-freshness feat/jobhunt-free-ats-lane
  feat/jobhunt-outcome-pipeline feat/jobhunt-resume-tailoring feat/jobhunt-screening-gates
  feat/m0a-evolution-engine-v0 feat/reminders-ist-clock feat/video-kling-i2v
  feat/voice-browser-control fix/gmail-read-full-body
  fix/jobhunt-phase0-supply-and-visibility
  fix/jobhunt-sheet-tabs-and-browser-tests fix/jobhunt-stretch-why-line fix/jobhunt-unknown-location-flag
  fix/reset-resume-checkpoint-race fix/sync-beta gemini/antigravityChanges
  integration/jobhunt-supply-and-speed
  ```
- [ ] **Group 2 — nonzero `ahead` count in raw git terms, but proven during design (via `git diff origin/main...origin/<branch> -- src/`) that every unique commit's content is already present on `main`** (the `ahead` count reflects merge commits and doc/test churn, not net-new `src/` behavior — re-run the same diff command before deleting to confirm this is still true, don't trust the count alone for these three):
  ```
  feat/jobhunt-india-market fix/jobhunt-recover-country-from-url fix/jobhunt-implausible-pay-range
  ```
- [ ] **Group 3 — `cursor/fix-free-ingest-uuid-d523`**: archive/delete only *after* Task 4's cherry-pick lands (it carries the one genuinely new commit, already extracted).
- [ ] Deletion procedure, applied to all three groups:
  ```bash
  for b in <verified-branches-from-groups-1-3>; do
    git tag "archive/$b" "origin/$b"
    git push origin --delete "$b"
    git push origin "archive/$b"
    git branch -D "$b" 2>/dev/null || true   # local copy, if it exists
  done
  ```
- [ ] Do NOT touch: `beta` (retired from required path, not deleted — see Task 9), `main`, `pr-423`, `pr-423-local`, `pr-423-merge` (this session's own branches), and any branch that re-audits as carrying content not yet on `main`.
- [ ] Confirm final branch list: `git branch -r | wc -l` — expect roughly 2-6 remaining (main, beta, this session's branches).

---

## [CONTROLLER] Task 6: Push, verify CI green, verify deploy landed

Not delegated — direct push to `main`'s PR, watching real CI/CD, per CLAUDE.md's explicit "WATCH THE DEPLOY" requirement (not satisfiable by a sub-delegate that ends its turn before the deploy workflow completes).

- [ ] `pnpm gate` locally — must be green before push (evidence, not assumption).
- [ ] Push the branch, open a PR to `main` (per CLAUDE.md's current policy — direct PRs to `main` are permitted since the 2026-08-01 founder directive; see Task 9 for cleaning up the contradictory docs that still say otherwise).
  ```bash
  git push -u origin pr-423-local
  gh pr create --base main --title "fix: unbreak CI ordering, land Claude-session ingestion, sweepId UUID fix" --body "$(cat <<'EOF'
## Summary
- Fixes the two CI bugs that broke main on 957ac81 (verify:runtime-assets/build:all ordering, project-workflow.test.ts ENOENT)
- Lands the uncommitted Claude-session brain-ingestion feature (pnpm ingest:claude)
- Cherry-picks the free-ingest sweepId UUID fix (supersedes #424)
- Archives 26+ fully-merged branches

## Test plan
- [x] pnpm gate green locally
- [ ] CI green on this PR (both required checks)
- [ ] Deploy fires and VPS git SHA matches main after merge
EOF
)"
  ```
- [ ] Watch CI: `gh pr checks --watch` until both required checks (`Type check + lint + wiring`, `Unit + regression tests`) report success.
- [ ] If CI fails: read the failure, fix directly (small, already-scoped fixes at this point — do not re-delegate mid-flight), push again, re-watch.
- [ ] Merge once green: `gh pr merge --merge` (or squash, matching this repo's existing merge convention — check the last 5 merged PRs' merge method with `gh pr list --state merged --limit 5 --json mergeCommit,number` first).
- [ ] Watch the deploy: `gh run watch $(gh run list --workflow=Deploy --limit 1 --json databaseId --jq '.[0].databaseId')`.
- [ ] Verify prod actually moved:
  ```bash
  ssh founderos-vps 'cd /opt/founderos && git log -1 --format=%H'
  ```
  Must match the merge commit SHA on `origin/main`. If it doesn't, the deploy silently failed — diagnose via `ssh founderos-vps 'systemctl status founderos.service'` and prior incident notes in CLAUDE.md's History section before declaring this task done.

---

## [CONTROLLER] Task 7: Live E2E, capped at €0.50, regenerate proof docs

Not delegated — spends real money against a hard budget; the controller must monitor spend in real time and stop if the cap is approached, which a fire-and-forget subagent dispatch cannot safely guarantee.

- [ ] Record baseline spend: `ssh founderos-vps` → `select sum(cost_usd) from agents.ai_call_costs;` (note the value).
- [ ] Set `RUN_BUDGET_USD=0.50` for this run's environment.
- [ ] `pnpm eval`
- [ ] `node --env-file=.env --import tsx/esm scripts/live-e2e-proof.ts`
- [ ] One real Telegram round-trip against prod: send a simple message to the bot, confirm a reply, then confirm the turn produced an `action_log` row on the VPS (`select * from agents.action_log order by created_at desc limit 1;`).
- [ ] `pnpm proof:scoreboard` and `pnpm proof:costs` — regenerate `docs/PROOF.md` and `docs/COSTS.md` with fresh timestamps and the current test count (2797+, not the stale 1213).
- [ ] Record final spend, compute delta, confirm delta < €0.50 (convert from USD at the time of the run). If the delta approaches or exceeds the cap mid-sequence, stop immediately and report actual spend rather than completing the remaining steps.
- [ ] Commit the regenerated proof docs:
  ```bash
  git add docs/PROOF.md docs/COSTS.md
  git commit -m "docs: regenerate PROOF.md and COSTS.md from live-verified run"
  git push
  ```

---

## Task 8: Add branch-naming rule to `verify-architecture.ts`

**Files:**
- Modify: `scripts/verify-architecture.ts` (add after `ruleTombstones`, around line 192)
- Modify: `tests/unit/scripts/verify-architecture.test.ts` (add a new `describe` block)

**Context:** Branch names today are inconsistent — 8 of the (soon-to-be-small) remaining branches use agent-namespaced prefixes (`cursor/`, `gemini/`, `claude/`, `integration/`) that describe who typed the command, not what the change is. The standard: `<type>/<kebab-description>`, types `feat fix chore docs test ci refactor`. This is a pass/fail gate on a single string (the PR's head branch name), not a file-content ratchet, so it does not fit the existing `RuleResult`/`checkRatchet` shape — it's a separate pure function, tested the same way as the other rules but invoked separately in the CI runner block.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/scripts/verify-architecture.test.ts`, after the `describe("ratchet", ...)` block:
```ts
describe("branch naming", () => {
  it("accepts <type>/<kebab-description> for every allowed type", () => {
    for (const type of ["feat", "fix", "chore", "docs", "test", "ci", "refactor"]) {
      expect(checkBranchName(`${type}/some-thing`).ok).toBe(true);
    }
  });

  it("rejects an unknown type prefix", () => {
    const res = checkBranchName("cursor/some-thing");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("cursor/some-thing");
  });

  it("rejects a prefix with no description", () => {
    expect(checkBranchName("feat/").ok).toBe(false);
  });

  it("rejects uppercase or underscore segments", () => {
    expect(checkBranchName("feat/Some_Thing").ok).toBe(false);
  });

  it("exempts main and beta", () => {
    expect(checkBranchName("main").ok).toBe(true);
    expect(checkBranchName("beta").ok).toBe(true);
  });
});
```
Also add `checkBranchName` to the import list at the top of the file (alongside `ruleGatewayImports` etc.).

- [ ] **Step 2: Run it, confirm it fails**

```bash
pnpm vitest run tests/unit/scripts/verify-architecture.test.ts
```
Expected: FAIL — `checkBranchName` is not exported (doesn't exist yet).

- [ ] **Step 3: Implement `checkBranchName` in `scripts/verify-architecture.ts`**

Add after the `ruleTombstones` function (after line 192, before the `// ── Ratchet ──` comment on line 194):
```ts
/** Branch naming standard: <type>/<kebab-description>. No agent-namespaced prefixes —
 *  git already records who authored a commit; the branch name should say what it does. */
const BRANCH_TYPES = ["feat", "fix", "chore", "docs", "test", "ci", "refactor"] as const;
const BRANCH_NAME_RE = new RegExp(`^(${BRANCH_TYPES.join("|")})/[a-z0-9]+(-[a-z0-9]+)*$`);
const BRANCH_NAME_EXEMPT = new Set(["main", "beta"]);

export function checkBranchName(name: string): { ok: boolean; reason?: string } {
  if (BRANCH_NAME_EXEMPT.has(name)) return { ok: true };
  if (BRANCH_NAME_RE.test(name)) return { ok: true };
  return {
    ok: false,
    reason: `branch "${name}" doesn't match <type>/<kebab-description> (type: ${BRANCH_TYPES.join("|")})`,
  };
}
```

- [ ] **Step 4: Run the test again, confirm it passes**

```bash
pnpm vitest run tests/unit/scripts/verify-architecture.test.ts
```
Expected: all pass, including the 5 new branch-naming tests.

- [ ] **Step 5: Wire it into the CI runner block (only runs on PR events, exempts push)**

In `scripts/verify-architecture.ts`, inside the `if (isMain) { ... }` block (starts at line 231), after the existing tombstone-check block and before `if (!ok) process.exit(1);` (around line 252), add:
```ts
  const headRef = process.env["GITHUB_HEAD_REF"];
  if (headRef) {
    const branchCheck = checkBranchName(headRef);
    if (!branchCheck.ok) {
      console.error(`✗ BRANCH NAME: ${branchCheck.reason}`);
      process.exit(1);
    }
    console.log(`✓ branch-name: "${headRef}" OK`);
  }
```
(`GITHUB_HEAD_REF` is only set on `pull_request` events, so a direct push — e.g. to `main` itself — never trips this check; only PR branch names are gated.)

- [ ] **Step 6: Run the full verify-architecture check locally to confirm no regressions**

```bash
pnpm verify:arch
```
Expected: `Architecture gates green.` (no `GITHUB_HEAD_REF` is set locally, so the branch-name block is a no-op here — this is expected and correct).

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-architecture.ts tests/unit/scripts/verify-architecture.test.ts
git commit -m "feat(ci): enforce <type>/<kebab-description> branch naming, no agent-namespaced prefixes

Branch names encoded who typed the command (cursor/, gemini/, claude/)
instead of what the change does — git author already records who;
the name should say what. Gated on PR events only via GITHUB_HEAD_REF,
main/beta exempt."
```

Report DONE with test output.

---

## Task 9: Consolidate the rulebook — `docs/RULES.md`, trim duplicated tails, fix the Git-policy contradiction

**Files:**
- Create: `docs/RULES.md`
- Modify: `CLAUDE.md` (lines 250-267 "## Git" section, lines 275-294 duplicated tail)
- Modify: `AGENTS.md` (lines ~40-125 "Git / PR policy" section, lines 172-195 duplicated tail)
- Modify: `GEMINI.md` (lines 43-66 duplicated tail)
- Modify: `docs/process/BRANCH-MODEL.md` (add a superseded banner at top)

**Context — read this before editing anything:**

Three files currently disagree about how code reaches `main`:
- `CLAUDE.md:251-252` says "Never commit DIRECTLY to `main`... Flow: work branch → `beta` → `main`" — then the very next bullet (`CLAUDE.md:254`) says "Claude may merge to `main` itself (founder directive, 2026-08-01)... previous rule... removed." **This is CLAUDE.md contradicting itself in adjacent lines.**
- `AGENTS.md`'s "Git / PR policy" section mandates `cursor/* or feat/* → beta → main`, states "Agents never merge to main," and gives a full beta-first PR workflow — directly contradicting CLAUDE.md's founder directive.
- `docs/process/BRANCH-MODEL.md` says "Never commit directly to `main`" and "Agents never merge to `main`. Draft PRs to `beta` only."
- The mechanism that's actually binding — GitHub branch protection on `main` — only requires 2 CI checks (`Type check + lint + wiring`, `Unit + regression tests`). It does **not** require a `beta` hop. Confirmed via `gh api repos/pushkarverma3698/FounderOS/branches/main/protection`.

Resolution (already applied live in this session — Task 6 pushed a PR directly to `main`, per the founder's approval of Spec A retiring `beta` from the required path): **PRs go directly to `main`, gated by the 2 required CI checks. `beta` is no longer a required hop** — it still exists and auto-fast-forwards to `main` via `sync-beta.yml`, but is not on the critical path. This task makes the docs match that reality instead of contradicting it.

Also duplicated **verbatim or near-verbatim across all three of `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`** (confirmed via grep during design): the sections titled "Strategic Mandate," "Content Generation (No AI Slop)," "Implementation Plans & Memory," "Cross-Agent Awareness," and the one-paragraph "Automated Brain Sync" rule inside "End-of-session handoff." Four independently-editable copies of the same rule is exactly the drift this task exists to stop.

- [ ] **Step 1: Create `docs/RULES.md`**

This is the new Tier 1: only rules with a real enforcement mechanism, each line naming that mechanism (per CLAUDE.md's own existing rule #27 — "a rule with no mechanism decays; say which layer holds it"). Write the file with this exact content:

```markdown
# FounderOS — Rules (CI-enforced Tier 1)

Every rule below is enforced by a specific mechanism, named inline. If you can't
name the mechanism, it doesn't belong in this file — put it in the file that
still needs it (CLAUDE.md / AGENTS.md / GEMINI.md) or in the brain
(`turicks_brain`, queried via the `search_knowledge` / `search_memory` MCP
tools) as advisory context instead.

## Architecture (enforced by `pnpm verify:arch` / `scripts/verify-architecture.ts`)

1. **Tombstones** — deleted modules (`office-run.ts`, `execution-guard.ts`,
   `pre-router.ts`, the regex fast-paths, the LLM supervisor, the domain
   subgraphs) fail CI hard if re-created. No ratchet — this is a permanent kill.
2. **Debt ratchet** — `gateway-imports`, `kernel-purity`, `fail-open-catch`,
   `loc-budget` (400 lines/file), `regex-routing` violation counts are pinned
   in `governance/architecture-baseline.json` and may only shrink.
3. **Import direction** — `contracts ← kernel ← gateway`; `src/kernel` may
   import only `kernel/core/db/infra/tools`.
4. **Fail-open catches** need an `// allow-failopen: <reason>` tag on the same
   or preceding line.
5. **Branch naming** — `<type>/<kebab-description>`, type one of
   `feat fix chore docs test ci refactor`. No agent-namespaced prefixes
   (`cursor/`, `gemini/`, `claude/`) — git already records the author.
   Checked against `GITHUB_HEAD_REF` on PR events; `main`/`beta` exempt.

## Kernel invariants (enforced by `tests/unit/kernel/kernel-e2e.test.ts` + code review)

6. **Determinism** — temp 0; routing/parsing/guards are pure, unit-tested
   functions, never prompt instructions. CI runs the golden set twice —
   plans must be byte-identical.
7. **HITL ordering** — DB row written BEFORE `interrupt()`
   (`src/infra/hitl.ts`); side effects only after approval; idempotency key
   checked before every external send; audit row only on real success
   (`src/kernel/tool-adapter.ts` pins this order).

## Git (enforced by GitHub branch protection on `main`: 2 required checks —
## "Type check + lint + wiring", "Unit + regression tests")

8. PRs go directly to `main`. `beta` is not a required hop — it auto-syncs
   to `main` via `sync-beta.yml` but is not on the critical path. (Superseded
   the earlier beta-first ladder — see `docs/process/BRANCH-MODEL.md` for the
   historical version and why it changed.)
9. Never merge on red CI. Branch protection blocks this mechanically.
10. After merging to `main`, verify the deploy actually landed — a merge is
    not a deploy (`git log -1` on the VPS must match). This one has no CI
    mechanism; it is watched by whoever merges, every time.

---

For anything not in this list — coding style rationale, delegation workflow,
prior incidents, business strategy, brand voice — query the brain:
`search_knowledge` / `search_memory` (MCP tools, available to every agent).
This file stays short on purpose; if it needs a second page, something
belongs in the brain instead.
```

- [ ] **Step 2: Rewrite `CLAUDE.md`'s "## Git" section to remove the self-contradiction**

Replace `CLAUDE.md:250-267` (the full `## Git` section, from `## Git` through the `explicit NOT VERIFIED with the reason).` line) with:
```markdown
## Git

See [docs/RULES.md](docs/RULES.md) for the CI-enforced policy (PRs go
directly to `main`, gated by branch protection; `beta` is not a required
hop). This section covers Claude-specific practice on top of that:

- **WATCH THE DEPLOY** after every merge to `main` — verify prod's `git log -1`
  actually matches. A merge is not a deploy; CD silently failing was how
  prod stayed on `a966e9a` for a full day.
- Evidence in every PR: fresh `pnpm gate` output + live-path proof (or an
  explicit NOT VERIFIED with the reason).
```

- [ ] **Step 3: Replace CLAUDE.md's duplicated tail with a pointer**

Replace `CLAUDE.md:275-294` (from `## Strategic Mandate` through the end of the file) with:
```markdown
## Shared operating rules (all agents)

Strategic mandate, content-generation standards, plan storage, and
cross-agent awareness are defined once, in [docs/RULES-SHARED.md](docs/RULES-SHARED.md)
— not copied here. Read it; it applies to Claude the same as every other agent.
```

- [ ] **Step 4: Create `docs/RULES-SHARED.md` with the extracted content**

This is the de-duplicated home for the five sections that were byte-for-byte identical across `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`:
```markdown
# FounderOS — Shared Operating Rules (all agents)

These apply identically to Claude Code, Antigravity/Gemini, and Cursor.
Previously duplicated verbatim across CLAUDE.md, AGENTS.md, and GEMINI.md —
three copies of the same rule is how they drifted apart. One copy now.

## Strategic Mandate (Maximum Output)

We are building a system designed to decisively outcompete the market. You
must ruthlessly prioritize execution speed, shipping revenue-generating
features, and leveraging competitor intelligence over endless internal
theoretical refactoring. If a task does not tangibly move the needle or
provide a market advantage, flag it immediately and pivot to building.

## Content Generation (No AI Slop)

**Mandatory Skill Usage:** Whenever you are generating, preparing, or
drafting any content intended for public platforms (comments, posts,
articles, social media, emails), you MUST use and strictly follow the
`no-ai-slop` skill located at
`/Users/pushkarverma/Projects/githubtools/no-ai-slop/SKILL.md`.
**Why:** Nothing we publish on our platforms should look like AI-generated
content — no overly formal tone, unnecessary emojis, generic corporate
speak, or predictable structures.

## Implementation Plans & Memory

All implementation plans generated by any agent MUST be saved with
organized, descriptive filenames in `docs/plans/` (e.g.
`docs/plans/YYYY-MM-DD-feature-name.md`).
**Why:** Centralized, semantically-named plans drastically improve RAG
retrieval, letting future agents learn from past architectural decisions.
Do not use scratch directories or generic names like `plan.md`.

## Cross-Agent Awareness (the "what is everyone doing?" rule)

Before starting any complex task, research what other agents have recently
worked on:
1. Query `turicks-brain` for recent session summaries (`search_knowledge` /
   `search_memory` MCP tools).
2. List and read the most recent implementation plans in `docs/plans/`.

**Why:** You are part of a swarm. This prevents duplicating work, reverting
deliberate changes, or breaking dependent systems.

**Known gap (2026-08-08):** Claude Code ingests its own session history into
`turicks_brain` via `pnpm ingest:claude`. Antigravity and Cursor do not yet
have an equivalent ingestion path — their session logs are not currently
queryable through the brain. Don't assume `search_memory` surfaces their
recent work until this is built; treat it as a documented gap, not a
guarantee.

## Automated Brain Sync

If you created, modified, or deleted any file in `docs/` during your session
(plans, architecture, or rules), you MUST autonomously run `pnpm brain:sync`
before concluding your task. Do not wait for the founder to do this.
```

- [ ] **Step 5: Trim `AGENTS.md`'s "Git / PR policy" section**

Replace the entire block from `## Git / PR policy (non-negotiable — prevents "not mergeable")` through the line `See \`docs/process/BRANCH-MODEL.md\` for the full ladder.` (this is the beta-first ladder, the contradicting table, and the `gh pr create --base beta` example) with:
```markdown
## Git / PR policy

See [docs/RULES.md](docs/RULES.md) — PRs go directly to `main`, gated by
branch protection (2 required checks). `docs/process/BRANCH-MODEL.md`
describes the earlier beta-first ladder for historical context; it is
superseded.
```

- [ ] **Step 6: Trim `AGENTS.md`'s duplicated tail**

Replace `AGENTS.md`'s `## End-of-session handoff (ALWAYS)` through the end of the file (the "Automated Brain Sync" through "Cross-Agent Awareness" blocks — everything from that heading to EOF) with:
```markdown
## Shared operating rules

See [docs/RULES-SHARED.md](docs/RULES-SHARED.md) — automated brain sync,
strategic mandate, content generation, implementation plans, cross-agent
awareness. Applies to every agent identically; not repeated here.
```

- [ ] **Step 7: Trim `GEMINI.md`'s duplicated tail**

Replace `GEMINI.md`'s `## End-of-session handoff (ALWAYS)` through the end of the file with the same pointer used in Step 6:
```markdown
## Shared operating rules

See [docs/RULES-SHARED.md](docs/RULES-SHARED.md) — automated brain sync,
strategic mandate, content generation, implementation plans, cross-agent
awareness. Applies to every agent identically; not repeated here.
```

- [ ] **Step 8: Add a superseded banner to `docs/process/BRANCH-MODEL.md`**

At the very top of the file, before the `# Branch Model — beta / main` heading, add:
```markdown
> **Superseded 2026-08-08.** PRs now go directly to `main` (branch
> protection is the gate — 2 required checks). `beta` still exists and
> auto-fast-forwards to `main` via `sync-beta.yml`, but is no longer a
> required hop. See `docs/RULES.md`. This document is kept for historical
> context on why the two-stage ladder existed and was later removed.

---
```

- [ ] **Step 9: Verify no other doc references the now-dead `beta`-first flow as current policy**

```bash
grep -rln "Never commit DIRECTLY to \`main\`\|Agents never merge to \`main\`\|Cut branches from \*\*\`beta\`\*\*" --include="*.md" . 2>/dev/null | grep -v node_modules
```
If `CONTRIBUTING.md:69` still says "cut branches from beta," update it to point at `docs/RULES.md` the same way, consistent with the other files (small, in-scope fix — same drift, same file class).

- [ ] **Step 10: Confirm every internal link resolves and nothing was left orphaned**

```bash
pnpm test  # confirm no test reads the trimmed files' removed content
grep -c "^##" CLAUDE.md AGENTS.md GEMINI.md docs/RULES.md docs/RULES-SHARED.md
```
Read through all five modified/created files once, end to end, to confirm no dangling reference to a section that no longer exists, and that the precedence table each file already has (layer 1-5) still makes sense with the new pointers.

- [ ] **Step 11: Commit**

```bash
git add docs/RULES.md docs/RULES-SHARED.md CLAUDE.md AGENTS.md GEMINI.md docs/process/BRANCH-MODEL.md CONTRIBUTING.md
git commit -m "docs: consolidate rulebook — docs/RULES.md (Tier 1, CI-enforced), docs/RULES-SHARED.md (dedup), fix beta/main contradiction

CLAUDE.md, AGENTS.md, and docs/process/BRANCH-MODEL.md disagreed about
whether agents can merge directly to main — CLAUDE.md even contradicted
itself in adjacent lines. Branch protection (the actual binding
mechanism) only requires 2 CI checks, no beta hop; docs now say what's
true. Also de-duplicates 5 sections that were copy-pasted verbatim
across three files into one shared doc."
```

Report DONE with the grep verification output from Step 9, or NEEDS_CONTEXT if `CONTRIBUTING.md` has more beta-first content than the single line found during design (re-read it fully before editing if so).

---

## Task 10: Add `docs/RULES.md` + `docs/RULES-SHARED.md` + `docs/antigravity/STANDARDS.md` to the brain ingest

**Files:**
- Modify: `scripts/sync-turicks-brain.ts`

**Depends on:** Task 9 (the files being ingested must exist first).

**Context:** `sync-turicks-brain.ts` already walks a fixed list of doc paths (`docs/decisions`, `docs/strategy`, `docs/phases`, `docs/architecture`, etc. — see the existing `market-intel` block around line 130 for the exact pattern to copy) and upserts each into `brain.knowledge_entries` + `brain.turicks_brain`. `docs/RULES.md`, `docs/RULES-SHARED.md`, and `docs/antigravity/STANDARDS.md` are not yet in that list — meaning Tier 2 recall (the whole point of Spec B2) doesn't work until this is added.

- [ ] **Step 1: Read the existing `market-intel` block for the exact pattern**

```bash
sed -n '128,145p' scripts/sync-turicks-brain.ts
```

- [ ] **Step 2: Add a block for the three new single-file docs, following the existing single-doc pattern (see the `roadmapDoc` or `brandDoc` blocks, not the directory-walking ones, since these are three individual files, not a directory)**

Add this after the existing `market-intel` block (which Task 3 already committed):
```ts
  // ── Rulebook (Tier 1 CI-enforced + shared operating rules) ─────────────────
  for (const [relPath, entryType] of [
    ["docs/RULES.md", "rules"],
    ["docs/RULES-SHARED.md", "rules"],
    ["docs/antigravity/STANDARDS.md", "standards"],
  ] as const) {
    const fullPath = join(root, relPath);
    if (existsSync(fullPath)) {
      docs.push({
        entry_type: entryType,
        title: titleFromFilename(basename(relPath)),
        content: readFile(fullPath),
        source: relPath,
        tags: ["rules", "governance"],
      });
    }
  }
```
(Match the existing `readFile` / `titleFromFilename` helper names exactly as used elsewhere in this file — grep for their definitions first if the names above don't match exactly.)

- [ ] **Step 3: Dry-run verify the docs are picked up (without touching the live DB)**

```bash
grep -n "docs/RULES.md\|docs/RULES-SHARED.md\|docs/antigravity/STANDARDS.md" scripts/sync-turicks-brain.ts
```
Confirm the three paths appear. Do not run `pnpm brain:sync` in this task — it writes to the real DB and is out of scope for a code-review-gated subagent task; the controller runs it once, later, as part of the end-of-session handoff (`docs/` changed this session, so `pnpm brain:sync` is required per `docs/RULES-SHARED.md`'s own rule — controller's job, not this task's).

- [ ] **Step 4: Run the existing sync-turicks-brain tests if any exist**

```bash
find tests -iname "*sync-turicks-brain*" -o -iname "*brain-sync*"
```
If a test file exists, run it. If none exists, note that in the report — this script has no unit test coverage today, which is a pre-existing gap, not something to fix as part of this task (out of scope; flag it, don't build it).

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-turicks-brain.ts
git commit -m "feat(brain): ingest docs/RULES.md, docs/RULES-SHARED.md, docs/antigravity/STANDARDS.md into turicks_brain

Tier 2 recall (search_knowledge / search_memory) doesn't work for the
rulebook until it's actually in the ingest list. Same pattern as the
existing market-intel block."
```

Report DONE, noting explicitly whether a test file existed for this script.

---

## [CONTROLLER] Final steps after all 10 tasks

- [ ] Run `pnpm brain:sync` once, live (this session modified `docs/` extensively — CLAUDE.md's own end-of-session rule requires this before concluding).
- [ ] Push Task 8-10's commits, open a second PR (`docs/RULES.md` + branch-naming enforcement + brain ingest), watch CI, merge, verify deploy (same discipline as Task 6 — this PR touches `scripts/verify-architecture.ts`, which affects every future PR's CI, so it must be live-verified, not assumed).
- [ ] Dispatch a final code-reviewer subagent over the full diff of both pushes (per subagent-driven-development's closing step) before declaring the session's Spec A + Spec B2 work complete.
- [ ] Use `superpowers:finishing-a-development-branch` to close out.
