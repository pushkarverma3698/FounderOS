# 2026-09-04 — Multi-profile job hunt: audit, then remediation

## What we did

Picked up `feature/multi-profile-jobhunt` (Antigravity's multi-candidate refactor
of the job pipeline) as an adversarial review, found the branch could not produce
a single job for the second candidate in production, and then — on the founder's
direction and with the two blocking facts he supplied — made it production-ready.

Two things about the handoff were wrong before any code was read:

1. **None of the work was committed.** `feature/multi-profile-jobhunt` at
   `58c9ddc` contained only two unrelated Vertex-AI commits. All 33 files lived
   as uncommitted changes in the main worktree, interleaved with a separate
   in-flight OmniRouter task (`src/agents/model.ts`, `.env.example`,
   `omni_router/`, six `test_*.ts` scratch files at the repo root).
2. **`agy-guard` reported BUSY.** No source file had been written in 96 minutes,
   so the flag was an idle Antigravity GUI conversation DB rather than live
   edits — but per rule #31 the review ran against a frozen snapshot replayed
   into an isolated worktree, and the founder's tree was never touched.

## What we fixed

### The one that mattered

**The wife's profile could never produce a job.** `sweep-runner.ts`,
`infra/scheduler.ts` and every gateway file were untouched by the diff. Both
sweeps called `buildDailyBrief({...})` with no profile and `screenBatch(postings)`
with no profile at all five call sites. Only the manual rescreen script ever
passed one. Every module *downstream* of the sweep took a profile; the sweep
never gave it one — and because "argument not passed" type-checks against an
optional parameter, 3,617 tests and six architecture ratchets could not see it.

`runFreeSweep` now polls the 1,297 boards **once** and loops `listProfiles()`,
handing the same `BoardSweep` to each. `runPooledIngest` takes a profile and
derives both its track fan-out and its billed pools from it.

### The one that would have been worse

The founder confirmed: **she is on a zoekjaar (orientation year) permit, born
7 April 2001.** The branch encoded `permitBases: ["hsm", "partner-permit"]`.

A zoekjaar holder has free access to the Dutch labour market — no recognised
sponsor, no work permit, no IND salary criterion. The branch's only end-to-end
test asserted a `pass` carried by `partner-permit` — a permit she has never held,
whose gate profile happens to clear both the sponsor check and the salary floor.
The test was green *because* it screened her under someone else's right to work.

**Correction, after live testing.** My first account of this said the shipped
config "would have rejected most of a market she can lawfully work in". That was
wrong. `partner-permit` was *masking* `hsm`, so the shipped config mostly reached
the right verdict — by way of a false statement about her immigration status,
printed to the founder as the reason. Three arms of the same real posting, run
live: `hsm`+`partner-permit` → PASS on a permit she does not hold;
`hsm` alone → FLAG (sponsor + salary); `zoekjaar`+`hsm` → PASS, correctly
explained. The reach argument was about the middle arm, which was never the
shipped state. The real defect — a fabricated legal basis rendered as evidence —
is bad enough without the exaggeration.

`zoekjaar` is now a real `PermitBasis` with its own gate profile, in `NL_BASES`
and deliberately **not** in `UNCLEAR_BASES` — it is now the most permissive Dutch
basis, so letting it carry an unlocated posting would put a Bogotá role back into
APPLY TODAY on a new permit. `hsm` stays as her second basis because the
orientation year is time-boxed, so the route label distinguishes a role that ends
with the permit from one an employer could sponsor afterwards.

### Three dead fields, all claimed as working

| Field | Claimed | Actual |
|---|---|---|
| `visaRequiresSponsor` | REVIEW.md §2 #7: "guarded the IND register lookup" | **Zero readers.** The guard read `gateProfile(route).sponsorRequired` — the route's config, not the candidate's. Deleted; sponsor applicability is a property of the basis. |
| `profile.dob` | Implied by the two salary-floor fields | **Zero readers.** `criterionOn` defaulted to `FOUNDER_DOB`, so she would have been screened against Pushkar's age band. Now threaded through `screenSalaryFacts`. |
| `JobSearchProfileSchema` | "contract-validated" | Never `.parse()`d — a type annotation is erased at runtime. `registerProfile` now parses, and rejects a `trackPriority` naming an undefined track. |

### Cross-profile contamination the first audit marked VERIFIED

- `getApplicationByBriefRank` got a `profileId` **parameter**; no caller passed
  it, and the default was *no filter*. `/draft 3` was a coin flip between two
  people's row 3 — a tailored application about the wrong company, on the wrong
  CV, under the wrong right to work.
- The free lane's `keepUnseen` called `findApplicationByDedupeKey(key)` unscoped,
  so the first profile to screen a posting marked it "already in the tracker" for
  the other — starving the second candidate's lane, silently, as a `known` count
  that looks like healthy dedupe.
- `listApplyQueue()` was unscoped in `jobhunt-commands.ts`, `jobhunt-view.ts` and
  `sheet-export.ts`.
- **`mac-client` had zero `profile_id` awareness.** Its `QUEUE_SQL` filtered on
  tenant alone, so the Python apply automation would have pulled her finance
  roles and uploaded whichever resume its own track map resolved — Pushkar's
  backend CV to an ING accounting vacancy.

The shared cause: `profileId?: string` with `if (profileId) conditions.push(...)`.
An optional filter that is simply omitted makes a caller who *forgot*
indistinguishable from one who meant "all candidates". Replaced with
`profileCondition(scope)`, which defaults to the default **profile**, with an
explicit `ALL_PROFILES` symbol for the rare caller that means everyone.

## Why

