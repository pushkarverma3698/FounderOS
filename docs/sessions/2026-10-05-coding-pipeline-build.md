# 2026-10-05 — coding pipeline thin slice, waves 1 and 2

Plan: `docs/plans/2026-10-05-coding-pipeline-thin-slice.md`. Mode: Sonnet builders in their own worktrees, Claude
(Opus) as the only reviewer. Every PR was re-run by the reviewer (RED, GREEN, lint, arch, doc-claims) before it opened.

## What we did

| PR | What | State |
|---|---|---|
| #912 | Post-deploy oracle: `src/tools/oracle.ts`, `oracle-http.ts`, `scripts/post-deploy-oracle.ts` | merged to beta, not wired to deploy |
| #913 | `TaskContract`, `spec-gate.ts`, `pr-evidence.ts` (`verifySpecRed`, `verifyImplementationGreen`, `canMerge`) | merged to beta |
| #914 | Typed `ReviewVerdict` parser + `scripts/eval-reviewer.ts` (10 planted defects, 2 clean PRs) | merged to beta |
| #915 | agent-dispatch fences issue text as untrusted data; pr-brain sweeps only `task/issue-*` or `claude-review` PRs | merged to beta |
| #909 | Composio removed (prod uses gws/gws/direct; prod `integration_accounts` empty) | merged to beta |
| #917 | Spec card and evidence card renderers + `cp:<action>:<nonce>` parser, pure | merged to beta |
| #918 | Contract store, GitHub/vitest collectors, `scripts/pr-evidence.ts` CLI, vitest JSON artifact in CI | merged to beta |

Everything new is behind `AGENT_PIPELINE_V2=1` or unwired. With the flag unset prod behaves as before, except #915
(fence + pr-brain scope) and #909 (Composio gone), which are live once promoted.

## What we fixed

- Untrusted issue text reached the executor prompt unfenced (#915). The fence tag is defanged in every spelling, so a
  body cannot close the fence early.
- pr-brain would have reviewed every open PR once turned on; it now takes only pipeline PRs (#915).
- GitHub `copied` / `changed` / `unchanged` file statuses gave UNKNOWN in the engine; the collector maps them (#918).

## Why

pr-brain was off and missed bugs on #861; #899 dropped testable acceptance criteria; the dispatcher only checked that a
PR existed. The thin slice makes the verifier trustworthy first, so the builder becomes swappable.

## Metrics

- Reviewer replay, dry run on fixtures: 10/10 planted defects caught, 0/2 false blocks (live run not done, ~$50).
- #913: RED 14 failed / 116 on the implementation-less commit, GREEN 116/116.
- #918: a real CI artifact (run 37353510249) maps to 599 passed test files, 0 failed, locked tests found.

## Next: wave 3 (fresh session)

Flow to build, all behind the flag:
1. Coding ask → `dispatch_antigravity_task` opens the issue with `agent:spec` instead of `agent:ready`, ask verbatim.
2. **H — Pass P.** agent-dispatch claims `agent:spec`, runs Claude as `claude-agent` (read-only repo copy, may write only
   the locked test) to emit a TaskContract + test. `runSpecGate` decides PASS/ASK. The dispatcher commits the test to
   `task/issue-N`, pushes, writes a pending record keyed by a nonce, labels `agent:spec-review`, sends the spec card.
3. Gateway `cp:approve:<nonce>` → `writeContractRecord(approved_by: "founder")` → label `agent:ready`.
4. **I — lean executor prompt.** Pure `src/tools/executor-prompt.ts`: TaskContract + cited files + relevant STANDARDS
   sections, ~3–4 KB, stable prefix. agent-dispatch uses it when the issue has a stored contract.
5. PR CI → `scripts/pr-evidence.ts --mode green` → pr-brain `ReviewVerdict` → evidence card → `cp:merge:<nonce>`
   handler calls `canMerge` again with fresh heads, merges with `mergeIdempotencyKey`, HITL row, `action_log` row.
6. **J — oracle on deploy.** After the deploy moves, `deploy.yml` runs `scripts/post-deploy-oracle.ts` for contracts
   with `merged_sha` and posts PASS / FAIL / UNKNOWN on the issue.

Blocker for step 2 on prod: the `claude-agent` user does not exist yet (founder action).

## Outstanding

1. Founder: revoke the classic `ghp_` token pasted in chat on 2026-10-05.
2. Founder: fine-grained token (Contents, Pull requests, Issues) installed for `antigravity` on the VPS.
3. Founder: create `claude-agent` and `/login` once.
4. Founder: `/review` to turn pr-brain on after #915 is on prod.
5. Founder: revoke the Composio API key after #909 is on prod.
