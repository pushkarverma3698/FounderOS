# Jobhunt apply pipeline — audit findings + fix design

**Date:** 2026-08-08
**Status:** Approved by founder (chat, 2026-08-08)
**Base:** builds on `feat/mac-apply-client` / the design in
`2026-08-06-jobhunt-apply-loop-design.md` (already shipped: sync, overlay,
per-ATS field maps, ledger)

## Outcome this serves

The apply loop from 2026-08-06 shipped and is live-queued (7 rows synced to
`mac-client/.queue/queue.json` as of this session). Zero applications have
ever been recorded through it. This session's job was to find out why by
running the real pipeline end-to-end, not by reading the code and assuming it
works — and the founder handed in the reproduction case directly: rank-1 in
today's queue is `https://job-boards.greenhouse.io/adyen/jobs/8114306`, a
dead posting.

## Audit findings (each verified against the live system, not inferred)

### Finding 1 — Dead postings rank #1 and reach the founder

`classifyHttpStatus()` in `src/tools/jobhunt/liveness.ts:75` classifies
purely on the final HTTP status after following redirects. Reproduced live:

```
adyen/jobs/8114306      → status=200  finalUrl=…/adyen?error=true  redirected=true   → "live" (WRONG)
gitlab/jobs/8632496002  → status=200  finalUrl=unchanged           redirected=false  → "live" (correct)
```

Greenhouse answers a deleted posting with a 302 to the board root plus
`?error=true`; the board root itself serves 200. The verdict function reads
only `response.status` — `response.url` and `response.redirected` are
discarded, which is the only place the "gone" signal survives after
`redirect: "follow"`. The module's own docstring already distinguishes "a 3xx
must not mean gone" (true — canonical redirects exist) from "so check where it
landed" (never implemented).

Cost: a dead job spends one of the founder's ~1-2 daily review minutes and
sits at rank 1 ahead of live roles.

### Finding 2 — The ledger can record a submission that never happened

`mac_client/overlay.js:73-75`: clicking the employer's submit button starts a
1200ms timer, then unconditionally calls `founderosDecision("applied")`. It
never checks the click succeeded. Because ADR-009 deliberately leaves
work-authorisation, cover-letter, and every custom question blank, a
validation-blocked submit (page stays on the form, red error text appears) is
the *expected* case for many postings — not an edge case. In that case the
ledger says `applied_at = now()` while the application was never sent, which
is exactly the founder-facing failure mode the module's own docstring
(`apply.py:1-13`) names as the reason the prototype it replaced was thrown
out.

### Finding 3 — 57% of the live queue has zero form automation

`adapters.py` covers three ATS platforms (Greenhouse, Lever, Ashby) via
`_HOST_MARKERS`. The queue synced this session:

| Company | ATS | Covered? |
|---|---|---|
| Adyen, gitlab, Capco | Greenhouse | yes |
| Apiux Tech | Teamtailor | no |
| Last Call Media | Workable | no |
| INFOMEDIJI | Recruitee | no |
| Aquablu | Recruitee | no |

4 of 7 rows get `field_map_for() → None` → every field is manual.

### Finding 4 — Track-tailored CVs are not actually tailored

`mac-client/cv-backend.pdf` and `cv-frontend.pdf` are byte-identical
(md5 `55df883b…` both). `tailored_cv_s3_key` is `null` on all 7 queued rows —
`tailor-worker.ts` has never successfully run against them, or its output was
never wired to the queue. `tailorCv()`'s system prompt tells the model to
avoid "AI buzzword cliches" but nothing checks the output against that
instruction — an unenforced instruction, per the project's own rule #27.

### Finding 5 — No jobhunt surface in the frontend

`apps/jarvis-next` (React 19 + WebGPU reactor console) has no queue view; the
only place to see or act on the queue is the Python CLI. `src/infra/health.ts`
already runs an HTTP server on `:3001` with `/api/v1/dispatch` and
`/api/v1/hitl/respond`, and the frontend already talks to it — a real seam
exists to extend, not a new server to stand up. That server currently sets
`Access-Control-Allow-Origin: *` with no auth check on any route.

## Decisions (founder, 2026-08-08)

| Question | Decision |
|---|---|
| ATS coverage strategy | Generic field resolver (matches by autocomplete/type/label/name signal) as a fallback under the existing hand-written Greenhouse/Lever/Ashby maps, which stay as high-confidence overrides. Plus: route CV generation through the `no-ai-slop` skill so every tailored CV is checked, not just prompted. |
| Frontend scope | Review + triage only. The browser shows the ranked queue, liveness, gate reasons, and which CV is attached; skip/re-rank happen there. The Playwright client remains the only thing that drives real ATS forms — no duplicate apply path. |
| Dead-posting handling | Pull from the apply queue (never offered for review), keep the row in Postgres with the liveness evidence attached and visible, AND re-verify at the moment the Mac client opens the page (a job can die in the hours between sweep and apply — sweep-time-only verification does not catch that). |

## Design

### 1. Liveness — read where the redirect landed, not just the status