**Green CI is not the verdict.** The first `pnpm gate` reproduced exactly:
3,617/3,617, 0 tsc errors, 6/6 ratchets — and the branch still delivered nothing.
Every gap was a missing argument on an optional parameter, which is precisely the
shape a type checker and a unit suite cannot see. The audit table's "✅ VERIFIED"
described function signatures, not behaviour.

The LOC ratchet was the one gate that *did* catch a real regression: my own
threading pushed `free-ingest.ts` to 433 and `ingest.ts` to 431 against a budget
of 400. Extracted `free-ingest-filters.ts`, `ingest-pools.ts` and
`jobhunt-profile-arg.ts` rather than raising the baseline.

## Metrics

- Findings: **14** (5 blockers, 3 high, 5 medium, 1 low) + **4 false claims** in
  the prior audit's own table.
- New tests: **24** — `multi-profile-isolation` (11), `sweep-multi-profile` (6),
  `profile-arg` (7), plus 2 in `mac-client/tests/test_sync.py`.
- Corrected tests: 4 files. `manual-qa.test.ts` Scenario 6 now asserts the
  `zoekjaar` route **and** that `profile_id` is actually persisted — the thing
  §4 claimed was verified while the mock swallowed the argument unasserted.
- Cost: free lane unchanged (one poll, screening is pure code). Metered lane
  fans out per profile, but `poolsForProfile` gives a Netherlands-only candidate
  3 queries against Pushkar's 8. The binding ceiling is still `spend-gate.ts`,
  in dollars, before the first actor call.

## Outstanding

1. **Her CV files do not exist.** Every path in `wife-nl-finance.ts` and
   `apply-profile-wife.example.json` points at a file that is not on disk
   (`mac-client/cv/` holds only Pushkar's five PDFs). `readFullCvText` fails
   loudly rather than substituting his CV — the correct direction — but until
   those files exist her rows rank at 0 overlap and `/draft wife N` refuses.
2. **`candidateName: "Wife"` and the example contact details are placeholders.**
   The name reaches the agent prompt and the application packet.
3. **The reduced HSM salary criterion for orientation-year switchers is not in
   `criteria.ts`.** The `hsm` basis currently uses the standard under-30 figure,
   which is the strict direction and costs nothing in reach (the `zoekjaar`
   verdict wins anything the stricter basis flags), but the `hsm` signal is
   pessimistic until someone verifies the reduced figure on ind.nl.
4. **The work still needs committing off the founder's tree.** The remediated
   branch is `claude/multi-profile-jobhunt-audit-facd55`; the founder's own
   worktree still holds the original uncommitted changes mixed with the
   OmniRouter task.
5. **Migration 0036 has not been run anywhere.** It backfills `profile_id` then
   sets `NOT NULL` — a NULL does not conflict in a unique index, so a nullable
   column would have silently turned the double-apply gate into a no-op.

## Live verification (same session, after the fixes)

Everything under "Outstanding" that said "not verified" was then run for real.
`scripts/verify-multi-profile-live.ts` (`pnpm jobhunt:verify-multi-profile`) polls
real boards, screens both profiles off one poll, and reads the database back. $0:
the free lane's screening path imports no model.

- **1,297 boards, 47,115 postings, one poll, 176s.** Pushkar 928 screened, Wife 66.
- **43 of her 66 PASSED** — Alpha Sense Associate Financial Analyst, Capco
  Financial Analyst, Dyson Lead VAT Accountant, four Compliance Analyst roles.
  Routes: 62 `zoekjaar`, 6 `hsm`. Before this branch the number was structurally zero.
- **Zero cross-profile leakage** on every query, `/draft`, `/csv`, and the
  mac-client queue. `/draft 1` → his Nebius row, `/draft wife 1` → her Dyson row.
- mac-client: **95 pytest passed**, including 13 real-browser Playwright tests.

### The blocker only a live run could find

`0021` created `ja_brief_rank_uniq` on `(tenant_id, brief_section, brief_rank)`.
`0036` rebuilt `ja_dedupe_uniq` with `profile_id` and missed this one. Both briefs
number from 1, so the second profile to rank collided on `do_today` rank 1 and
`recordBriefRanks` threw — every run, deterministically.

Invisible from outside: her brief rendered in full, 14,000 characters, correct
numbers on screen, and only the *write* of those numbers was lost inside a tagged
fail-open. That fail-open's comment argues a lost rank is "loud and recoverable" —
true with one profile, false with two, where every `/draft wife N` fails forever.

The application code was already correct; the constraint lived only in SQL, and
the unit suite mocks the database. `tsc`, 3,600 tests and six ratchets stayed
green throughout. `tests/unit/db/job-applications-unique-indexes.test.ts` now
replays every migration's DDL and fails if any surviving unique index on
`job_applications` lacks `profile_id`.

### A defect I introduced, caught by the same run

With the sweep injectable, `runFreeIngest` logged the *registry* size rather than
what was polled — and `runFreeSweep` always injects, so production would have
reported `boards: 1297` on every sweep. Now logs `sweep.boardsPolled`.

### Checked and clean

`IngestLine.detail` is `reasons[0]` (reason-by-position, the 2026-08-01 defect
shape) but has no consumer in `sweep-runner.ts` or `src/gateway/` — it never
reaches the founder. Rank clearing is profile-scoped. Missing CVs fail loudly
naming HER files, with no fallback to Pushkar's at any point.

### Still not verified

Nothing has been applied to production — `0036` has run against the dev Postgres
only. No application has been sent for her, and none can be until her CVs exist.
The zoekjaar gate profile encodes my reading of Dutch policy; no source in this
repo establishes it.
