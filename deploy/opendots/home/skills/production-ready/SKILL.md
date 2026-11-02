---
name: production-ready
description: Criteria for Full-depth code changes, the ones that touch money, auth, tenant isolation, secrets, schema or prod data, webhooks or external contracts, concurrency/queues/time, or deploy/infra. Lite changes follow the shorter process in AGENTS.md.
---

# Production-ready criteria

Done means: **a real run of the product shows the right outcome, tests prove it stays that way, and a reviewer can merge the PR without redoing any of it.**

The target is not "no bugs"; no pipeline gets there. It is: **the branch that deploys only takes changes that passed these gates, it is always deployable, and anything that escapes is seen and reverted within minutes.** 

Work from a fresh session: derive everything from the repo and the task itself (code, git history, docs in the repo, the running system).

As an intelligent agent, you are trusted to dynamically determine the best workflow to meet these criteria. Ensure all of the following requirements are satisfied before concluding your work:

## 1. Orientation & Scoping
- Define the outcome, the binding constraint, and whether your proposed change moves it.
- Work off the correct base branch; avoid committing directly to `main`.
- Understand the code paths end-to-end (entry point → service → DB → client).

## 2. Code Quality & Correctness
- Write failing tests first for each behavior or bug variant (sequential, concurrent, legacy data, boundary values).
- Apply the smallest change at the root cause.
- Default to secure practices: validate at boundaries, ensure idempotency on external ids, use transactions for races, and never silently drop money, data, or errors (record + alert + tell the user).
- For schema changes, ensure a migration file is present, the client is regenerated, and it is applied to local/test DBs.

## 3. Comprehensive Testing
- Run CI's exact test commands and ensure all tests pass (no unexplained flakes). 
- Ensure your changes are protected by tests. Consider edge cases (e.g., if a guard is removed or bypassed, does a test fail?).
- Never make paid/live API calls in tests (mock or sandbox).
- Address any pre-existing failures on the base branch separately.

## 4. Adversarial Review
- Review your own diff as a hostile reviewer.
- Ensure every caller of changed functions still behaves correctly. 
- Ensure new status/enum values are handled by all consumers (API, webhooks, jobs, UI, and fallback paths).
- Check for security vulnerabilities: authz on every path, input validation, and no leaked secrets.

## 5. Manual QA
- Do not trust tests alone. Run the actual product locally against real dependencies (sandbox/test mode) or a real browser for UI.
- Verify happy paths, negative paths, and boundary conditions.
- If applicable, check version skew (e.g., new server + old client, old server + new client) and time-based events (move the clock forward).
- Gather evidence of manual QA (e.g., command outputs, logs) for the PR.

## 6. Prod-Ready Readiness
- Document any new environment variables or secrets required.
- Ensure required third-party settings (webhooks, dashboard callbacks) are correct.
- Verify observability: ensure failures will produce a log/alert that a person will see.

## 7. Delivery & PR
- Scan the diff for secrets.
- Open a draft PR to the integration branch.
- Structure the PR body clearly:
  - Summary (what/why)
  - Changes
  - Verification (Automated and Manual QA evidence)
  - Prod-ready checklist / Deploy notes
- Ensure CI runs and passes on the PR head commit. 
- Merge only when the founder asks or the repo's own rules allow it. After merging, verify the deploy completed and perform a smoke test.

## Shared Brain Updates
- Before reporting completion, save decisions (`save_decision`) and root-caused bugs (`save_bug`) via the `turicks-brain` MCP. One durable fact per call.