`src/tools/jobhunt/liveness.ts`: replace `classifyHttpStatus(status: number)`
with `classifyResponse(input: { status: number; requestedUrl: string;
finalUrl: string; redirected: boolean }): Liveness`. Still pure, still the
same three outcomes (`live` / `expired` / `unverifiable`), still unit-testable
without a network — only the input signal changes.

New rule, applied only when `redirected` is true:
- If the final URL still contains the posting's distinguishing path segment
  (job id / slug) → treat as canonicalization → `live`.
- If the final URL drops that segment and lands on a board root, listing
  page, or search page (or carries an explicit error marker such as
  `?error=true`, `/not-found`, `/expired`) → `expired`.
- Anything else that redirected ambiguously → `unverifiable` (the existing
  asymmetry holds: ambiguity keeps the row, it never silently drops it).
- Non-redirected 404/410 unchanged (`expired`). Non-redirected 2xx unchanged
  (`live`). 5xx/429/network errors unchanged (`unverifiable`).

This is written generically against URL structure, not as an
Adyen/Greenhouse special case — Lever, Ashby, Workable, Teamtailor and
Recruitee all resolve a dead posting to a board root or an explicit 404, so
the same rule covers them without per-platform branches.

`checkUrl()` passes `response.url` and `response.redirected` through instead
of discarding them.

### 2. Mac client — two gates that do not exist today

**Pre-flight liveness re-check** (`apply.py::process_job`, right after
`page.goto`): compare the landed URL against the requested URL using the
*same* classification rule as §1 (ported to Python, see DRY note below). If
the posting reads as `expired` at open time, skip the fill and overlay
entirely: record `skipped` with reason `"posting no longer available (caught
at open, not at sweep time)"`, and advance to the next job. This is the
second gate the founder approved — sweep-time verification alone does not
catch a posting that closes in the hours between sweep and apply.

**Post-submit confirmation** (`overlay.js`): replace the unconditional
1200ms-then-`applied` timer with a real signal check after the submit click —
poll for one of: the URL leaving the application path, a confirmation
element appearing (`text=/thank you|application (received|submitted)/i` or
similar), or the form element detaching from the DOM. Bounded wait (a few
seconds). If none of those fire, do **not** record `applied` — surface
"submit didn't confirm; check the page and press SKIP or SUBMIT again" and
leave the decision to the founder. This directly closes Finding 2: the case
this catches is precisely the expected one (blocked by a required field the
tool correctly left blank), not a rare failure.

