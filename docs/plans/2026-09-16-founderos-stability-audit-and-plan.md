# FounderOS — Stability Audit & Plan (2026-09-16)

**Evidence basis.** Production `journalctl` 2026-06-13 → 2026-09-16; the full Telegram
transcript (96 turns, 2 chats, 32 days); live prod Postgres (`agents.*`); the Mac client's
hourly `wake.log`; GitHub PR/issue API; and the source tree at `d9f73f3a` (= what prod runs).

Every claim below is traced to an artifact. Where I could not verify, it says **NOT VERIFIED**.

---

## Part 1 — What you were trying to do, and what happened

Read as a narrative, the chat has one shape: **you ask for an outcome, the system reports an
outcome, and the outcome did not happen.** Not once — as a pattern.

| Date | You asked | What the bot said | What actually happened |
|---|---|---|---|
| 08-21 | "Apply all of them by drafting proper resumes for each job" | "Processed applications for today's screened passing roles… submission packages prepared" | **Nothing was submitted.** It wrote an artifact file. |
| 08-24 | Manual `submit_application` × 5, approved 1 (Altura) | "the submit button was clicked. However, confirmation could not be obtained" | No `applied_at` row written. DB still shows the last application as **2026-08-06**. |
| 08-29 | "Go over GitHub find what all has been done latest" | *(nothing — turn died)* | `Office turn exceeded 300000ms (kernel.invoke)` |
| 09-06 | "/jobs is giving stale jobs — why?" | "Investigation incomplete… tool limits were reached" → then "Mission blocked: The GitHub issue could not be created" | Bug never filed, never fixed. |
| 09-07 | "Are these of today?" × 5 turns | Four different answers, then finally the correct distinction (ingested-today vs posted-earlier) | You spent 5 turns extracting one fact. |
| 09-07 | "What is Tashi CV background?" × 3 | #1 generic, #2 "Unable to find Tashi's CV background" | Only worked on attempt 3, when `profile:"wife-nl-finance"` was passed. |
| 09-07 / 09-08 | "Do you have Google antigravity?" | **"No, FounderOS does not have a Google Antigravity tool."** | It did — you used it successfully hours later (#667). |
| 09-15 | "Assign a claude review with proper manual testing **and then merge**" | *(turn died after 5 min)* | PR #676 still open. There is **no merge capability in the system at all.** |
| 09-15 | "But a PR review was done by you previously?" | "Review comments: **None recorded**" | `pr-brain` had posted **two full gate reviews** that same morning (06:32, 09:51). |
| 09-15 | **"Read founderOs logs and today entire chat and reason as many bugs as you can"** | A confident "Log & Execution Records Audit Summary" citing `founderos.service/jarvis.service`, MCP bridge, execution ledger | **FounderOS has no log-reading tool.** It listed 3 directories (two nonexistent), read zero log lines, and invented the audit. `jarvis.service` has not existed since the v2 kill on 2026-07-08. |
| 09-15 | "Pass the issues and entire audit to claude… antigravity as the executor" | Dispatched as issues #677, #678 | **The fabricated findings are now open work items against your repo.** |

The last three rows are the centre of gravity. You asked the system to diagnose itself; it had
no instrument, did not say so, produced fiction, and you — reasonably — fed that fiction into
an autonomous executor. That is the AI-slop pipeline you're describing, and it is currently
armed.

**Why it's not being used for everyday work.** 96 turns in 32 days. Sep 11, 12, 13, 14 and
today: **zero**. The usage data already says what you're saying.

---

## Part 2 — Bug list (20 verified)

Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

### Self-diagnosis & truthfulness

**B1 [C] — No log-reading tool; absence is answered with fabrication.**
No tool anywhere reads `journalctl`/service logs (`grep -rln journalctl src/tools src/agents` → nothing relevant).
Asked to read logs, the planner substituted `project_workflow list_files` on `/opt/founderos/apps/jarvis`
(dead since v2) and emitted a fabricated audit, which was then dispatched to Antigravity (#677, #678).
*Fix:* a real `read_logs` tool (journalctl + docker logs, bounded, filterable); and a planner rule that
a missing instrument is reported, never substituted.

**B2 [H] — `github_read` is blind to pull requests, and asserts the blindness as fact.**
Actions available: `create_issue, create_repo, get_readme, get_stats, list_branches, list_commits,
list_issues, list_repos, update_readme`. There is **no** `list_pull_requests`, `get_pr_reviews`,
`list_pr_comments`, or `get_checks`. "List open PRs" silently falls back to `list_issues`. Asked
whether a review existed, it answered "None recorded" while two existed.
*Fix:* add PR read actions; make "I cannot see that" a first-class answer.

**B3 [H] — "…and then merge" is not executable anywhere.**
No merge action exists in any tool. The planner's only escape hatch was `claude_code`, which then
died on the turn timeout (B5).

**B4 [M] — Capability answers come from the model's guess, not the tool registry.**
Two flat denials of a tool it possessed (09-07 18:45, 09-08 07:43).
*Fix:* answer "do you have X" from the registered tool list deterministically.

### Runtime / kernel

**B5 [H] — Blanket turn timeout is shorter than the tools it wraps.**
`OFFICE_TURN_TIMEOUT_MS` = 300 s on prod (`src/gateway/kernel-run.ts:198,260`)
wraps every turn, while `claude_code` budgets 15 min for itself
(`src/tools/claude-code.ts:68` — "real coding tasks need it; the old 120 s killed
everything non-trivial"). The 15 min is unreachable. Fired 08-29 and 09-15.
*Fix:* per-tool deadline, or keep-alive while the tool streams progress.

**B6 [H] — The aborted child process is never actually killed.**
`claudeCodeTool.execute()` accepts no `AbortSignal`; the only kill path is its own 15-min timer
(`src/tools/claude-code.ts:292–321`). When the outer guard aborts, the `claude`
CLI keeps running — doing real repo/GitHub side effects — after you were told it stopped.

**B7 [M] — Orphaned HITL approval row on the timeout path.**
The resume path re-inserts a pending approval row; its cleanup
(`src/gateway/kernel-run.ts:278–281`) sits *after* the awaited call and outside any
`finally`, so a timeout skips it — the exact case it was written for. Its own comment promises
"no phantom card can ever be restored."
*Confirmed:* exactly one stuck `pending` row, `created_at = 2026-09-15 09:39:56.663+00` — the
incident second. *Fix:* move into `finally`.

### Jobhunt — pipeline & apply

**B8 [H] — Tashi's queue never reaches the Mac client.**
One LaunchAgent (`com.founderos.apply-sync`), no profile argument. Synced count (126) matches
`pushkar-nl-tech` (124 ready), not `wife-nl-finance` (**144 ready**). Her 144 queue-ready jobs
have never been syncable. She has **0** applications.

**B9 [H] — 81 % of screened rows can never reach the apply queue.**
`brief_section IS NULL` for 1,949 of 2,399 `pushkar-nl-tech` rows. The Mac queue requires
`brief_section IN ('do_today','stretch','standing')`. Those 1,949 are invisible forever.

**B10 [H] — Nothing writes `applied_at` from an actual submission.**
Only callers: `src/gateway/jobhunt-commands.ts:384` (`/applied` command) and
`src/gateway/live-application-commands.ts:75`. The 08-24 Altura
submit clicked a real Submit button and recorded nothing. Any application you send is invisible to
every downstream number.

**B11 [M] — The skip path has never executed.** `skipped_at` is null on all 2,621 rows.

**B12 [M] — `read_cv` silently defaults to the wrong person.** Without an explicit `profile`, Tashi's
CV is unreachable (three attempts on 09-07).

**B13 [H] — Action language asserts work that did not occur.** "Processed applications for today's
screened passing roles" when nothing was submitted (08-21). This is the trust bug that makes every
other number unbelievable.

**B14 [M] — Freshness is not legible.** "Ingested today" vs "posted today" cost 5 turns on 09-07 and
produced contradictory answers in between.

**B15 [H] — Screening numbers are unstable and unexplained.**
Tashi: **4 pass / 83** (09-07 17:59) → **78 pass / 131** (09-09) → **96 pass / 158** (09-10).
A 4.8 % → 60 % pass-rate move in two days with no stated cause. Replies also conflate `stage`
(pipeline position) with `sponsor_verdict` (screening result) — two different columns presented as
one concept.

### Ops / UX

**B16 [M] — Planner thrash.** Single turns issue `job_state`/`review_screened` 4–6× with permuted
params; turns run 60–160 s. A PR-status question took 2 m 31 s (09-15 10:06→10:08:37).

**B17 [L] — `composio-core` upgrade nag every ~2 min** for 6 days straight — thousands of lines that
actively mask real errors (it drowned my first error grep).

**B18 [M] — Mac client double-fault window.** `wake.log` shows repeated
`sync failed: founderos-vps did not answer within 60s` immediately followed by
`could not report the failure either: could not reach Telegram` — failures that report nowhere.

**B19 [M] — `/jobs` stale-listing bug (reported 09-06) was never filed or fixed** — the issue
creation itself failed.

**B20 [M] — 30 branches, 29 without a PR;** PR #676 is `CONFLICTING`. Finished features (incl. the
CV behaviour you want, below) are sitting unmerged.

---

## Part 3 — Jobhunt: the real numbers, and the truth about the apply path

### Measured, 2026-09-16

| profile | screened total | in brief | **queue-ready** | applied | skipped |
|---|---|---|---|---|---|
| `pushkar-nl-tech` | 2,399 | 124 | **124** | 2 | 0 |
| `wife-nl-finance` | 222 | 144 | **144** | **0** | 0 |

Lifetime: 2,610 rows since 2026-07-31. `applied` = **2**, both **2026-08-06**. Nothing in 41 days.

### The apply path is not broken. It is running, and waiting on you.

This is the finding that contradicts the obvious story, so it matters most:

```
screen (works) → brief rank (works, but drops 81%) → Mac queue sync (works, hourly)
   → announce to Telegram (works) → YOU open the overlay and submit ← stops here
```

The Mac client's `wake.log`, most recent entries:

```
✓ 126 job(s) synced and announced
✓ 127 job(s) synced and announced
✓ 125 job(s) synced and announced
```

Hourly, green, for weeks. **268 jobs are queue-ready right now.**

### Your question: does apply work from Telegram, and from the Mac client?

- **From Telegram — no, and that was your own decision.** Commit `e7f1288d`
  *"T2 — retire the VPS apply-submit lane (founder decision)"* plus `fff7340e`
  *"sweep orphaned VPS apply code"*, formalised in
  `docs/decisions/018-job-application-confirmed-submit-only.md`. `submit_application` no longer
  exists on `main` — which is why the 08-24 calls worked and the tool is gone today.
- **From the Mac client — yes, that is the live path** and it works.

So the apply gap is **three concrete defects (B8, B9, B10) plus one human step**, not a broken
pipeline. If you want submitting to happen from Telegram again, that is a **reversal of ADR-018**
and I am not making that call for you — see Open Questions.

---

## Part 4 — Resumes: you already have what you asked for, unmerged

Your requirement: *base resumes must be the ones you passed; the draft is that base **plus keywords
plus an ATS pass** — not a rewrite, because the base CVs are already correct.*

**Base CVs exist and are the ones you supplied** — `/opt/founderos-data/cv/`:
`cv-master.md` (Sep 1), `cv-wife-base.md` (Sep 4), plus `ai/ backend/ frontend/ fullstack/` variants.

**The locked-body behaviour is already built** on `claude/feat-level-gate-and-locked-cv` (`fa833ce5`,
*"level gate, locked-body CV tailoring, /gaps, Tashi apply path"*) — 162 lines changed in
`tailor-cv.ts`, plus `cv-compose.test.ts`, `level.test.ts`, `experience-qualifier.test.ts`,
`screen-gates.ts`. **59 files, +5,845 lines. No PR. Never merged.**

Recommendation: **do not rebuild this — QA it and merge it.** It is the single highest-value
unmerged branch, and it is the literal answer to your request.

---

## Part 5 — Self-healing loop: ~80 % exists; build one primitive, not a feature

| Stage | Status |
|---|---|
| Create an issue from a finding | ✅ `dispatch_antigravity_task` — #667–#678 all created fine |
| Executor picks it up | ✅ `agent-dispatch` cron `*/15`, proven by #669→#671, #670→#672 |
| Adversarial PR gate | ✅ `pr-brain` cron `*/20` — **alive**, posted real gate reviews 09-15 06:32 & 09:51 (this corrects the memory note that its auth died 2026-08-16) |
| **Read its own logs** | ❌ **missing — this is B1, the whole gap** |
| **Verify the fix actually landed** | ❌ missing — nothing closes the loop |
| Read PR state / merge | ❌ missing (B2, B3) |

So: **one new tool (`read_logs`), two new `github_read` actions, one verification step.** Everything
else is wiring you already paid for. Building a new "self-healing feature" from scratch would
duplicate a working loop.

---

## Part 6 — Branches & PRs

Open PRs: **1** (#676, draft, base `beta`, **CONFLICTING**, CI partly green, being pushed to as of
11:16 today). 30 remote branches, so ~29 carry work with no PR. Notable unmerged:

| Branch | Carries | Action |
|---|---|---|
| `claude/feat-level-gate-and-locked-cv` | locked-body CV, level gate, `/gaps`, Tashi apply path | **QA → PR → merge first** |
| `feat/autonomous-ats-apply` | ATS submitter (Playwright) | Conflicts with ADR-018 — decide before touching |
| `claude/feat-browser-vision-qa` (#676) | UI QA render-and-verify gate | Resolve conflict, then merge |
| `fix/jobhunt-pipeline-audit-fixes` | pipeline audit fixes | Triage |
| ~26 others (09-06→09-14) | assorted | Triage: merge, or delete |

---

## Part 7 — Why AI slop reaches `main` despite QA

The mechanism is visible in PR #676's own body. It claimed:

> "pnpm gate green — 386 files, 4254 tests, exit 0"

The actual run was **`2 failed | 4252 passed`**. `pr-brain` caught it and said so.

That is the whole disease in one line: **the claim was authored, not measured.** Tests passing is
not the same as the thing working, and a summary of a run is not the run. Your own CLAUDE.md rule
#24 already says this; nothing *enforces* it.

**The fix is mechanical, not cultural:**

1. **Evidence must be machine-captured, never typed.** `pnpm gate` writes
   `gate-evidence.json` (exit codes, counts, commit SHA, timestamp). CI recomputes it and fails
   if the PR body disagrees. A human/agent cannot type a green number.
2. **One real-path assertion per PR.** Not a unit test — the actual seam (Telegram → kernel → tool
   → reply → DB row). PRs that cannot state one declare **NOT VERIFIED — reason** explicitly.
3. **`pr-brain` verdict becomes a required check**, not a comment. It already produces the right
   verdict; nothing is currently gated on it.
4. **Merge only via the gate.** No direct pushes to `main` once it is green.

---

## Part 8 — Brainstorm: what "stable and actually usable" requires

Ordered by what unblocks the most, not by effort.

**Tier 0 — stop the bleeding (do before anything else)**
1. Close issues **#677/#678** — they encode a hallucinated audit. Leaving them armed means an
   executor will "fix" fiction.
2. Ship `read_logs` (B1) + "missing instrument is reported, never substituted."
3. Fix B5/B6/B7 — one incident, three defects, all small and surgical.

**Tier 1 — make the numbers true (nothing else matters while they lie)**
4. One canonical funnel query. Every surface (`/jobs`, brief, CSV, chat reply) reads *that*, so
   two answers can never disagree (B15).
5. Write `applied_at` from the real submit path (B10); expose `skipped` (B11).
6. Separate `stage` from `verdict` in every rendering; label "ingested" vs "posted" (B14).
7. Per-profile LaunchAgent or a `--profile` argument (B8) — unblocks Tashi's 144 immediately.
8. Investigate why 81 % never get a `brief_section` (B9).

**Tier 2 — make it answer for itself**
9. PR read actions + merge (B2, B3); capability answers from the registry (B4).
10. Close the self-heal loop: finding → issue → PR → gate → **verify landed** → report.

**Tier 3 — the UX that decides whether you actually use it**
11. **One daily message that is a decision, not a log:** "3 to do today — [Apply] [Skip] [Why]."
    268 queued jobs announced hourly is noise; three ranked with one tap is an outcome.
12. Turn latency budget: first token < 3 s, progress every 10 s, hard answer or explicit failure
    < 60 s (B16). Today a status question takes 2.5 min.
13. Every reply ends in something actionable or says plainly that it cannot.

**Tier 4 — lock `main`**
14. Triage all 30 branches: merge, or delete. No orphans.
15. Turn on the gate from Part 7, then protect `main`.

---

## Part 9 — Open questions (I am not deciding these for you)

1. **ADR-018 / Telegram submitting.** Do you want the VPS submit lane *un-retired* so applying
   works from Telegram, or does the Mac client stay the only submit surface? This changes whether
   `feat/autonomous-ats-apply` gets merged or deleted. You decided this once already; I won't
   silently reverse it.
2. **Priority order.** Tier 0+1 (make it honest and make the numbers true) before Tier 3 (UX), or
   do you want the daily-decision message first because that's what makes you open it at all?
3. **#677/#678** — close them outright, or keep the issue numbers and rewrite the bodies from this
   audit's verified findings?

---

## Verification status

- **Verified:** all DB counts, the Mac `wake.log` behaviour, the 5-min timeout incidents, the stuck
  HITL row, `github_read`'s action list, the absence of a log tool, base CV files, branch inventory,
  PR #676 state, `pr-brain` being alive.
- **NOT VERIFIED:** whether the orphaned `claude` child from 09-15 completed side effects before the
  15-min timer (no distinguishable trace — `pr-brain`'s identical-format comments make attribution
  impossible); the exact cause of the 4.8 %→60 % pass-rate jump (B15) — it needs a `screen.ts` diff
  across 09-07→09-09; whether Tashi's LaunchAgent was ever configured on another machine.
