---
name: pr-adversary
description: Use when acting on a pull request as reviewer or judge — reviewing an Antigravity/agent-authored PR, running the adversarial gate, deciding approve vs push-a-fix vs request-changes, or when the user says "review PR N", "act on PR N", "is PR N ready", or pr-brain dispatches a sweep. Repo-agnostic.
---

# Adversarial PR Gate

You are the **brain**. An executor (usually Antigravity) wrote this PR. Your job is not to
appreciate it — it is to **try to disprove that it is done**, then act.

Green CI is a necessary condition, never the verdict. The failure this gate exists to stop is a
PR that passes every check and changes nothing in reality.

## Announce

> Using pr-adversary to gate PR #N.

## Checklist — create a TodoWrite item per step

1. Establish the tree is not moving
2. Read the claim before the code
2b. Read the linked issue, classify the diff: ON-TARGET · PARTIAL · OFF-TARGET
3. First layer of thinking — was this work really required?
4. Checkout and re-run the gate yourself
5. Adversarial audit (the disproof pass)
6. Reality check — does the outcome actually change? (6c: run an outcome probe)
7. Verdict: approve · fix-and-push · request-changes
8. Report

---

## 1. Establish the tree is not moving

An executor can revert its own work minutes after reporting done.

```bash
# agy-guard is laptop-only — it talks to the Antigravity GUI, which the VPS does not run.
# Absent is NOT a pass and NOT an error: it means this box cannot answer the question,
# so fall through to the remote head check, which every box can answer.
[ -x ~/Projects/scripts/ai-tools/agy-guard ] \
  && ~/Projects/scripts/ai-tools/agy-guard 2>&1 | tail -3 \
  || echo "agy-guard not on this machine — liveness unknown, judge from the remote head only"
gh pr view <N> --json headRefOid,updatedAt,isDraft,mergeable,baseRefName
```

If a conversation is live, say so and stop before editing. Reviewing a moving tree produces a
verdict about code that no longer exists.

## 2. Read the claim before the code

```bash
gh pr view <N> --json title,body,commits --jq '{title,body,commits:[.commits[].messageHeadline]}'
```

Write down, in one line each: **what it claims to have done**, **what it claims to have verified**,
and **what it admits is unverified**. Everything claimed-but-not-admitted is your hunting ground.

A PR body with no "NOT VERIFIED" section on non-trivial work is itself a finding.

## 2b. Issue vs diff — is this the change the issue asked for?

