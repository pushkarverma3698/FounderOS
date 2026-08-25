# Execution brief — finish the apply lane and start applying

Date: 2026-08-25 · Author: Claude (gatekeeper session) · Status: ready to execute
Base commit: `ce99ff6` on `main` · Audit this derives from:
`docs/plans/2026-08-24-jobhunt-supply-to-apply-pipeline-audit.md` (read REV 2 at the end first)

**Goal of this brief: the founder sends real applications this week, each carrying the CV that was
tailored for it, and the pipeline can say afterwards how many replies came back.**

Not "improve the pipeline". Every task below is scoped to that one outcome. If a task stops serving
it, say so and drop it (rule #26).

---

## ⚠ THIS BRIEF IS COMPLETE — 2026-08-25 18:0x UTC

**Executed and merged as PR #576 (`ab0c170`). Do not work it again.** What remains is one task and
it is T6, promoted below.

| Task | Final state |
|---|---|
| T1a — swallowed S3 fetch / `$STORAGE_BUCKET` | **DONE** `3672c58`, `89c6b69` |
| T1b — silent generic substitution | **DONE** `e659826` — `uses_tailored_cv()` + three-state overlay label |
| T1c — bulk tailoring cron | **BUILT THEN REJECTED** `400d145` → `fff7340`. Correct call — see below |
| T2 — retire the VPS lane | **DONE, founder decision** `e7f1288` + orphan sweep + CI tombstones |
| T3 — reply tracking | **DONE** `c7dfcd2` — `pipeline-followup.ts`, `/replied`, `/rejected` |
| T4 — Recruitee + Workable | **DONE** `761084e` |
| T5 — cover letter to the Mac | **DONE** `f0b2aa4`, `c2f3cf2`, `dc80f0a` |
| **T6 — fabrication guard** | **NOT DONE — now the only thing blocking both throughput and safety** |

### What the execution measured

- **4 of 62 queue rows carried a tailored CV**; 58 fell back to generic with no warning anywhere.
- **`tailorCv()` fabricates: 36 invented claims across 4 CVs** (Kubernetes, PyTorch, Domain-Driven
  Design, FastAPI) against a base CV that contains none of them. `findSlop()` is a banned-word list,
  not a claim check.

### Why T1c was rejected, and why that was right

Tailoring is a deliberate act triggered by `/draft N`, not a background job — and running an
unguarded fabricating tailor on a 30-minute cadence over a 606-row backlog would spend the IND
sponsor pool, which is finite and non-renewable, on fabricated résumés. I proposed T1c; rejecting it
was the correct call, and the safety argument only became visible because the executing session ran
it against real rows first, as this brief instructed.

The condition for revisiting is stated in `fff7340`: *"Do not re-add the batch cron without a
fabrication guard in front of it."*

### T6 is now the whole job — promoted from "only after T1–T3"

Build the entity check: ~40 lines that extract capitalised entity spans and `YYYY` / `Mon YYYY`
tokens from the tailored output, assert each appears in the base CV, and fail the packet naming the
offending span. Same shape as `validateStepResult`. Then re-add the batch cron behind it — that
closes the risk and lifts the throughput ceiling in one change. Wire `humanise.ts` (still zero
callers) while you are in there.

**Verified independently against the merged tree, 2026-08-25:** `tailor-cv.ts` gained only
cost-attribution metadata in this batch. No claim check exists.

---

## Superseded status update — 2026-08-25 12:0x UTC (kept for the record)

`main` moved from `ce99ff6` to `3637f4e` while this brief was being written. Another session shipped
11 commits that land squarely on it. **Re-scoped below; do not work the original T1a or T5.**

| Task | Status |
|---|---|
| T1a — swallowed S3 fetch / `$STORAGE_BUCKET` | **DONE** (`3672c58`, `89c6b69`) — and it was worse than this brief guessed |
| T1b — silent generic substitution | **NOT DONE** — and now the live risk |
| T1c — nothing tailors in bulk | **NOT DONE** — zero callers, unchanged |
| T2 — two live lanes | **NOT DONE** — `telegram.ts` and `capabilities.ts` unchanged |
| T3 — reply tracking | **NOT DONE** |
| T4 — Recruitee/Workable field maps | **NOT DONE** — still 3 ATS |
| T5 — cover letter to the Mac | **DONE** (`f0b2aa4`, `c2f3cf2`, `dc80f0a`, `c1d86a2`, `923eb71`) |

**The T1a fix produced the measurement this brief could not make.** From `sync.py`'s own new comment:

> *"Found live, 2026-08-25: every `_fetch_s3_artifact` call failed silently (`aws: command not
> found`, and even once installed, `$STORAGE_BUCKET` was empty) for both the cover letter and the
> pre-existing tailored CV — the function's designed-to-be-silent failure mode had hidden a fetch
> that had never once worked."*

So the answer to "how many rows shipped a tailored CV" was not "most rows are generic". It was
**zero rows have ever carried one**. Every application the Mac lane has ever sent used the generic
CV. The `awscli` package was not even installed on the VPS. That is now in the deploy runbook
(`docs/guides/DEPLOYMENT.md`).

**T5 is done and done well** — the letter is synced from S3 alongside the CV, copied to the clipboard
when the job opens (`pbcopy`), and the overlay says whether one was found. Do not rebuild it.

### What this changes about T1

The fetch can now succeed. That makes the remaining half **sharper, not smaller**: whether a given
row ships its tailored CV or silently ships the generic one is now a live per-row outcome, and
nothing reports which happened. Work T1b and T1c only.

---

---

## Ground truth before you start

Run these first. Do not trust this document over the tree.

```bash
git log --oneline -5                 # has main moved past ce99ff6?
pnpm install
pnpm lint && pnpm verify:arch && pnpm test
python3 -m pytest mac-client/tests -q
```

Expected at ce99ff6: lint clean, arch 6/6 green, **3,617 tests passing across 327 files**,
**53 Python tests passing** plus 13 errors that are purely environmental (a pip playwright that does
not match the local browsers — not failures; on a Mac with `playwright install` done they pass).

If `main` has moved, re-verify every claim below against the new tree before acting on it. Several
findings are call-graph arguments, and a call graph is exactly what a merge changes.

### Architecture as of this brief

There are **two** apply lanes and both are wired:

| | VPS lane | Mac lane |
|---|---|---|
| Entry | `/apply N` → `src/gateway/apply-commands.ts` | `mac-client/mac_client/apply.py` |
| Submit | machine clicks, after an HITL card | **the founder clicks** |
| ATS | 5 (GH, Lever, Ashby, Workable, Recruitee) | 3 (GH, Lever, Ashby) |
| Boards | 721 / 1,297 | 514 / 1,297 |
| Still wired | `telegram.ts:62`, `capabilities.ts:114` | yes — the intended primary |

The Mac lane is the intended product. The VPS lane was demoted, not retired.

---

## T1 · CRITICAL · Make the tailored CV actually ship

**This is the whole brief.** Everything else can slip; this cannot. Today a Mac-queue row that the
founder did not personally `/draft` first is applied to with the **generic** CV, and nothing says so.

Two independent causes. Fix both — fixing one leaves the failure intact.

### T1a — a failed CV fetch is swallowed  ✅ DONE 2026-08-25 (`3672c58`, `89c6b69`) — SKIP THIS, kept for the record

`mac-client/mac_client/sync.py:168-181`, inside `save_queue`:

```python
if not pdf_path.exists():
    try:
        cmd = ["ssh", SSH_HOST, f'aws s3 cp "s3://$STORAGE_BUCKET/{job.tailored_cv_s3_key}" -']
        proc = subprocess.run(cmd, capture_output=True, timeout=30, check=False)
        if proc.returncode == 0 and len(proc.stdout) > 100:
            pdf_path.write_bytes(proc.stdout)
    except Exception:
        pass
```

A failed copy writes nothing and reports nothing. Fix: collect failures and return/print them with
the company name and the reason (stderr, truncated). A row whose CV could not be fetched must be
**visible**, and the fetch failure count belongs in the wake message alongside the queue count.

**Verify `$STORAGE_BUCKET` first.** It is expanded by the *remote non-interactive* shell, which often
does not load the profile that sets it. Run:

```bash
ssh founderos-vps 'echo "[$STORAGE_BUCKET]"'
```

If that prints `[]`, the S3 path is `s3:///key`, every fetch has been failing silently, and T1 is
firing on every row today. Fix it by reading the value from the app's own env file on the box rather
than relying on shell expansion.

### T1b — the silent substitution  ⬅ **START HERE**

Now the highest-value change in the repository. `_fetch_s3_artifact` (sync.py:174) returns a bool,
and `save_queue` **discards it at both call sites** (sync.py:205 and 207). So a failed fetch is still
invisible to the founder, and the generic CV still goes out under a tailored CV's reputation.

`mac-client/mac_client/profile.py`, `resume_for()` (~line 44) falls back to the track/default résumé
when the tailored PDF is absent, and `missing_resumes()` (~line 93) then reports **no problem**,
because a file *is* there.

Proven, against the real functions:

```
A — tailored PDF present:  resume_for -> tailored_cv.pdf    preflight -> no problems
B — S3 fetch failed:       resume_for -> generic_ai_cv.pdf  preflight -> no problems
```

Fix: `resume_for` must distinguish "this row never had a tailored CV" from "this row has one and it
is missing". Pass the row's `tailored_cv_s3_key` through (it is already on `QueueJob`), and when the
key is set but the PDF is absent, `missing_resumes` reports it in the list it already prints. Falling
back to generic is acceptable **only** when it is announced.

**Failing test first (repo invariant #2):** in `mac-client/tests/test_profile.py`, assert that a job
whose `tailored_cv_s3_key` is set and whose `.queue/{id}/tailored_cv.pdf` is absent appears in
`missing_resumes()`. Watch it fail, then fix.

### T1c — nothing tailors in bulk

`tailored_cv_s3_key` is written in exactly two places:

- `src/tools/jobhunt/apply-packet.ts:120` — per row, only via `/draft N`, `/apply N`, `tailor_cv`
- `src/tools/jobhunt/tailor-worker.ts:73` — inside `processUntailoredApplications(limit = 10)`,
  which has **zero callers** in `src/` and `scripts/` and no cron

So a 20-job batch queue hands the founder 20 generic CVs unless he pre-drafts each one, which defeats
the batch. Fix: call `processUntailoredApplications` from `startScheduler`
(`src/infra/scheduler.ts:291`) after the free sweep's ranking pass, so the queue is tailored before
he opens it. It returns `{processed, succeeded, failed, details}` — log it, and surface `failed > 0`.

Mind the cost: it is a model call per row. Bound the limit, and check it against
`BUDGET_DAILY_USD` / the spend gate before raising it.

**Done when:** a fresh `python -m mac_client.wake` on the Mac reports how many queue rows carry a
tailored CV and how many do not, and the number that do is not ~0.

---

## T2 · Decide the lane, then make the decision structural

**Ask the founder before doing this one.** It is his call and it was put to him; do not assume.

If the Mac lane is the product:
- unregister `/apply` — `src/gateway/telegram.ts:62`
- drop `submitApplication` from the jobhunt toolset — `src/agents/capabilities.ts:114`
- add the VPS apply driver to the tombstone list in `scripts/verify-architecture.ts`, so it cannot
  return by accident — that list is the mechanism this repo already trusts for exactly this

If both lanes must live, they need **one** fill plan and **one** queue definition, not two
implementations that were each correct on a different day. Do not leave them diverging.

Evidence they diverge today: the Ashby `/application` route bug had to be found and fixed twice, in
two languages, a day apart (`b7235c6` then `a0117b1`).

---

## T3 · CRITICAL · Close the funnel's back half

The Mac lane records `applied` well — `ledger.py` writes one JSONL line per click and flushes before
the queue advances, and `push_outcomes` is idempotent by `IS NULL` guard. Keep all of that.

What still has **zero writers or callers**: `followups_sent`, stages `replied` / `rejected` /
`dormant`, `listLiveApplications()`, `countApplied()`, and any `email → job_applications` link.

Cheapest version that makes the pipeline falsifiable:

1. `/replied N` and `/rejected N` beside the existing `handleApplied` in
   `src/gateway/jobhunt-commands.ts`, registered in `telegram.ts`. Two small handlers.
2. A daily pass over `stage = 'applied'`: at day 7 and day 14 with no `last_contact_at` movement,
   message the founder a one-tap follow-up draft and increment `followups_sent`.
3. One weekly digest reading `listLiveApplications()` — the function exists, is tested, and is called
   by nothing.

**Rank-churn trap:** `brief_rank` is re-pinned on every free sweep that finds a new pass, up to 48×
a day, and `/applied N` has no confirmation. Echo the company name back in every one of these new
commands — `"Marked replied — Ockto (Senior Backend)"` — so a stale number is visible rather than
silent.

**Done when:** you can answer "how many applications, how many replies, over what window" from the
database with one query.

---

## T4 · Recover the 207 boards the shift dropped

`mac-client/mac_client/adapters.py` covers Greenhouse, Lever, Ashby. The VPS lane also drove Workable
and Recruitee. That is 207 boards — 16% of the registry — currently polled and unappliable.

Recruitee matters most: it was added on 2026-08-20 *because* the US-centric platforms matched 0.36%
of the IND recognised-sponsor register while the NL-native ones matched 2.50%, with named verified
hits (`recruitee/dalsem`, `recruitee/netconomy`, `recruitee/ravo`). Those are Dutch sponsors that can
carry the permit.

Fix: two `FieldMap` entries plus host markers in `adapters.py`. The selectors already exist,
live-captured, in `src/tools/jobhunt/apply-fill.ts` and `tests/fixtures/apply-forms/`. This is a
port, not a discovery exercise. Keep the existing discipline: no cover letter, no work-authorisation,
no demographics.

---

## T5 · Put the cover letter where his hands are  ✅ DONE 2026-08-25 — SKIP, kept for the record

The Mac lane deliberately does not fill cover letters, and that is **correct** — `adapters.py` states
why and `test_the_cover_letter_and_work_authorisation_are_left_alone` holds it there. Do not change
that.

The seam is delivery: the letter is generated, slop-checked, archived to S3 and sent **to Telegram**,
while the founder is looking at a browser on his Mac.

Fix: `save_queue` already writes `.queue/{job_id}/` — drop `cover_letter.txt` beside
`tailored_cv.pdf` (same S3 mechanism, `cover_letter_s3_key` is already on the row), and add a
copy-to-clipboard button to the overlay next to SKIP / SUBMIT in
`mac-client/mac_client/overlay.js`. He still pastes it himself. From the screen he is already on.

---

## T6 · Only after T1–T3 are shipped

- **Fabrication check on the tailored CV.** `tailor-cv.ts` rule #1 is "zero hallucination" and the
  only enforcement is `findSlop()`, a banned-word list. Add ~40 lines: extract capitalised entity
  spans and `YYYY` / `Mon YYYY` tokens from the tailored output, assert each appears in the base CV,
  fail the packet naming the offending span. Same shape as `validateStepResult`.
- **Wire `humanise.ts`** into the cover-letter path. 136 lines, a real AI-tell detector with a
  threshold and a full test file, zero callers.
- **Re-score overlap after tailoring.** `overlapScore()` runs on the *base* CV only, so the ATS
  keyword claim is never checked in either direction. Store before and after, refuse negative lift,
  cap density (>40% triggers stuffing penalties on Workday/Greenhouse).

---

## Then: actually start applying

The point of all of the above.

```bash
# on the VPS — confirm the sweep is producing fresh, ranked, tailored rows
ssh founderos-vps 'sudo -n docker exec founderos-postgres psql -U founderos -d founderos -c "
  SELECT count(*) FILTER (WHERE tailored_cv_s3_key IS NOT NULL) AS tailored,
         count(*) AS total
  FROM agents.job_applications
  WHERE tenant_id = $$turicks$$ AND brief_section IN ($$do_today$$,$$stretch$$)
    AND applied_at IS NULL AND skipped_at IS NULL"'
#   ($$…$$ is Postgres dollar-quoting — avoids nesting single quotes inside the ssh arg)

# on the Mac
python -m mac_client.wake      # sync queue + profile + tailored CVs, announce
python -m mac_client.apply     # one job on screen at a time; his click submits
```

**If `tailored` is far below `total`, stop and finish T1.** Sending generic CVs at volume spends
scarce, non-recoverable inventory: the IND sponsor pool that hires AI engineers is a few hundred
companies and it does not replenish.

Target 10–15 applications in the first session, then read the funnel:

```sql
SELECT stage, count(*) FROM agents.job_applications
WHERE tenant_id = 'turicks' GROUP BY stage ORDER BY 2 DESC;
```

---

## Rules that bind you here

From `CLAUDE.md`, and they are the reason this pipeline has the defects it has:

- **#24 Evidence over assertion.** "Done" means the command run fresh in this session with output
  shown. Unit tests are necessary, not sufficient — exercise gateway → kernel → tool → reply →
  `action_log` row. Unverifiable ⇒ say "NOT VERIFIED — reason".
- **#27 A rule with no mechanism decays.** Every fix above must be a mechanism (a check that runs, a
  test that fails, a cron that fires), never a comment asking the next person to be careful. T1
  exists *because* three separate correct comments did not prevent it.
- **#26 Build for the outcome.** The outcome is applications sent with the right CV and replies
  measured. If a task stops serving that, say so.
- **#28 Approval authorizes work; it does not verify it.** If you find something in this brief is
  wrong, say so before building it, then build the corrected version.
- **Bug fixes start with a failing test.** T1b names its test explicitly.
- Never commit directly to `main`. Work branch → PR. `pnpm gate` green before you push.

## What this brief could not verify

- ~~**No production database access.** The claim "almost no row carries a tailored CV" is argued from
  the call graph, not counted.~~ **SETTLED 2026-08-25, and it was worse:** the fetch had never once
  succeeded, so *zero* rows have ever carried a tailored CV. Still run the query at the top of
  "start applying" after T1b/T1c land — it is how you confirm the fix worked.
- ~~**`$STORAGE_BUCKET` over non-interactive SSH** — unchecked.~~ **CONFIRMED BROKEN and FIXED**
  (`3672c58`). `awscli` was also missing from the box entirely.
- **No live browser run** on either lane. T1's fallback is proven against the real
  `resume_for`/`missing_resumes`; the VPS lane's divergence against the real `buildFillPlan` and a
  live-captured fixture. Neither was driven against a real employer form.
- **The `ai`-track base CV** at `PERSONAL_CV_DIR` is invisible to the repository and has now been
  flagged unaudited by three consecutive audits. Until T1 lands, the generic CV is not the fallback —
  it is the product — and nobody has read it. That is a founder task, not yours.
