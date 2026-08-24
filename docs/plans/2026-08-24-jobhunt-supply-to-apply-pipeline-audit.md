# Job pipeline audit — supply → apply, end to end

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
