# Thesis vs. Reality

Each claim from the five strategy documents, classified and checked against the running system.
Source-of-truth order: runtime → repository → tests → thesis → docs.

---

## A. CONFIRMED — thesis was right, evidence found

| # | Claim | Class | Evidence |
|---|---|---|---|
| A1 | "User asked for a CSV and did not receive a completed artifact" | OBSERVATION | Prod turn `a194c5e5` 2026-08-08T05:23:32Z. Reply = CSV text inline, 3 rows named, no file. See `08-EXECUTION-AUDIT.md`. |
| A2 | "Same jobs surfaced repeatedly" | OBSERVATION | 39 job rows total, newest `2026-08-07 18:30`. `brief_section`: 6 `do_today`, 4 `ask`, 1 `stretch` — a **static** set re-rendered on every ask. |
| A3 | "System leakage into Telegram" | OBSERVATION | Founder was shown `cd ~/Projects/founderos/mac-client && .venv/bin/python -m mac_client.apply`. Confirmed in transcript. |
| A4 | "Verification of real outcomes is weak" | PROBLEM | `src/kernel/verify.ts`: `VERIFIERS` has **1 entry** (`comms`, regex placeholder check). 7 of 8 workers have no verifier. |
| A5 | "Objective ownership stops" | PROBLEM | Planner emits steps; nothing compares the final reply to `mission.goal`. `writeTaskOutcome` (`src/db/queries.ts:528`) has **zero production callers**. |
| A6 | "Eval measures routing, not objective completion" | OBSERVATION | `eval-report.md` 2026-08-06: routing 71%, tool selection 42%, **overall 29%**, 27/41 tasks dropped as infra errors. |
| A7 | "Instruction overhead is large" | PROBLEM | 1,342 lines across 7 root instruction files; 22,403 lines across 173 `docs/*.md`. |
| A8 | "Dead/legacy implementations still present" | PROBLEM | `src/outreach` (648 LOC), `src/workflows` (372), `src/bench` (198), `src/proof` (122) have **zero importers** in `src/`. |
| A9 | "Too many tool choices at the decision point" | PROBLEM | Planner prompt lists **79 tool slots / 65 unique tools** across 8 workers, every turn. |

---

## B. FALSE — thesis premise does not match this repository

**These three would have produced wasted or harmful phases. They are removed from the roadmap.**

### B1 — "Hermes is a competing browser/skills agent that FounderOS never routes to"

**FALSE.** `grep -rni hermes` returns 6 hits. Hermes in this repo is two unrelated things:

- `src/kernel/lessons.ts` — *"the Hermes learning seam"*: failure-lesson memory. **Already wired**
  into the dispatch node via `makeLessonDispatch`, Postgres-backed, injected. Prod has 2 rows in
  `agents.failure_lessons`.
- `src/tools/skill-synthesizer.ts` — *"Hermes Autonomous Skill Synthesizer"*: writes new
  TypeScript tool files to `./src/tools/custom` at runtime.

There is **no Hermes browser agent and no Hermes skill layer**. The proposed phase
*"put Hermes behind BrowserCapability"* would have been built on nothing.

→ See `07-HERMES-SKILLS-TOOLS.md`. The real Hermes finding is that the **skill synthesizer writes
executable code to the prod filesystem** and belongs in the failure ledger, not the roadmap.

### B2 — "Six competing browser implementations the model must choose between"

**FALSE.** The model sees exactly **one** tool: `browser`, on the `personal` worker only.
`src/tools/personal.ts:298` `browserAction()` already dispatches on `BROWSER_BACKEND`:
AppleScript/Safari on macOS, Playwright on Linux. `browser-playwright.ts` has exactly one
importer — that switch.

**This is already the canonical-capability pattern the thesis asked us to build.** Consolidating
it would delete a working abstraction. Do not touch it.

### B3 — "A large skills layer competes with the tool registry"

**FALSE.** `skills-lock.json` contains **5 skills, all `apify/agent-skills`**. FounderOS has no
skill-selection layer in its runtime. The rich skill inventory the founder experiences
(`superpowers:*`, `sales:*`, …) belongs to **Claude Code, the development environment** — not to
the FounderOS product. Conflating the two is what produced this thesis item.

---

## C. RE-RANKED — true, but not the binding constraint

### C1 — "RAG/context overload is why FounderOS feels dumb"
**Class: HYPOTHESIS. Partially true, wrongly prioritised.**

Context *is* heavy (`06-CONTEXT-RAG-MEMORY.md`). But the CSV turn failed with a **correct,
2-step plan**. The planner understood the request. It failed because **the capability did not
exist**, not because the model was confused by context. Reducing context would not have
produced the CSV.

Context work is Phase 7, not Phase 1.

### C2 — "Antigravity performs better because it has simpler RAG"
**Class: ASSUMPTION. Unverified and non-comparable.**

Antigravity is a coding agent operating on a repository. FounderOS is a Telegram assistant
operating on live external systems. The comparison cannot isolate RAG as the variable. Treat the
Antigravity feel as a *design cue* (fewer choices, faster loop), never as measured evidence.

---

## D. THE FINDING THE THESIS MISSED

None of the five documents contains the most important fact in the system.

### D1 — The free job lane screens **zero** candidates, every sweep, for at least three days

```
Aug 08 09:30:19  module=jobhunt:free-ingest  boards=285  seen=20554  screened=0  failed=0
Aug 08 09:00:10  module=jobhunt:free-ingest  boards=285  seen=20553  screened=0  failed=0
… identical on every one of ~144 consecutive sweeps since Aug 05
```

The lane polls 285 boards and observes ~20,550 candidates **every 30 minutes**, and passes
**0** of them to screening. Corroborating DB state:

- `agents.job_applications`: **39 rows total**, spanning 2026-07-31 → 2026-08-07 (8 days)
- `free-ats-ingest` source: **5 rows** in 8 days, against ~3,000,000 candidate-observations
- `applied_at is not null`: **2 rows**, ever
- Prod trace 2026-08-08T05:31:57Z: `cv_gaps` reports *"built from 1 passing posting(s) — TOO
  SMALL TO ACT ON."*

The founder's Telegram experience of "1,425 boards checked, 7 jobs, same 7 again" is the
**visible surface of a funnel that is closed**. The system is loudly reporting work while
producing nothing, which is precisely the failure CLAUDE.md rule #26 was written to prevent —
recurring, undetected, in the lane that rule was written about.

**This is the binding constraint and it is Phase 1.**

*Not yet root-caused (deliberately — this session does not fix):* the drop is in
`filterCandidates` (age / track / country) or `keepUnseen` (all already tracked) or
`hydrateDescriptions` (empty bodies) in `src/tools/jobhunt/free-ingest.ts:194-207`. The funnel
counts **are** computed into `notes[]` and then **discarded** on quiet sweeps — which is exactly
why this has been invisible. See `12-FAILURE-LEDGER.md` **F-01**.