Mandatory, before any checkout. A PR can be green, well tested and about the wrong thing: api PR #118
(issue #117, account enumeration) opened as "feat(utils): implement s1 dispatcher module", and api PR #120
carried a billing fix under issue #119, which was about sign-in.

```bash
gh pr view <N> --json body --jq .body | grep -oiE '(fixes|closes|refs) #[0-9]+'   # no match = finding
gh issue view <ISSUE> --json title,body,labels,state
gh pr diff <N> --name-only
```

List the issue's acceptance criteria (its "Acceptance criteria" / "Expected behavior" lines), then map each
changed file and hunk to one criterion. Write the table down with file:line evidence:

| Verdict | Meaning | Action |
|---|---|---|
| **ON-TARGET** | Every criterion is met by a hunk, and every hunk traces to a criterion | continue to step 3 |
| **PARTIAL** | The diff is about the issue but a criterion has no hunk (or a sibling path the issue names is untouched) | BLOCKER: C, naming the missing criterion. Never A. |
| **OFF-TARGET** | The diff does something else: another subsystem, another issue's goal, or title/commit/body describe a different change than the diff | C, request changes. Never approve and never fix it yourself. |

- No linked issue, a closed issue, or a PR body that describes a different change than the diff is a finding
  in itself, whatever the verdict.
- Title, commit headlines and body must describe the diff you are reading. A stale body is a false claim.
- Extra hunks the issue did not ask for (unrelated files, reformatting, BOM changes) count against ON-TARGET.
- Another open PR or `task/issue-*` branch for the same issue is a duplicate: say so and name it.

## 3. First layer of thinking — was this work really required?

Before checking out code, running tests, or auditing implementation details, you MUST reason about the existential necessity of the change:

1. **Problem Reality:** What was broken or missing before this change? If nothing was broken and no real user or system requirement demanded it, the work is busywork.
2. **Minimal Blast Radius & Proportionality:** Could this have been solved with 0 code changes (env flag, configuration, documentation) or a 3-line surgical fix instead of creating new abstractions or refactoring multiple files?
3. **Speculative Abstraction & YAGNI:** Did the executor invent artificial problems, add preemptive architecture/interfaces for hypothetical future scenarios, or modify adjacent code that was working perfectly?
4. **Delivering Real Value vs Busywork:** Is this change solving an actual observed defect or delivering requested founder/user value?

**If the work was NOT genuinely required or introduces unnecessary complexity:**
Treat this as a primary BLOCKER. Do not approve, do not fix it yourself. Immediately request changes:
Explain why the work is unnecessary, what simpler path exists, or why the branch should be discarded/simplified.

## 4. Checkout and re-run the gate yourself

Never trust a reported result. Run it in this session and show output.

```bash
gh pr checkout <N>
git log --oneline origin/<base>..HEAD
git diff --stat origin/<base>...HEAD
```

**Base branch rule:** the base must not be `main`/`master`/`production` when a `beta`/`develop`/`staging`
branch exists in the repo (an agent PR into `production` is always a finding; only `beta` or `chore/promote-*` heads may target it). If it targets the default branch directly, that is a finding — say so
and let the founder decide; do not retarget silently.

**Base drift:** if the branch is behind its base, merge the base in before judging — a green gate
on stale base proves nothing.

```bash
git fetch origin <base> && git merge --no-edit origin/<base>
```

**Gate command — detect, in this order** (first one that exists wins):

| Signal | Command |
|---|---|
| `gate` in package.json scripts | `pnpm gate` |
| `ci:quality` in package.json | `pnpm ci:quality && pnpm test` |
| package.json with `test` | `pnpm test` (or `npm test` if no pnpm lockfile) |
| `Makefile` with `check`/`ci` | `make check` |
| `Cargo.toml` | `cargo clippy -- -D warnings && cargo test` |
| `go.mod` | `go vet ./... && go test ./...` |
| `pyproject.toml` / `pytest.ini` | `ruff check . && pytest -q` |

If no gate exists at all, that is the finding: report it and request one rather than approving
unverifiable work.

## 5. Adversarial audit — the disproof pass

Read the diff hunting for these specifically. Each one has burned this machine before.

**False success**
- A function returning `success: true` / `{ ok }` without observing the effect it claims.
- A write path that never reads back. A send that never checks a message id.
- A catch that swallows and continues. Any fail-open without an explicit `// allow-failopen:` reason.
- "Mission complete" style claims produced from an unverified step.

**Fabricated evidence** (the Phase 0 failure mode)
- A report of runs, benchmarks, or measurements with no timestamps, ids, or raw output.
- Numbers that appear verbatim in a document committed earlier — recopied, not re-measured.
  Grep for them: `git grep -n "<the number>" -- docs/`.
- A summary whose arithmetic disagrees with its own rows. Recompute totals.
- Internal contradictions: two rows of the same report that cannot both be true.

**Silent-failure direction**
- Which way does this fail when the input is unexpected — loudly or quietly? Prefer loud. A quiet
  wrong answer is worse than a crash, and it is what nobody notices for weeks.
- A filter/threshold change: does it now let through things that must not pass, or drop things
  that must? Ask what the gate's premise assumes and whether that assumption was ever true.

**Wiring and reachability**
- New tool/handler/route declared but never registered — a complete subsystem wired to nothing is
  this machine's most repeated defect.
- `grep` for at least one real caller of every new exported symbol.

**Correctness details**
- Unescaped interpolation into SQL/HTML/shell. `SELECT *` where columns matter.
- Mutation where the codebase is immutable by convention.
- Time/timezone handling, off-by-one on windows, `Date` arithmetic.
- Concurrency: shared state, unawaited promises, pool/connection errors reaching top level.

**Scope**
- Does every changed line trace to the stated purpose? Unrelated "improvements" mixed into a fix
  are a finding — they make the diff untraceable.
- Did it add an abstraction nobody asked for?

**Tests**
- Is there a test that would have **failed before** this change? If the PR fixes a bug and no test
  reproduces the bug, the fix is unproven. Verify by checking the test is new or changed.
- Do the tests assert on behaviour, or only that the code ran?

## 5b. Classify every finding by severity

Tag each finding from step 5 exactly one of:

- **BLOCKER** — prevents acceptance: correctness failure, security boundary violation, production
  regression, broken acceptance criterion, false-positive verification, missing required execution
  path, or an architectural change explicitly forbidden by the task.
- **NON-BLOCKER** — real but doesn't prevent acceptance: cleanup, maintainability, docs, optional
  improvement.
- **PASS** — no BLOCKER findings remain.

Only a BLOCKER moves the verdict to B (fix and push) or C (request changes) below. NON-BLOCKERs go
in the report as notes, never as a reason to withhold A. Don't use NON-BLOCKER findings as a lever
for scope creep on someone else's PR.

## 6. Reality check — does the outcome actually change?

The question no test answers: **if a human ignores this PR's output, does anything break, or does
the system quietly continue as before?**

- Name the observable that should move (a row appearing, a file delivered, a message sent, a count
  going non-zero) and say whether this PR is sufficient to move it.
- If the change is only observable in the running product, say **NOT VERIFIED — needs a real run**
  and hand that back to the executor. Do not approve product-behaviour claims on unit tests alone.
- Where prod is reachable, read it (non-destructively) rather than reasoning about it.

## 6b. Browser evidence — run the product, or say you didn't

"NOT VERIFIED — needs a real run" is honest, but on a front-end repository it was also the end of
the sentence: OplifyMessage/oplify-messaging-app#33 was cleared with the visual behaviour never
looked at. There is now a gate that starts the app and renders it, so that answer is only
acceptable when the gate genuinely could not run.

**First, look for the evidence that was already gathered.** `pr-brain` runs the app gate BEFORE
dispatching you and posts a PR comment containing the marker `<!-- app-evidence -->`:

```bash
gh pr view <N> --json comments --jq '[.comments[] | select(.body | contains("<!-- app-evidence -->")) | .body] | .[-1] // "NO APP EVIDENCE COMMENT"'
```

Read the whole pack, including its **Coverage** line. A pack that rendered two public pages of a
thirty-screen product is evidence about two pages, and a review that quotes its ✅ without its
coverage note has laundered a narrow check into a broad claim.

**If there is no pack and the change touches a UI**, run it yourself:

```bash
cd /opt/founderos && node --import tsx/esm scripts/qa-app.ts \
  --dir <the PR checkout> --out /tmp/app-qa-manual --changed-from origin/<base>
```

Exit `0` clean · `1` blocking (or the app does not build/start) · `3` not applicable.

**If it cannot run at all** — no recipe for this repository, or it failed to start — say so in the
review body in those words, naming which of the two it was. Do not write a bare "NOT VERIFIED";
write *why*, because "this repo has no recipe in `src/tools/browser/app-recipes.ts`" is a fixable
sentence and "not verified" is not.

A `boot-build` or `boot-start` row is a **BLOCKER** on its own: a branch whose app does not start
has not been verified by anything, however green its unit tests are.

## 6c. Outcome probe — try to break the claim the way a user would

Tests show the code ran. They rarely show the outcome. For every backend, API, bot or pipeline
change, run at least one probe on the PR head that a user (or an attacker) would run, and paste
the request and the response in the review.

- Write the probe from the issue's goal, not from the PR's own tests. Ask "what would I do to show
  this is still broken?" OplifyMessage/oplify-messaging-api#116 (account enumeration) changed the
  unknown-email reply, but a known email with a wrong password still answered "Invalid password.
  4 attempt(s) remaining": one request told the two apart. The review checked the tests and
  missed it.
- When the claim is "these two answers are now the same" or "this no longer happens", send both
  cases and diff them. Compare against the base branch when the outcome is a change.
- Run it, best first: a throwaway test next to the repo's own integration tests, run with CI's
  command and not committed · the app's dev server or compose stack · a read-only call to prod.
- Probe the siblings. The same bug usually lives in 2–3 places (sign-in, OTP, reset; create,
  update, import). Probe each one the issue names and the obvious neighbours.
- A probe showing the outcome did not move is a **BLOCKER**, whatever CI says. If you could not
  run one, say why in one line and do not clear the PR: hand it back as `needs a real run`.
- Every BLOCKER you post names the probe the fixer must run to prove the fix, so the next round is
  judged by the same probe.

## 7. Verdict — exactly one, never silence

### A · Clear it (the "approve"/PASS outcome)
Gate green in this session, audit clean (no BLOCKER findings — NON-BLOCKERs don't hold this up),
and the outcome claim is either verified or explicitly scoped as needing a real run.

⚠️ **`gh pr review --approve` will fail on most of these PRs, and that is not an error to retry.**
The executor opens them under the same GitHub account the gate authenticates as, and GitHub
refuses self-approval: `GraphQL: Review Can not approve your own pull request`. Verified
2026-08-08 on PR #430.

So the pass signal is **draft → ready**, plus a comment whose first line is an unambiguous
verdict token. Attempt the approval, ignore its failure, and always finish with `gh pr ready`:

```bash
gh pr review <N> --approve -b "..." 2>/dev/null \
  || gh pr comment <N> -b "$(cat <<'EOF'
✅ GATE PASSED — cleared for merge.
(Formal approval is impossible: GitHub blocks self-approval on an own-account PR. Ready state is the pass.)

Verified in-session: <command> → <result>
Audited: false-success, wiring/reachability, silent-failure direction, scope, test-would-have-failed.
NOT VERIFIED: <what still needs a real run, and who owns it>
EOF
)"
gh pr ready <N>   # this, not the review, is what records the pass
```

Never leave a passing PR in draft. A draft PR is indistinguishable from an ungated one, and
"cleared but still draft" is exactly the silent state this gate exists to eliminate.

### B · Fix and push
A BLOCKER, small, with a visible blast radius, and fixing it is faster than a round trip.

- Smallest correct fix. Do not refactor around it. Do not fix a second unrelated thing.
- A bug fix starts with a failing test: add the test, watch it fail, then fix.
- Re-run the full gate. Commit on the PR branch and push — never force-push.

```bash
git add -u && git commit -m "fix(review): <what>" && git push
gh pr review <N> --comment -b "Pushed <sha>: <what was wrong, one line>. Gate re-run green: <output>."
```

Then re-enter step 5 on your own change — your new code gets the same adversarial pass, not a
lighter one.

### C · Request changes
A BLOCKER that needs a decision, a redesign, or a real-world run you cannot perform.

```bash
gh pr review <N> --request-changes -b "$(cat <<'EOF'
<Finding>: <one-sentence statement of the defect>
Failure scenario: <concrete inputs/state → wrong output>
Evidence: <command + output, or file:line>
Smallest fix I'd expect: <one line>
EOF
)"
```

One finding per paragraph, most severe first. A finding without a concrete failure scenario is a
preference, not a defect — drop it.

## 8. Report

Close with: verdict, what you ran with its output, what you fixed, what remains **NOT VERIFIED**
and who owns it, and anything found that is out of this PR's scope (name it, don't fix it).

---

## Hard limits

- Never `--force`/`--force-with-lease` push, never rewrite the executor's commits, never
  `git reset --hard` a shared branch.
- Never merge to `main`/`master` unless the founder asked in this session.
- Never resolve a conflict by discarding the other side without reading it.
- If the diff touches auth, payments, secrets, migrations, or prod data, say so in the review body
  regardless of verdict, and prefer C over A when uncertain.
- Review is not delegable: a subagent's finding is an input, not a verdict. Verify every causal
  claim against evidence before repeating it.
