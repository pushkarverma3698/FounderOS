# Job pipeline audit — supply → apply, end to end

> **Superseded in part by REV 2 (2026-08-25), appended at the end of this file.** The apply flow
> moved to `mac-client`. F1 below is no longer the default path (see rev 2 F4); F2 is half fixed
> (rev 2 F3); F3 and F7 are revised. Rev 1 is kept intact as the record of what was found first.

Date: 2026-08-24 · Author: Claude (gatekeeper review) · Status: findings, awaiting founder decision
Commit audited: `ce99ff6` on `main`
Artifact: https://claude.ai/code/artifact/ab633e44-f760-4e1a-859f-de176dbc1e5c

---

## The verdict

The best-engineered job-*screening* machine I have seen in a personal repository, attached to an
apply path that currently cannot complete a correct application.

Three days since `docs/plans/2026-08-22-portfolio-and-recruitment-readiness-audit.md` went into the
right place — the last mile — and shipped a seam defect no unit test can see: **the founder approves
a screenshot of one form and a materially different form is submitted.** Meanwhile the three levers
that audit named CRITICAL (follow-up, warm intro, outcome tracking) are still at zero lines, and one
more supply expansion shipped against its own explicit "do not add job sources".

The binding constraint has not moved since 2026-08-22. It was never supply and never screening. It is
**completed applications × quality of what lands × learning from what comes back.** The second is
broken and the third does not exist.

## Verified this session

Fresh on a clean checkout of `ce99ff6`:

- `pnpm lint` — clean
- `pnpm verify:arch` — 6/6 green (gateway-imports 0, kernel-purity 0, fail-open-catch 11, loc-budget 6, regex-routing 0, orphan-subsystem 0)
- `pnpm test` — **327 files, 3,617 tests, all passing, 102.9s**

**3,617 tests pass and the cover letter still never reaches an employer.** Every defect below survived
a fully green suite because they all live in seams between individually-correct modules.

**No production DB access** — no SSH client in this container. Every funnel figure is a dated in-repo
measurement, labelled as such.

## The funnel

| Stage | Count | Provenance |
|---|---:|---|
| Boards polled | 1,297 | verified — counted from `free-ats-boards.csv` |
| Driveable by `/apply` | 721 (56%) | verified — 576 boards on platforms `detectApplyAts` rejects |
| Screened lifetime | 334 | dated 2026-08-20 |
| Fresh <24h in queue | 37 | dated 2026-08-24 (`daily-brief.ts`); was **0** earlier that week, median age ~8 days |
| Shown in brief | 10 | `DO_TODAY_CAP` 6 + `STRETCH_CAP` 4 |
| Applications sent | 2 | dated 2026-08-20 |
| Outcomes recorded | 0 | verified — no code path can record one |

Between 2026-08-20 and today the registry grew 858 → 1,297. Nothing in the bottom three rows moved.

---

## Findings

### F1 · CRITICAL · The cover letter never reaches an employer, and the approval screenshot shows a form that will not be submitted

Two bugs on one seam. **No application submitted via `/apply` has ever carried a cover letter**, on any
of the five platforms, despite PRs #541 and #574 building the feature.

- `apply-commands.ts:88` passes `coverLetterText: packet.cvMarkdown` — the whole tailored CV in raw
  Markdown — into the field `apply-fill.ts:341` types into the form's *cover letter* box.
- The real letter from `sendCoverLetter()` goes to Telegram and is discarded; the function returns `void`.
- `submit_application` builds `RowFacts` as `{ resumePath }` only — no `coverLetterText` — so the pass
  that **actually submits** leaves the field blank.

Proven against the live-captured Workable fixture with the real `buildFillPlan`:

```
cover-letter field: {"type":"textarea","label":"Cover letter","required":true}

[/apply N preview]    kind=value  value="# PUSHKAR VERMA\nAmsterdam | a@b.com\n\n## SUMMARY\nEnginee"
[submit_application]  kind=ask    reason=no rule in buildFillPlan matched this field's label

filled  preview=6/10   submit=5/10
```

`apply-headless.ts`'s header claims this is structurally impossible ("the SAME function called twice —
never two implementations that could quietly diverge"). The function is the same; the arguments are
not. That comment is currently the most dangerous line in the file, because it is why nobody looked.

**Fix:** return the letter from `sendCoverLetter`, persist to `cover_letter_s3_key` (column exists,
`archiveCoverLetter` already writes it), read it back in *both* `previewFlowSafely` and
`submitApplyFlowSafely` the way they already read `tailored_cv_s3_key`. Then add the missing test:
**assert the preview plan and submit plan are element-wise equal for one row.**

### F2 · CRITICAL · Nothing measures an outcome; the funnel terminates at `applied`

Flagged CRITICAL on 2026-08-22. Three days and eight merged PRs later, all still zero:

| Declared machinery | Writers/callers in `src/` |
|---|---:|
| `followups_sent` ("Monday review follows up at day 7, then 14") | 0 |
| Stages `replied` / `rejected` / `dormant` | 0 |
| `listLiveApplications()` ("the Monday pipeline review") | 0 |
| `countApplied()` ("the number the pipeline exists to move") | 0 |
| Any link between `src/tools/email-*` and `job_applications` | 0 |
| `markApplied()` / `markSkipped()` | 0 (bypassed by raw SQL) |

