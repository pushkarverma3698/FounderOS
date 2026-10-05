# FounderOS coding pipeline: one engine for /task and /goal on any onboarded repo

> **Amended 2026-10-05:** build the thin slice in [2026-10-05-coding-pipeline-thin-slice.md](2026-10-05-coding-pipeline-thin-slice.md)
> first. This plan stays the target design.
>
> **Status (2026-09-30):** approved by the founder. Order in practice: Step 1 (P0 hardening) lands before
> Step 0's Antigravity build, because the manual trial runs the builder on employer code. Every later step
> ships as its own small PR behind `AGENT_PIPELINE_V2=1`. This replaces the 2026-09-29 pipeline spec, which
> was never merged.

> **Invariant:** models only propose artifacts (a spec, a test, a patch, a verdict, a contract). Only deterministic
> code performs side effects and authorises state changes. Every authorisation is bound to one commit SHA, one
> repo-capability version, and the evidence the contract requires. Three outcomes only: **PASS** ("I know this
> works"), **FAIL** ("I know this failed"), **UNKNOWN** ("I can't establish that this works"). UNKNOWN is never
> converted into PASS, and NOT VERIFIED is an authorisation boundary, not a warning.
>
> **Scope of the promise:** a universal architecture with language-agnostic adapters. v1 ships JS/TS adapters
> (vitest, node:test). Any repo whose stack has adapters and passes onboarding uses the same engine. Everything else
> is BLOCKED with the reason.

## 1. Context

The founder wants to send a task or a goal from Telegram and get back a working PR, reusing the current
architecture and changing only what's broken:

- **Task:** Claude reads the code → spec card + failing test [Approve] → Antigravity builds → code verifies →
  Claude reviews → Evidence card [Merge].
- **Goal:** GoalContract → [Approve plan] → dependent TaskContracts on the same engine → goal-level proof.
- **Vague ask:** a question back, never a guessed plan.

Measured (08-30 → 09-29): 16 Antigravity tasks, **0 real changes merged and kept**. pr-brain made 205 gate attempts
in 14 days, re-reviewing every PR under the founder's account.

Security, verified 09-30:
- The `antigravity` user holds the founder's full GitHub token (`delete_repo`, `admin:org`, `workflow`…) and runs agy
  with `--dangerously-skip-permissions`.
- Claude runs as `founderos`, which has passwordless sudo and reads `/opt/founderos/.env`.

## 2. Layers, and what exists for each

| # | Layer | Built on (existing) | New or changed |
|---|---|---|---|
| 1 | Request | `/task` repo buttons (`task-command.ts`), kernel tool | the ask is filed **verbatim**; the Gemini brief path is deleted; `/goal` and `/repo onboard` are added |
| 2 | Repo capability | allowlist + `registerDispatchRepo` (`action_log` registry) | versioned **Capability Contract**: discovery → proof → activation (§3) |
| 3 | Adapters | — | a language-agnostic interface (§3.4); v1 ships `vitest` and `node:test` |
| 4 | Planning | `claude -p` usage in pr-brain | Pass P as `claude-agent` in a worktree → spec + locked test |
| 5 | Spec gate | — | pure `spec-gate.ts` (§4) |
| 6 | Approval | callback chain + owner guard (`telegram.ts`) | spec / plan / activate / merge cards |
| 7 | Build | agent-dispatch Pass A/B, quota wall, leases | agy commits locally only; the orchestrator pushes |
| 8 | Evidence engine | pr-brain's app-gate pattern (`qa-app.ts` runs before review) | pure `pr-evidence.ts`: `verifySpecRed` / `verifyImplementationGreen` + oracle (§5, §6) |
| 9 | Review | pr-brain's per-head marker, outage handling | read-only Claude; verdict JSON; no pushes; only `task/*` or labelled PRs |
| 10 | Merge authoriser | `action_log` idempotency | `canMerge`, plus a separate human-acknowledgement path for NOT VERIFIED (§6) |
| 11 | Goal orchestrator | — | GoalContract; only sequences TaskContracts and proves done-means (§7) |
| 12 | Memory | `brainIngest` (upsert by `sourceId`) | one sweep writer with provenance; context only (§9) |
| 13 | Observability | `/tasks` (`stateFromLabels`), pr-brain down/up notices, watchdog | live card, timeline, ledger, heartbeats, digest, metrics (§8) |

**Isolation:**
- **Claude** runs as `claude-agent`: no sudo, no `.env`, no GitHub credential, no DB or MCP. It reads a worktree plus
  `context.md` and writes JSON.
- **Antigravity** runs as `antigravity` with its GitHub credential **removed**. It makes local commits only.
- **Orchestrator** (`founderos`) performs every side effect.
- **Worktrees** set `pushurl = DISABLED`.

## 3. Repository Capability Contract (layers 2–3)

`/repo onboard owner/name` (owner only). Two stages, both deterministic, no LLM.

### 3.1 Discovery (GitHub API reads, $0)

- **Stack and adapter:** manifests (`package.json`, `pyproject.toml`, `go.mod`, `pom.xml`…) → the matching adapter.
  No adapter → BLOCKED "no <stack> adapter".
- **Test runner, lint, build commands:** the adapter reads them from the manifest scripts. The pipeline never
  invents a command.
- **CI:** workflow `on:` blocks (does `pull_request` run for drafts?), job and check names, whether any
  `secrets.` / `pull_request_target` / `permissions: write` is reachable from PR-triggered jobs.
- **Risk paths:** a directory scan against the default globs (migrations, auth, payments, deploy, infra).
- **Branch protection:** read from the API. If it's unreadable it's recorded as `unknown`.
- **Base branch**, resolved in this order:
  1. an explicit founder override;
  2. the existing dispatch config;
  3. an unambiguous integration branch.
  "Unambiguous" means ≥ 80% of the last 30 days of merged PRs targeted one branch, or there's only the default
  branch. Otherwise it's **BLOCKED "ambiguous base"**, and the card asks with buttons.
  *Real example:* Oplify has the founder's PRs going to `beta` and teammates' going to `development`. That's
  ambiguous, so the founder picks. The pipeline never guesses from the fact that a branch exists.

### 3.2 Proof (capability = PROVEN, not "seems present")

- **Adapter on real output:** the adapter parses the **latest base-branch CI run** and must identify at least one
  named passing test.
- **Failing-test detection:** the adapter must also parse a failing test. It takes this from historical runs if one
  exists. If none does, the card asks [Run synthetic probe]: a draft PR on `founderos/probe-<ts>` with one failing
  and one passing test. The PR is auto-closed and the branch deleted. This is opt-in per repo, because in employer
  repos teammates can see it.
- **Other proofs:** SHA lineage (the check runs' `head_sha` = the PR head); CI actually running on a **draft** PR
  (from history or the synthetic probe); the oracle marker surviving the runner's stdout handling (from the
  synthetic probe, else recorded as "oracle: assertion-parse only").
- **Result:** every item is ✓ **proven** / ✗ with its reason / ~ unproven.

### 3.3 Levels: authorisation boundaries

| Level | Needs | May run | Merge |
|---|---|---|---|
| **A** fully verifiable | PR CI on drafts, adapter proven (pass + fail), no PR-reachable secrets | all task types whose verification method is proven | normal **[Merge]**, and only when evidence is PASS |
| **B** partially verifiable | build/lint CI proven, tests unproven | `ui` and `ci-bootstrap` only | **no [Merge] button.** Card says "HUMAN VERIFICATION REQUIRED: behaviour NOT VERIFIED" with **[I verified it — merge]**, which writes a separate `action_log` acknowledgement row naming the missing verification |
| **C** infrastructure missing | — | `ci-bootstrap` only | as for B, via the bootstrap path (§3.5) |

`supported_task_types` is derived from proven capabilities only. An unsupported type is refused as "NOT DISPATCHABLE
for <type>: <missing capability>".

### 3.4 Adapter interface (language-agnostic)

```
interface VerificationAdapter {
  id: string                                  // "vitest" | "node:test" | later "pytest" | "go-test" | "junit"
  detect(manifests): DetectResult             // pure
  commands(manifest): {test, lint?, build?}   // read from the repo, never invented
  parseResults(ciLog): TestResult[]           // {file, name, status: passed|failed|skipped, message}
  parseOracle(ciLog): OracleRecord[]          // FOUNDEROS_ORACLE markers, with an assertion-message fallback
}
```

The same shape covers integration, UI (`qa:app`) and deploy-verification adapters. Adding pytest tomorrow means one
adapter plus fixtures; the engine doesn't change.

### 3.5 ci-bootstrap: its own security boundary

The bootstrap loop must not be able to prove itself.

- **CI policy validator (code)** on the proposed workflow. It allows:
  - triggers `pull_request` and `push` to the base only;
  - `permissions: contents: read` only;
  - no `secrets.`, no `pull_request_target`, no self-hosted runners, no `workflow_run` chaining;
  - `uses:` only from a pinned allowlist (`actions/checkout`, `actions/setup-node`, `actions/setup-python`… at fixed SHAs);
  - run steps only as the adapter's detected commands.

  It also rejects any change to existing workflows that removes a check or widens a permission (the
  "can't weaken" rule).
- **Founder approval** of the workflow diff, shown in full on the spec card.
- **After merge:** the capability probe re-runs its **proof** stage independently (§3.2). Only then is the repo
  re-classified A or B. The bootstrap PR itself is never evidence for its own level.

### 3.6 Activation and versioning

- **Activation:** the founder taps [Activate]. That writes an `action_log` row `repo_contract:<slug>:v<n>` with the
  contract JSON and its proofs (the existing "registry is the audit trail" pattern). The hardcoded allowlist stays as
  the outer boundary.
- **Binding:** every TaskContract and GoalContract binds to `contract_version` + `contract_hash`.
- **Re-probe:** on filing, at each stage transition, and daily. If the contract changed, the task goes UNKNOWN
  "capability changed v4 → v5". The spec gate re-runs automatically, and the new version needs the founder's
  [Activate].

**Discovery by hand, 09-30** (the probe must reproduce this):
- FounderOS: vitest, PR CI on drafts ✓, no PR secrets. Base is `beta` (confirmed by the dispatch config).
- oplify-api and oplify-app: node:test, PR CI on drafts ✓, no PR secrets. Base is **ambiguous**: `beta` vs
  `development`. The founder picks.
- Hulda: no CI → **C**.

## 4. TaskContract and spec gate

**TaskContract fields:**
- `ask` (verbatim, inserted by code), `repo` + `contract_version`/`hash`, `task_type`.
- `current_behavior` citing `path:line@base_sha`, `expected_behavior`.
- `scope`, `locked_tests`.
- `checks`: names from the contract; never shell.
- `oracle`, `constraints`, `risk`.
- `limits` {files, lines, deleted_lines, new_dependencies:false}.
- `base_sha`, `spec_commit`, `goal_id?`.

**The spec gate checks:**
- The schema is valid, and `task_type` ∈ supported.
- Citations exist at `base_sha`.
- Scope is valid, and locked tests are the only tests in the test commit.
- `checks` ⊆ contract.
- `effective_risk = model_risk OR contract.risk_paths(scope)`: code raises risk and never lowers it.
- A spec fingerprint keys the budgets.

Only the repo's own CI on GitHub runners executes code. No model-authored command runs on the VPS.

## 5. Outcome oracle

**Shape:** `{id, before:{predicate}, expected_after:{predicate}}`. Example: `before {status:500}` →
`expected_after {status:200, "body.payment_status":"completed"}`.

**Reading and satisfying it:** values are read via `FOUNDEROS_ORACLE` markers, with an assertion-parse fallback;
neither → UNKNOWN. Spec time requires `actual ⊨ before`; build time requires `actual ⊨ expected_after`.

Verification method per type:
- **bugfix:** a reproduction oracle.
- **feature:** an acceptance oracle.
- **refactor:** the full suite green with zero test edits.
- **api:** a contract oracle.
- **migration:** migrate-from-empty + drift + an invariant oracle.
- **ui:** build + screenshots (+ a component oracle on A); **NOT VERIFIED behaviour on B**.
- **ci-bootstrap:** §3.5.

## 6. Evidence engine and merge

**`verifySpecRed`** (test commit):
- Lineage holds.
- The locked-test check fails, with **only locked tests failing on their assertion**.
- All other required checks pass.
- `actual ⊨ before`.
- Otherwise FAIL, or UNKNOWN.

**`verifyImplementationGreen`** (head):
- Lineage holds; all required checks pass.
- Locked tests **passed** (not skipped or absent), and byte-identical.
- `actual ⊨ expected_after`.
- Scope and limits hold: no deleted tests; no CI, test, lint or script changes; no new dependencies.
- Base, branch and contract version are current, and risk is recomputed on the diff.

**Unrelated failures** get one automatic rerun. A base that is also red → UNKNOWN "base red", and no attempt is used.

**`canMerge`** (A only):
- Green PASS for head H, APPROVE for H.
- A fresh re-fetch still shows H, the same base, green checks and the same contract version.
- Then merge, idempotently keyed on `merge:<repo>#<pr>@<H>`.

**B/C and NOT VERIFIED items** never produce [Merge]. The founder gets only **[I verified it — merge]**, which
records the acknowledgement as its own `action_log` row.

## 7. GoalContract (layer 11)

```
GoalContract {
  goal (verbatim), done_means[]            // machine-checkable predicates, same oracle shape
  tasks[] (TaskContract stubs), dependencies[] (task → task)
  repo_contracts[] (repo + version)
  completion_evidence[]                    // which checks or oracles prove each done_means item
}
```

- **Planning:** Claude proposes it. A goal gate (code) validates that every task stub is supported by its repo
  contract, the dependencies are acyclic, and every `done_means` item maps to a verification method.
  - An item that can't be mapped makes the plan card show "Goal completion: NOT VERIFIABLE, human confirmation
    required" before approval.
  - Where possible, the goal-level acceptance test is locked into the last task that touches that behaviour, so it's
    proven by the same evidence engine.
- **Running:** after [Approve plan], tasks run in dependency order. Non-risky specs are pre-approved; risky ones get
  a spec card. Every PR gets its own merge action.
- **Completion:** **GOAL VERIFIED = every task merged + every done_means predicate PASS on the integration branch**.
  Tasks merged but a predicate UNKNOWN/FAIL → "Goal NOT VERIFIED: <item>". The goal is never declared complete
  because its children merged.
- **When goals switch on:** only after 3 consecutive verified, merged tasks.

## 8. Tokens, failures, observability

**Tokens:**
- pr-brain touches only pipeline `task/*` PRs, or PRs labelled `claude-review`.
- A review runs only after Green PASS, once per head.
- Claude can't push.
- Budgets per spec fingerprint: plan 1 + 2 re-plans, build ≤ 3, review ≤ 3, $15/task.
- Same failure fingerprint twice → `agent:stuck`.
- Every run has `--max-budget-usd`, and JSON costs go to a ledger.
- A $25/day cap → `agent:paused`.
- Probes, gates, cards, merge and memory are all code.

**Failures:**
- Claude down → the existing `enter_down`/`leave_down`.
- Antigravity quota → the existing `QUOTA_FILE`.
- agy missing or auth expired → a new `agent-dispatch.down`.
- Paused over 2h → [Build with Claude] (a tap).
- Retries get a structured payload.
- Conflicts or a moved base/head → a counted rebuild.
- Reboots are covered by kick files and the 45-minute lease.
- Double taps → guard + idempotency.
- Only owner comments count as edits.
- Callback data is `mg:<repoIdx>:<n>:<sha8>`.

**Visibility:**
- One live card per task, and one per goal, edited in place.
- An issue `<!-- timeline -->`.
- `/tasks` shows tasks, goals, contracts (level, version, proofs), pauses and heartbeats.
- A stale-heartbeat alert, and a 09:00 digest.
- Metrics (verified-PR rate, retained-change rate, ask → verified time, cost per retained change) by repo, level,
  type and builder.

## 9. Memory

- **Writer:** one sweep, `syncTaskBrainRows()`. `sourceId` is `task:…`, `goal:…` or `contract:…`.
- **Trust:** a fact is `verified: true` only with a gate-checked `path:line@sha`. Brain hints reach Pass P as
  unverified `context.md`, and a code claim needs a verified citation.

## 10. Build order (small PRs, failing test first, `pnpm gate` green each time; flag `AGENT_PIPELINE_V2=1`)

| Step | Work | Est. |
|---|---|---|
| 0 | Manual trial: Oplify CORS 500 bug. RED/GREEN, node:test output, oracle markers, agy pass rate, `total_cost_usd` | 0.5 d |
| 1 | P0 hardening: pr-brain scope, cap and ledger; pause the old loop; remove the builder's GitHub credential; `claude-agent` + sudoers; worktree `pushurl` | 1 d |
| 2 | Kick: systemd `.path` (the bot keeps `NoNewPrivileges`) | 0.5 d |
| 3 | Capability: adapter interface + vitest/node:test adapters + discovery + proof (history first, synthetic opt-in) + levels + activation/versioning | 3 d |
| 4 | Verbatim filing against the active contract | 0.5 d |
| 5 | Spec gate + evidence engine, adversarially tested | 2.5 d |
| 6 | Pass P + spec card | 1.5 d |
| 7 | Build → review → Evidence card → `canMerge` / acknowledgement path | 2 d |
| 8 | Observability + memory | 1.5 d |
| 9 | ci-bootstrap (CI policy validator + re-probe) | 1 d |
| 10 | GoalContract + goal gate + goal completion (after 3 verified merges) | 2 d |

**Total ≈ 16 working days.** The first usable result (one verified Oplify task from Telegram) comes after step 7,
about 11.5 days in.

**Deferred on purpose:**
- Non-JS adapters: the interface is ready, and they're added per repo need.
- Staging replay (needs the revision fix), an AST scope engine, builder network firewalling, JUnit output.

## 11. Verification

**Unit ($0):**
- The adapter contract suite, run for every adapter: pass, fail, skip, oracle marker, suppressed stdout.
- Discovery against fixtures of all four real repos, plus synthetic ones (draft-filtered CI, `pull_request_target`,
  PR secrets, an ambiguous base → BLOCKED, no CI).
- The proof stage with historical-run fixtures.
- The CI policy validator: secrets, `write` permissions, unpinned `uses:`, removed checks.
- Spec gate, the goal gate (cyclic dependencies, an unmappable `done_means`), both evidence modes.
- `canMerge`, and the B acknowledgement path, which must never render a normal [Merge].
- Budgets, the fingerprint stop, pr-brain selection, brain provenance.

**Hardening proofs (VPS).** As `antigravity` and `claude-agent`, each of these must be empty or fail:
- `gh auth status`
- the git credential helper, `~/.git-credentials`, `~/.ssh/id_*`, `ssh-add -l`
- a GitHub token in the environment
- `git push` from a worktree
- `sudo -n true`
- reading `/opt/founderos/.env`

**Real path:**
1. `/repo onboard` on all four repos. The expected result: FounderOS A; the two Oplify repos BLOCKED "ambiguous base"
   until the founder picks, then A after the proof passes; Hulda C.
2. One live `/task` for the trial bug via `scripts/telegram-probe.ts` from the VPS. Check that:
   - the spec card shows `before ⊨ {status:500}` and a right-reason RED;
   - the claim happens within a minute of [Approve];
   - the live card updates as it goes;
   - the Evidence card shows `after ⊨ {status:403}`;
   - [Merge] merges and writes an `action_log` row;
   - the ledger matches the costs;
   - brain provenance is set;
   - no other PR was gated.

Anything not exercised is reported as NOT VERIFIED, with the reason.

## Files

- **Gateway:** `src/gateway/{task-command,telegram,tasks-command}.ts`; new `src/gateway/{coding-cards,repo-onboard}.ts`.
- **Tools:** `src/tools/{dispatch-antigravity,dispatch-repos,dispatch-tick,antigravity-status}.ts`.
- **New tools:** `src/tools/{repo-capability,ci-policy,spec-gate,goal-gate,pr-evidence,goal-orchestrator}.ts`,
  `src/tools/adapters/{index,vitest,node-test}.ts`, `scripts/pr-evidence.ts`.
- **Also changed:** `src/db/queries.ts`, `src/agents/agent-tools/{antigravity,antigravity-followup}.ts`,
  `src/kernel/planner.ts`, `src/infra/scheduler.ts`.
- **Deploy:** `deploy/agent-dispatch`, `deploy/vps-daemons/pr-brain`; new
  `deploy/systemd/founderos-dispatch-kick.{path,service}` and `deploy/sudoers.d/claude-agent`; `deploy/deploy.sh`,
  `scripts/apply-prod-env-overrides.sh`.
- **Docs:** `docs/antigravity/{agent-task,ISSUE-DRIVEN-CONTRACT}.md`.

## Founder actions (cannot be done by an agent)

1. `/login` once as `claude-agent` on the VPS.
2. Create a fine-grained PAT for the dispatchable repos for the orchestrator.
3. **Revoke** the all-scope token once the replacement works: it was readable by the builder, which runs with
   skip-permissions.
4. Pick the Oplify base branch (`beta` or `development`). Tap [Activate] per repo. Say yes or no to synthetic probe
   PRs in the Oplify repos. Decide on Hulda `ci-bootstrap`.