**DRY note:** the redirect-classification rule now needs to exist in both
TypeScript (sweep-time) and Python (apply-time). Rather than two hand-written
implementations that can drift, both read the same
`fixtures/delisting-cases.json` table of `{requestedUrl, finalUrl, redirected,
status, expected}` cases (covering all 5 ATS platforms in today's queue). A
drift between implementations shows up as a failing test on whichever side
lags, not as a silent divergence discovered live.

### 3. Field resolver — generic fallback under the existing maps

New `mac_client/resolver.py`. `fill_form()` in `apply.py` tries
`field_map_for(job.url)` first (unchanged — Greenhouse/Lever/Ashby keep their
precise, hand-verified selectors). For any `label` the map didn't cover, or
when `field_map_for()` returns `None` entirely, the resolver scores every
visible `<input>`/`<textarea>` on the page against the profile fields it
knows how to fill (name, email, phone, linkedin, website, resume).

Scoring, highest-confidence signal first:
1. `autocomplete` attribute (`given-name`, `family-name`, `email`, `tel`,
   `url`) — near-certain.
2. `type` attribute (`email`, `tel`, `file`).
3. Associated `<label>` text, `aria-label`, `placeholder`, `name`, or `id`
   matched against a small synonym list per field.

A field fills only when exactly one candidate clearly wins on the highest
tier that produced any match; a tie or a weak match is left blank and
reported in the "skipped" list, same as today's behavior for unmapped fields.
Nothing here changes the founder-facing contract: filled vs. skipped is still
shown on the overlay badge before any click is possible.

**Deny-list is part of the resolver, not bolted on after.** Work
authorisation, visa/sponsorship, salary expectation, notice period, and any
demographic question are never filled by the resolver even on a confident
signal match — this is the same boundary `adapters.py`'s own docstring
already draws for the hand-written maps ("a tool that types a plausible
answer into a work-authorisation question is not saving the founder time —
it is making a legal claim on his behalf that he never read"). The resolver
inherits that boundary explicitly rather than being trusted to reinvent it.

### 4. CV tailoring — no-ai-slop as a mechanism, not a prompt line

Current state: `tailorCv()`'s system prompt says "avoid AI buzzword cliches"
and nothing verifies it, and the two on-disk track CVs are proven identical —
so whatever is supposed to be happening, isn't.

Port the relevant parts of `~/Projects/githubtools/no-ai-slop/SKILL.md` (the
banned-word list and the named patterns — binary contrasts, throat-clearing
openers, colon reveals, importance puffery, weasel attribution, fake-strong
verbs) into `src/tools/jobhunt/slop-rules.ts` as data, plus a pure
`findSlop(text: string): SlopViolation[]` (word/pattern, matched text, line).
This is deterministic pattern-matching, not an LLM call — $0, unit-testable.

`tailorCv()` gains a check step: generate → `findSlop()` on the result → if
violations exist, one targeted revision call that quotes the exact offending
lines and asks for a fix (not a full regeneration) → `findSlop()` again → if
still violating, return `success: false` with the violations listed rather
than uploading a CV that fails the founder's own bar. Fail loud, per
Finding 4's root cause: an unenforced instruction is not a control.

### 5. Frontend — a QUEUE tab, review-only

New route/tab in `apps/jarvis-next`'s existing `NavRail`, reusing current
glass-card styling (`GlassMetricCards.tsx` as the visual reference).

Two new read-mostly endpoints on the existing `:3001` server
(`src/infra/health.ts`):
- `GET /api/v1/jobhunt/queue` — ranked rows currently in `do_today`/`stretch`
  with `applied_at`/`skipped_at` both null, each with liveness verdict +
  reason, screening-gate reasons, track, and whether a tailored CV is
  attached.
- `POST /api/v1/jobhunt/:id/skip` — same effect as the Mac client's SKIP
  (stamps `skipped_at`), so triage started in the browser and finished on the
  Mac stay consistent.

No apply/submit endpoint — that stays exclusively in the Playwright client
per the founder's decision; the browser is where you decide, the Mac client
is where you act.

**Security note (flagging, not silently fixing beyond scope):** `health.ts`
currently serves `Access-Control-Allow-Origin: *` with no auth on any route.
Adding job-application data (names, emails are not exposed, but company/title/
URL/track data is) widens what an unauthenticated LAN caller can read. Given
this server already exists and already has this posture for `/api/v1/dispatch`,
the jobhunt routes will bind behind the same guard the dispatch route uses
today — if none exists today beyond CORS, that's a pre-existing gap this
design does not by itself close, and is called out explicitly rather than
assumed away.

## Error handling

| Failure | Behaviour |
|---|---|
| Redirect lands ambiguously (neither clearly canonical nor clearly delisted) | `unverifiable` — row stays, reason shown |
| Posting dies between sweep and apply-session open | Caught at pre-flight (§2), skipped with reason, never shown blank/broken |
| Submit click produces no confirmation signal | Nothing recorded; founder told to check and decide |
| Resolver field match is ambiguous or on the deny-list | Left blank, reported in skipped list — never guessed |
| CV fails `findSlop()` after one revision attempt | Tailoring marked failed with violations listed; queue row falls back to the base track CV, never silently ships slop |
| `/api/v1/jobhunt/queue` called with the VPS Postgres unreachable | Returns the same tolerant-degraded shape `buildHealthReport()` already uses elsewhere, not a hard 500 |

## Testing ($0, per cost-control rules)

- `classifyResponse` (TS) and its Python port: table-driven against the
  shared `fixtures/delisting-cases.json`, covering all 5 ATS platforms seen
  in today's queue, including the live Adyen case reproduced this session as
  a permanent regression fixture.
- `findSlop()`: unit tests per banned word and named pattern, plus a
  known-clean sample that must produce zero violations.
- Resolver scoring: pytest against local `file://` HTML fixtures per
  platform (no live ATS traffic in tests) — covers confident-match,
  ambiguous-match, and deny-list-present cases.
- Frontend queue tab: component test + one Playwright check that the tab
  renders real API shape (mocked server), not the `webapp-testing` skill's
  live browser.
- Live E2E (after unit suites are green, run once): real postings on
  Greenhouse, Workable, and Recruitee, checked visually via the browser
  vision tools — including confirming the dead Adyen URL now shows
  `expired`/skips cleanly instead of reaching rank 1.

## Explicitly out of scope

- Rebuilding the apply flow inside the browser (founder declined — cross-origin
  iframe embedding of employer forms mostly cannot work; the Mac client stays
  the only thing that submits).
- Auto-answering work authorisation, visa, salary, or demographic questions —
  unchanged from ADR-009 and Finding 3's own boundary; the resolver's deny-list
  makes this explicit rather than assumed.
- Adding hand-written adapters for teamtailor/workable/recruitee individually
  — superseded by the generic resolver decision.
- Fixing the `health.ts` server's auth posture beyond binding the new routes
  to whatever guard already exists — flagged in §5, not solved here.

## Verification before ship

1. `pnpm gate` green (TS side); `pytest` green in `mac-client/` (Python side).
2. Fixture regression: the live Adyen URL (`job-boards.greenhouse.io/adyen/
   jobs/8114306`) classifies as `expired`, not `live`.
3. One live end-to-end apply session against a real non-Greenhouse posting
   (Workable or Recruitee) using the generic resolver, screenshotted via
   vision tools before any click.
4. QUEUE tab in `jarvis-next` renders the real (not seeded-demo) queue against
   a running `:3001` server.