**The pipeline cannot tell a working CV from a broken one.** Every threshold, gate, prompt, the €4,357
floor, the 24h window, the 1,297 boards — all unfalsifiable. Rule #26 failing at the top level:
*"if ignoring the output costs nothing and emits no signal, the design is wrong, however many tests pass."*

**Fix:** `/replied N` and `/rejected N` (two lines each beside `/applied`), plus a daily pass over
`stage='applied'` writing `followups_sent` at day 7 and 14. Inbox detection is the better version, second.

### F3 · HIGH · Supply expanded again, against the audit's explicit instruction

2026-08-22: *"Do not add job sources. 858 boards against 2 lifetime applications."*
2026-08-24, `e8ed1ea` (#559): *"3 new ATS adapters — registry 923 → 1297 boards."*

The adapters are clean. The point is that it was the most comfortable available work, it displaced the
CRITICAL items in F2, and the audit forbidding it was two days old and written by this same system.
Rule #30 going unenforced, exactly as rule #27 predicts.

Two compounding effects:
- **Sourcing and applying are diverging.** 44% of the registry (576 boards: Workday 205,
  SmartRecruiters 145, BambooHR 137, Personio 65, Teamtailor 24) is on a platform `/apply` cannot drive.
- **New boards backfill invisible inventory.** `FREE_LANE_MAX_AGE_HOURS = 720` (30d) for ingest vs
  `APPLY_QUEUE_MAX_AGE_HOURS = 24` for the queue. A new board's first sweep screens a month of postings;
  the queue admits only the last day.

**Fix:** freeze the registry until sustained applications/week > 10. The supply change that *would* help
is `detectApplyAts` gaining Workday + SmartRecruiters — converts ~350 already-polled boards to usable.

### F4 · HIGH · `brief_rank` churns every 30 minutes under the founder's fingers

`runFreeSweep` calls `buildDailyBrief` on every sweep with ≥1 new pass, and that re-pins `brief_rank`
on every qualifying row — up to 48×/day. The "3" read at 10:00 may not be the "3" typed at 10:45.

`submit_application` already defends this race *inside* the HITL wait. The much longer read-then-type
gap is undefended. High not Critical because the HITL card names the company — but `/draft N` burns a
model call on the wrong company silently, and **`/applied N` will mark the wrong row applied with no
gate at all**, removing a live opportunity permanently and corrupting the F2 metric.

**Fix:** echo the company name back on `/applied` and `/draft`; better, stamp briefs with an id and
resolve `(brief_id, rank)` so a stale number fails loudly.

### F5 · HIGH · The CV's "zero hallucination" rule is a prompt instruction, not a mechanism

`tailor-cv.ts` rule #1 is "Zero hallucination — never invents dates, companies, titles, or education."
Enforcement on the output: `findSlop()`, a banned-word list. Nothing checks that employers/dates/titles
in the output appear in the base CV. By rule #27 that rule is a wish.

The asymmetry is stark: a model misreading "€4.500" earned `extract.ts` — 383 lines of pure parser with
its own suite — because a fabricated *salary* was too expensive to risk. A fabricated *employment claim*,
which he will be interviewed about on the record, is protected by a system prompt.

Also: **`humanise.ts` (136 lines, AI-tell detector with a threshold, full test file) has zero callers.**
Applied to neither the CV nor the letter.

**Fix:** ~40-line pure function — extract capitalised entity spans and `YYYY`/`Mon YYYY` tokens from the
tailored output, assert each appears in the base CV, fail the packet naming the offending span. Same
shape as `validateStepResult`, applied to the one document that goes to a stranger. Wire `humanise.ts`
into the letter path.

### F6 · MEDIUM · The ATS keyword claim is never measured, in either direction

`overlapScore()` runs on the *base* CV before tailoring; the tailored output is never re-scored. So
rule 3 of the tailoring engine ("ATS keyword mirroring") is claimed and never checked.

- **Under-tailoring:** if the model reorders without surfacing JD terms, nothing notices — and a
  tailored resume ranks materially higher than an untailored one on a 2026 parser.
- **Over-tailoring:** keyword density above ~40% triggers stuffing penalties on Workday/Greenhouse. The
  prompt hands the model an explicit keyword list with no density ceiling anywhere.

**Fix:** re-run `overlapScore(jd, tailoredMarkdown)`, store both numbers, refuse negative lift, cap
density. Gives you keyword-lift-vs-response-rate once F2 supplies the second axis.

### F7 · MEDIUM · Three implementations of "mark applied", two definitions of "the queue"

- `updateApplicationStage()` — TS, drizzle, tested (bot lane)
- Raw SQL in `src/infra/health.ts` — `/skip` HTTP route; **no matching `/applied` route**
- Raw SQL in `mac-client/sync.py` over SSH into psql, bypassing TypeScript entirely

Readers disagree too: `listActionableApplications` filters `stage='screened'` + 24h; `listApplyQueue`
and the Mac client filter `brief_section IN (do_today,stretch)` with **no age bound**. They agree only
because `clearBriefRank` happens to clear both — a coincidence, not an invariant.

**Fix:** one writer. Route the Mac client through HTTP. Delete or consolidate the dead
`markApplied`/`markSkipped`/`countApplied`.

### F8 · MEDIUM · The pre-tailoring worker exists and nothing runs it

`tailor-worker.ts` exports `processUntailoredApplications(limit = 10)` — zero callers in `src/` and
`scripts/`, no cron. So `/apply N` tailors on demand and announces *"this takes 20–40s"* at the exact
moment a human decides whether to do it fifteen more times. Throughput is the constraint and there is a
built, tested, unwired component whose purpose is to remove it.

**Fix:** one line in `startScheduler`, after each free sweep's ranking pass. `tailor_status` and
`tailor_note` already exist to track it.

### F9 · LOW (verify this week) · The IND salary constant has no staleness alarm

`HSM_UNDER_30_MONTHLY_EUR = 4357`, re-indexed 1 Jan and 1 Jul, documented as verified at ind.nl. Nothing
in CI fails when it goes stale, and it is a hard legal gate in both directions. Secondary sources found
this session quote different 2026 figures — **not** a claim the constant is wrong (ind.nl beats a
recruitment blog), but the disagreement exists and nothing here would tell you which is right.

**Fix:** check ind.nl, then a dated CI assertion that fails after 2027-01-01.

---

## What is excellent — do not touch

- **Multi-basis permit screening.** Every posting screened under every lawful basis, best outcome wins,
  ties broken on fewest open gates. Nothing in the open-source field models immigration law at all.
- **Refusal enforced by type.** `chooseEligibility` *can only* return `choose` or `ask`. CAPTCHAs and
  consent boxes never touched. A mechanism, and the right one.
- **The Greenhouse read-back discovery.** `.fill()` reports success, React reverts within 700ms. Found
  live, root-caused, fixed generically, and the founder-facing summary rebuilt to count *verified*
  outcomes rather than intended ones.
- **`unverifiable` ≠ `expired`** throughout. Rare and correct.
- **HITL before the click, DB row before the interrupt.** Unconfirmed submit deliberately does not
  advance the row. This is the answer to the obvious objection about auto-apply bots.
- **The comments.** Every non-obvious decision carries its incident, date and measurement.

## Resume + cover letter vs a 2026 parser

Correct already: single-column, real text layer (Playwright `page.pdf`), standard section headers,
contact in body not header/footer, explicit `## SKILLS`, no hidden-text tricks (now an auto-reject with
a fraud flag), per-job tailoring at all.

Gaps: no keyword-density ceiling; no post-tailor overlap re-score (F6); no page-count bound; dates not
normalised to `Month YYYY`; `markdownToAtsHtml` has no table branch (a base-CV markdown table renders as
literal pipes); the prompt emits `[Contact Info & Links]` as a slot and nothing asserts it was filled.

The **cover letter prompt is the best-written artifact in the lane** — under 300 words, no throat-clearing
opener, one concrete piece of evidence, no recap, banned-word list, and *"if the posting asks for
something the CV does not show, do not mention it"* — enforced by `findSlop(text,{prose:true})` on the
output rather than by asking nicely. And no employer has ever read one (F1). That costs more in NL than
elsewhere: the sponsor pool is small enough that a human reads a meaningful share.

**Still unaudited:** the `ai`-track base CV at `PERSONAL_CV_DIR` on the VPS, invisible to this repo and
to the 2026-08-22 audit. Everything above is downstream of a document neither audit could open.

## The field on GitHub

| Project | Stars | Where it differs |
|---|---:|---|
| [feder-cr/Jobs_Applier_AI_Agent_AIHawk](https://github.com/feder-cr/Jobs_Applier_AI_Agent_AIHawk) | 30,243 | Scale leader, opposite philosophy — topics lead with `anti-bot`, `antidetect`, `browser-fingerprinting`, `stealth`. No HITL, no legal gates. |
| [slothsheepking/jobclaw](https://github.com/slothsheepking/jobclaw) | 217 | OpenClaw chat-loop agent — the class FounderOS was built as an alternative to. |
| [imon333/Job-apply-AI-agent](https://github.com/imon333/Job-apply-AI-agent) | 179 | n8n + Selenium glue. Has application tracking; we do not. |
| [Liam-Frost/AutoApply](https://github.com/Liam-Frost/AutoApply) | 116 | Closest philosophical match — its one-line description contains both things F1 and F2 say we lack. |
| [Pickle-Pixel/ApplyPilot](https://github.com/Pickle-Pixel/ApplyPilot) | — | Same six stages; generic form driving rather than five hardened adapters. |

**A GitHub search for a job agent on LangGraph + typed contracts + HITL in TypeScript returns nothing.**
The field is essentially all Python, script-shaped, volume-first. On *mechanism* this repository is the
most serious thing in the category.

Counterweight: AIHawk has 30,243 stars; we have two lifetime applications. Not a quality gap — an
outcome gap, and outcome is the stated goal. The field's median project is worse-engineered and better
at the actual job because it solved F1 and F2 before anything else.

## Probability (judgement, not measurement)

Assumes: visa-requiring candidate, NL recognised sponsors + India; cold ATS response in the low single
digits; dominant term is *sustained applications per week*, a founder-behaviour variable. Probability of
≥1 offer within three months.

| State | Estimate |
|---|---:|
| As it stands at `ce99ff6` | **< 10%** |
| F1 fixed (~1 day) | ~25% |
| F1 + F2 fixed (~3 days) | ~40% |
| + warm-intro lane + sustained 15/week | ~65% |

Turns on: applications/week is the whole game (15/wk × 8 wk = 120 → 3–6 conversations; 2/month is
statistically nothing). The base CV is an unknown term neither audit could open. The sponsor pool does
not replenish — applications are scarce non-recoverable inventory, which is why F1 is not cosmetic.

## Portfolio readiness

**The repository — yes, and it is strong.** 3,617 offline tests at $0, real eval harness with golden
tasks and determinism assertions, Postgres-checkpointed LangGraph, HITL with durable-write-before-interrupt
and idempotency, receipt-validated actions, typed failure taxonomy, cost ledger, CI architecture ratchet.
Maps almost exactly onto 2026 AI-engineering rubrics, and eval design — the most-cited signal, the most
under-built thing in most portfolios — is genuinely there.

**The job pipeline as the showcased piece — not yet, and F2 is why.** The first question after "I built
an agent that applies to jobs" is *"how many, and what response rate?"* Today: "two, and we don't measure
responses." That contradicts the repo's own thesis on the exact axis the thesis claims. Fix F2 and it
inverts into the best story here: *"ran N days, sent M, got K responses, failed these four ways, here's
the ledger"* — verbatim the gold-standard framing.

Two things to raise before an interview:
- **Auto-apply cuts both ways.** The field's most-starred project advertises fingerprint evasion, so the
  spam association is earned. Lead with the restraint: never submits unattended (ADR-018), submit click
  is the only gated operation, refuses CAPTCHAs/consent/ambiguous eligibility by type.
- **Still open from 2026-08-22:** Evidence Console does not exist (`src/gateway/web/` and `apps/console/`
  absent, `hono` still 0 imports); README has no screenshot or inline diagram; tests badge reads 3,499
  against a real 3,617.

## Recommended order

1. **F1** — thread the cover letter through submit + add the seam test. ~half a day. Highest value/hour in the repo.
2. **F2** — make the funnel measurable. ~1–2 days. Converts the project from unfalsifiable to evidence-backed, and is the interview answer.
3. **F3** — freeze the registry. 0 hours to stop. If you want supply work: Workday + SmartRecruiters in `detectApplyAts` (~1 day, converts 350 boards).
4. **F8 + F5** — wire the pre-tailoring worker (one line) and the entity check (~40 lines). ~1 day.
5. **F4 + F7** — close the rank-churn race and the triple-writer. ~1 day.
6. **F6 + F9** — measure the tailoring; verify the IND constant. ~half a day.

## Honest limits

- **No production DB** (no SSH client in this container). Newest funnel figure is 2026-08-20; if
  applications have been sent since, "2 lifetime" is stale — F2's severity is unchanged, F3's argument softens.
- **No live browser run.** F1 is proven against live-captured fixtures through the real decision core; the
  divergence is certain, the exact on-page consequence of a blank required textarea is not.
- **The base CV is invisible**, as it was to the 2026-08-22 audit.
- **The probability table is judgement.** I defend the ordering; the absolute numbers are calibrated guesses.
- **Market figures are secondary sources** — which is exactly why F9 asks for a primary-source check.

---

# REV 2 — 2026-08-25: the apply flow moved to the Mac

Re-audited after the apply flow shifted from the VPS headless driver to `mac-client`.
Artifact (same URL, updated): https://claude.ai/code/artifact/ab633e44-f760-4e1a-859f-de176dbc1e5c

**`main` has not moved** — still `ce99ff6`, zero commits since rev 1, no branch ahead of it more
recently than this one, only this PR and a beta sync open. So the shift is visible in already-merged
code, not in new work: `b7235c6` (VPS Ashby route, 08-24) and `a0117b1` (same fix ported to
mac-client, 08-25 00:55) show both lanes maintained in parallel on the same day.

## Verified fresh in rev 2

`pnpm lint` clean · `pnpm verify:arch` 6/6 green · `pnpm test` 3,617 passing across 327 files ·
`python3 -m pytest mac-client/tests -q` → **53 passed, 13 errors**, all 13 environmental (the
pip-installed playwright does not match this container's pre-installed browsers), including a passing
`test_the_cover_letter_and_work_authorisation_are_left_alone`.

**3,617 TypeScript tests and 53 Python tests pass, and the tailored CV still does not reach the
employer by default.** Both suites test their own side of a seam neither crosses.

## The two lanes, side by side

| Dimension | VPS `/apply N` | Mac `mac-client` |
|---|---|---|
| Who presses Submit | The machine, after an HITL card | **The founder, in his own browser** |
| ATS driven | 5 (GH, Lever, Ashby, Workable, Recruitee) | 3 (GH, Lever, Ashby) |
| Boards reachable | 721 / 1,297 (56%) | **514 / 1,297 (40%)** |
| Cover letter | CV markdown pasted in, blank at submit | Deliberately blank, stated + tested |
| Résumé | Tailored PDF from S3 per submit | Tailored if present, else **silently generic** |
| Unknown ATS | Refuses, points at `/draft` | Opens it, fills nothing, says so |
| Outcome recorded | On confirmed submit only | **Crash-safe JSONL ledger, flushed per click** |
| Queue definition | `stage='screened'` + 24h | `brief_section IN (do_today,stretch)`, no age bound |
| Still wired? | **Yes** — `telegram.ts:62`, `capabilities.ts:114` | Yes — the intended primary |

The shift **added** a lane; it did not retire one.

---

## Revised findings

### F1 · CRITICAL · The tailored CV does not reach the employer by default (NEW)

Two independently-reasonable decisions compound into one silent failure.

**Half one — almost no row has a tailored CV.** `tailored_cv_s3_key` is written in exactly two
places: `apply-packet.ts:120`, reached only when the founder personally runs `/draft N`, `/apply N`
or the `tailor_cv` tool *per row*; and `tailor-worker.ts:73` inside `processUntailoredApplications`,
which has **zero callers** in `src/` and `scripts/` and no cron. In a 20-job Mac session only the
rows he individually pre-drafted carry one — which defeats the point of a batch queue.

**Half two — a failed fetch is swallowed.** `mac-client/mac_client/sync.py:168-181` guards on
`returncode == 0 and len(stdout) > 100` and wraps it in a bare `except Exception: pass`.

Then `profile.resume_for()` falls back to the track/default résumé and `missing_resumes()` — the
preflight built to catch résumé problems before the browser opens — reports no problem, because a
file *is* there. Proven against the real functions:

```
SCENARIO A — S3 fetch succeeded, tailored PDF on disk
   resume_for -> tailored_cv.pdf      preflight -> no problems
SCENARIO B — S3 fetch failed (the `except Exception: pass` path)
   resume_for -> generic_ai_cv.pdf    preflight -> no problems
```

The overlay shows the filename and nothing else — the only tell, in a list scanned at speed.

*Unverified:* `$STORAGE_BUCKET` in that command is expanded by the **remote non-interactive** shell,
which frequently does not load the profile that sets it. If unset the path is `s3:///key`, the copy
fails, and per half two nothing is reported. No VPS access to confirm.

**Fix:** delete the bare `except` and report the row + reason; make `resume_for` refuse to substitute
silently when `tailored_cv_s3_key` was set but the PDF is absent; wire
`processUntailoredApplications` into `startScheduler` after each sweep's ranking pass.

### F2 · CRITICAL · Two live apply lanes that disagree, and no tombstone (NEW)

`telegram.ts:62` still registers `bot.command("apply", …)`; `capabilities.ts:114` still lists
`submitApplication`, so the kernel can select it from plain English, not just a typed command. Both
lanes are reachable and disagree on five of the eight rows above.

This repo has a CI-enforced tombstone list (`office-run`, `execution-guard`, `pre-router`,
`fast-paths`) that fails the build if a killed module returns. It has no entry for the VPS apply
driver — because the driver was not killed, it was quietly demoted.

**Fix:** decide which lane is the product. If Mac: unregister `/apply`, drop `submitApplication`,
tombstone the driver. If both: one shared fill plan and one queue definition.

### F3 · CRITICAL · Records `applied` reliably now; still cannot record a reply (REVISED — half fixed)

**Credit first.** The Mac lane fixes the front half of rev 1's F2: `ledger.py` appends one JSONL line
per click and flushes before the queue advances, the outcome is recorded in the same handler the
click reaches, and `push_outcomes` is idempotent by `IS NULL` guard. A dead laptop at job nineteen of
twenty loses nothing. Better than the VPS lane had.

The back half is untouched — still zero writers/callers: `followups_sent`, stages
`replied`/`rejected`/`dormant`, `listLiveApplications()`, `countApplied()`, any
`email → job_applications` link.

So it can now say how many applications went out and still not whether any worked — including the
question F1 raises: *does the tailored CV outperform the generic one?* No instrument could answer it.

### F4 · HIGH · Rev 1's cover-letter defect is not fixed, only demoted (WAS F1)

`apply-commands.ts:88` still passes `coverLetterText: packet.cvMarkdown`; `submit_application` still
builds `RowFacts` as `{ resumePath }` only. Against the live Workable fixture where the field is
`required: true`: preview `kind=value` with the CV markdown, submit `kind=ask` (blank), filled
6/10 vs 5/10. Downgraded because it is no longer the default path; not closed, because F2 shows it is
still reachable — and a defect on a demoted-but-wired path is worse, since nobody watches it.

**The Mac lane's answer is better.** `adapters.py` declares cover letters, work-authorisation and
demographic questions deliberately absent, with the reason written down and a passing test holding it
there. Correct call. It leaves one seam: the letter is generated, slop-checked, archived and
delivered *to Telegram* while the founder is looking at a browser on his Mac.

**Fix:** kill the VPS path; write `cover_letter.txt` into `.queue/{job_id}/` beside the CV and give
the overlay a copy button. He still pastes it — from the screen he is on.

### F5 · HIGH · The shift narrows apply coverage; gap widened 44% → 60% (REVISED, worse)

| Lane | Boards appliable | Share | Not appliable |
|---|---:|---:|---|
| VPS — 5 ATS | 721 | 56% | 576 |
| Mac — 3 ATS | **514** | **40%** | **783** |

Recruitee (113) and Workable (94) are lost. Recruitee stings: it was added on 2026-08-20 *because*
GH+Lever+Ashby matched 0.36% of the IND sponsor register while NL-native platforms matched 2.50%,
with named verified hits (`recruitee/dalsem`, `recruitee/netconomy`, `recruitee/ravo`) — Dutch
recognised sponsors, the exact companies that can carry the permit.

**Fix:** port two `FieldMap` entries into `adapters.py` using selectors `apply-fill.ts` already
captured live. A port, not a discovery exercise. +207 boards.

### F6 · HIGH · `brief_rank` churn — now structural (REVISED, worse)

`runFreeSweep` re-pins `brief_section`/`brief_rank` up to 48×/day. The Mac `QUEUE_SQL` selects
`WHERE brief_section IN ('do_today','stretch') ORDER BY brief_rank` — **the queue is defined entirely
by two columns rewritten every half hour.** Mitigated within a session: the client caches to
`.queue/queue.json` and the browser reads the cache, so the race is between sync and session, not
inside one.

**Fix:** stamp each brief render with an id; record which brief the sync pulled.

### F7 · HIGH · CV "zero hallucination" is a prompt instruction (UNCHANGED)

Only `findSlop()` runs on the output. Nothing checks that employers/dates/titles in the tailored CV
appear in the base CV. `humanise.ts` (136 lines, threshold, full test file) still has zero callers.

### F8 · MEDIUM · ATS keyword claim never measured (UNCHANGED)

`overlapScore()` runs on the base CV only. F1 sharpens it: if most rows ship generic anyway, the
pipeline pays a model call per application for a lift it neither verifies nor delivers.

### F9 · MEDIUM · Three "mark applied" implementations — primary is now psql over SSH (REVISED)

`updateApplicationStage()` (now secondary) · raw SQL in `health.ts` (`/skip` only, still no
`/applied` route) · raw SQL in `mac-client/sync.py` over SSH — **now the path that writes the number
the project exists to move.** Plus dead `markApplied`/`markSkipped`/`countApplied`. Credit:
`sync.py:_uuid()` rejects non-UUIDs before the shell and says why it is the second line of defence.

**Fix:** an HTTP `/api/v1/jobhunt/outcomes` route backed by the existing tested functions;
`push_outcomes` POSTs to it.

### F10 · LOW · IND constant staleness (UNCHANGED)

`HSM_UNDER_30_MONTHLY_EUR = 4357`, re-indexed 1 Jan / 1 Jul, no CI alarm. Check ind.nl, add a dated
assertion failing after 2027-01-01.

---

## What is excellent in the new lane

- **The crash-safe ledger.** One JSONL line per click, flushed before the queue advances, recorded in
  the same handler the click reaches, idempotent push. Best-reasoned component added since rev 1.
- **Refusal as design, now in two languages.** `chooseEligibility` typed to `choose|ask` on the VPS;
  cover letters / work-auth / demographics deliberately absent on the Mac, `None` a first-class
  answer for an unknown ATS, and a `DENY_TERMS` list so the heuristic resolver cannot wander into a
  visa or salary box.
- **The Ashby `/application` discovery**, found live and ported across lanes with a comment naming the
  other implementation — proper cross-lane defect propagation, and also the clearest evidence that
  maintaining two lanes is costing real time.
- **The wake flow that refuses to hijack the screen** — sync, message, stop, with the founder's
  decision and its date in the file.

## Revised probability

| State | Estimate |
|---|---:|
| As it stands today (generic CV by default, no reply tracking, 40% appliable) | **~10%** |
| F1 fixed (~1 day) | ~30% |
| F1 + F3 + F5 (~3–4 days) | ~45% |
| + warm intros + sustained 15/week | ~65% |

The shift did not change the ceiling and moved the floor slightly up: it removes the
machine-submits risk and makes throughput a function of actual clicking, which is the honest
constraint. It did not make the pipeline send its best work or learn from what comes back.

## Portfolio readiness — revised

The repository is still strong, and the migration **adds** a story worth telling: *"I built the
autonomous version, ran it, and moved the submit back to a human click — here is the ADR and here is
what the machine still does."* Choosing less autonomy on purpose, with reasoning written down, reads
as judgement.

The pipeline as the showcased piece is still not ready, and rev 2 adds a second question you would
not want asked: *"did it send the tailored CV?"* Today, on most rows, no — and nothing would have
told you. For a project whose thesis is evidence over assertion, that is the wrong defect to carry.

## Recommended order (revised)

1. **F1** — make the tailored CV actually ship (~1 day). Highest value per hour.
2. **F2** — retire the VPS lane loudly, or unify the two (~half a day).
3. **F3** — close the funnel's back half (~1 day).
4. **F5** — port Recruitee + Workable into `adapters.py` (~half a day, +16% of registry).
5. **F4** — put the cover letter in the overlay (~half a day).
6. **F7 + F8** — entity check, wire `humanise.ts`, re-score overlap (~1 day).
7. **F9 + F6** — one outcome writer, brief-id snapshots (~1 day).

**Founder-only:** read the `ai`-track base CV. Until F1 is fixed the generic CV is not the fallback,
it is the product, and nobody has read it.

## Rev 2 limits

- **Could not see in-flight work.** `main` unmoved, no newer branch, only this PR and a beta sync
  open. Another session mid-change in its own container is invisible here; rev 2 describes
  `ce99ff6` as committed. Anything shipped after supersedes this.
- **No production DB, no SSH.** Cannot count how many rows currently carry a `tailored_cv_s3_key`
  (which would size F1 exactly rather than argue it from the call graph), nor check `$STORAGE_BUCKET`.
- **No live browser run on either lane.** F1 proven against the real `resume_for`/`missing_resumes`;
  F4 against the real `buildFillPlan` and a live-captured fixture.
- **Base CV still invisible.**
- **Probabilities are judgement.** I defend the ordering, not the absolute numbers.

---

# REV 3 — 2026-08-25: F1 confirmed empirically, half fixed

`main` moved `ce99ff6` → `3637f4e`. Another session shipped 11 commits into the Mac lane, and one of
them settles the single claim rev 2 could not verify.

**Rev 2's F1 was right, and understated it.** From the new comment at `mac-client/sync.py:104-112`:

> *"Found live, 2026-08-25: every `_fetch_s3_artifact` call failed silently (`aws: command not
> found`, and even once installed, `$STORAGE_BUCKET` was empty) for both the cover letter and the
> pre-existing tailored CV — the function's designed-to-be-silent failure mode had hidden a fetch
> that had never once worked."*

Rev 2 argued from the call graph that "almost no row carries a tailored CV". The measured answer is
**zero rows ever have**. `awscli` was not installed on the VPS at all. Every application the Mac lane
has ever sent used the generic CV.

This is the clearest possible vindication of the finding *and* of why it was rated critical: three
correct comments about failing loudly sat in neighbouring files while a bare `except Exception: pass`
hid a fetch that had never worked once. Rule #27, exactly.

## What is now fixed

| Rev 2 finding | State |
|---|---|
| F1 half one — swallowed fetch / `$STORAGE_BUCKET` | **FIXED** — `3672c58` sources `/opt/founderos/.env`; `89c6b69` pins the command; `awscli` added to `docs/guides/DEPLOYMENT.md` |
| F4 — cover letter never reaches the founder at the form | **FIXED, well** — `f0b2aa4` syncs it from S3 beside the CV, `c2f3cf2` copies it to the clipboard on open, `dc80f0a` shows in the overlay whether one was found, with decode/permission guards (`923eb71`, `c1d86a2`) |

## What is still open, and now sharper

- **F1 half two — the silent substitution.** `_fetch_s3_artifact` now returns a bool and
  `save_queue` **discards it at both call sites** (`sync.py:205`, `sync.py:207`). `profile.py` is
  unchanged, so `resume_for()` still substitutes the generic résumé and `missing_resumes()` still
  reports "no problems". Now that the fetch *can* succeed, whether a row ships tailored or generic is
  a live per-row outcome that nothing reports — worse to leave than when it always failed.
- **F1 half three — nothing tailors in bulk.** `processUntailoredApplications` still has zero callers.
- **F2 — two live lanes.** `telegram.ts` still registers `/apply`; `capabilities.ts` still lists
  `submitApplication`. Unchanged.
- **F3 — reply tracking.** Unchanged, zero writers.
- **F5 — 3-ATS coverage.** `_HOST_MARKERS` unchanged; Recruitee and Workable still unreachable.

## Revised probability

Unchanged at ~10% today — the tailored CV still does not reliably ship. But the distance to the next
band shrank: F1a and F4 were two of the five things standing between here and ~30%, and both are
done. Finishing F1b + F1c is now roughly a day.

Execution brief updated in place: `docs/plans/2026-08-25-jobhunt-apply-completion-brief.md`
(T1a and T5 marked DONE; T1b promoted to START HERE).

---

# REV 4 — 2026-08-25: the brief was executed; the constraint moved to fabrication

`main` moved `3637f4e` → `ab0c170` (PR #576). A fresh session picked up
`docs/plans/2026-08-25-jobhunt-apply-completion-brief.md` and shipped nearly all of it. The founder
made the T2 call. One task was built and then **rejected on review**, for a reason that is now the
most important finding in this document.

## What shipped

| Brief task | State | Evidence |
|---|---|---|
| T1a — swallowed S3 fetch / `$STORAGE_BUCKET` | **DONE** | `3672c58`, `89c6b69` |
| T1b — silent generic substitution | **DONE** | `e659826` — `uses_tailored_cv()` + a three-state overlay label |
| T1c — bulk tailoring cron | **BUILT, THEN REJECTED** | `400d145` then `fff7340` — see below |
| T2 — retire the VPS lane | **DONE, founder decision** | `e7f1288` + `fff7340` orphan sweep |
| T3 — reply tracking | **DONE** | `c7dfcd2` — `pipeline-followup.ts`, `/replied`, `/rejected` |
| T4 — Recruitee + Workable | **DONE** | `761084e` |
| T5 — cover letter to the Mac | **DONE** (earlier batch) | `f0b2aa4`, `c2f3cf2`, `dc80f0a` |

Verified in the merged tree, not taken on report:

- `/apply` is gone from `telegram.ts`; `/replied` and `/rejected` are registered in its place.
- `submitApplication` is gone from `capabilities.ts:113`, with the founder decision named in the comment.
- `verify-architecture.ts` now tombstones `apply-commands.ts`, `apply-headless.ts`, `apply-driver.ts`,
  `apply-scrape.ts`, `apply-fill.ts` — so rev 2's F2 is closed *by mechanism*, not by intention.
  That is the exact remedy F2 asked for.
- `pipeline-followup.ts` implements the weekly digest and the day-7/14 nudge as deterministic
  zero-LLM sweeps — the right lane for it.

**Rev 2's F1, F2, F3, F4 and F5 are all now closed or materially closed.**

## The two numbers that came out of it

The brief's whole purpose was to produce measurements this audit could not make. It did:

1. **4 of 62 queue rows carried a tailored CV. The other 58 fell back to generic with no warning
   shown anywhere.** (`profile.py`, `uses_tailored_cv` docstring, measured against the real queue.)
   Rev 2 argued this from the call graph; rev 3 recorded that the fetch had never once worked; rev 4
   has the row count.

2. **`tailorCv()` invents skills the base CV does not contain — 36 fabricated claims across 4 CVs**
   (Kubernetes, PyTorch, Domain-Driven Design, FastAPI), found in end-to-end QA against real queue
   rows. Nothing catches it: `findSlop()` is a banned-word list, not a claim check.

## Why T1c was rejected, and why that is correct

`fff7340` removed the bulk-tailoring cron that `400d145` had just added. Two reasons, both good:

- **Founder judgement:** tailoring is a deliberate act triggered by `/draft N`, not something that
  should happen to a queue row silently in the background. T1b's three-state overlay label already
  makes an untailored row honest without manufacturing a CV for it.
- **Safety:** running an unguarded fabricating tailor on a 30-minute cadence against a 606-row
  backlog would spend the IND sponsor pool — finite and non-renewable — on fabricated résumés.

I proposed T1c and I think rejecting it was right. Rule #28 in the other direction: my brief
authorized the work and did not verify it was safe. The safety argument only became visible once
someone ran it against real rows, which the brief told them to do first. That is the process working.

The commit is explicit about the condition for revisiting: *"Do not re-add the batch cron without a
fabrication guard in front of it."*

## The constraint has moved

Every finding this audit opened with is closed. The binding constraint is now **F7 — the CV's
"zero hallucination" rule is a prompt instruction, not a mechanism** — which rev 1 rated High and
which is now measured at 36 fabricated claims across 4 CVs.

Independently verified against the merged tree: `tailor-cv.ts` gained only cost-attribution metadata
in this batch. **No fabrication guard exists.** The consequence is now two-sided:

- it **blocks throughput** — bulk tailoring cannot be re-enabled without it, so the pipeline is
  capped at whatever the founder personally `/draft`s;
- it **is a live risk on every manual `/draft`** — a fabricated skill on a CV is something he will be
  interviewed about, on the record.

This is the same asymmetry rev 1 named: a misread salary figure earned `extract.ts`, 383 lines of
pure parser with its own suite, while a fabricated employment claim is protected by a sentence in a
system prompt. Rule #27, still unpaid.

**Recommendation, and it is now the only one that matters:** build the entity check (rev 2's F7 fix,
brief T6). ~40 lines — extract capitalised entity spans and `YYYY` / `Mon YYYY` tokens from the
tailored output, assert each appears in the base CV, fail the packet naming the offending span. Same
shape as `validateStepResult`. Then re-add the batch cron behind it, and the throughput ceiling lifts
at the same time as the risk closes.

## Revised probability

Rev 3 said ~10% today, ~30% with F1 fixed. F1 is fixed, and F2–F5 with it, so the honest number moves
to roughly **30%** — with the caveat that the throughput ceiling is now the founder's own `/draft`
rate, because bulk tailoring is correctly disabled until the guard exists. Building the guard is what
converts ~30% into the ~45% band, and it is about a day.

## Verified fresh on the merged tree (rev 4)

`pnpm lint` clean · `pnpm verify:arch` 6/6 green, **`orphan-subsystem` still 0 after the tombstones**
· `pnpm test` **329 files, 3,614 tests passed** (146s) · `pytest mac-client/tests` **80 passed, 13
errors** — the 13 are the same environmental playwright-browser mismatch this container has always
had. 80 + 13 = 93, which reconciles exactly with the executing session's reported 93/93 on a Mac with
browsers installed.

## Rev 4 limits

- **The two headline numbers (4/62 rows, 36 fabricated claims) are from the other session's QA**, not
  measured by me — I have no database access and no model budget here. I verified the *code state*
  they describe: `tailor-cv.ts` has no claim check, `uses_tailored_cv` exists, the tombstones are
  real. The counts I am relaying.
- **No live application has been sent yet** as far as this tree can show. The funnel numbers in
  Section 02 remain at their 2026-08-20 values.

