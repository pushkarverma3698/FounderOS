# Portfolio + recruitment readiness — audit and plan

Date: 2026-08-22 · Author: Claude · Status: proposed, awaiting founder decision
Trigger: "we need to start applying from Monday" (2026-08-22)

---

## The short version

The job-*finding* machine is finished and over-built. The job-*getting* surface is not built at all.

Measured funnel, from `docs/plans/2026-08-20-jobhunt-apply-queue-and-registry.md`:
**334 postings screened → 2 applications.** Supply was never the constraint. 858 boards,
68 jobhunt modules and 325 test files sit in front of a two-application output.

The binding constraint is downstream of screening, and it splits in two:

1. **Throughput** — nothing carries a screened row to a submitted form at volume. The queue's
   median row was ~8 days old with zero rows under 24h.
2. **Conversion** — what a Dutch or Indian hiring manager sees after the application lands.
   This is the one with the slow feedback loop, and it is the one that is 0% built.

**The order matters and it is the main recommendation of this document.** The IND recognised-sponsor
pool that actually hires AI engineers is a few hundred companies. It does not replenish. Sending 50
applications before the GitHub surface is presentable spends scarce, non-recoverable inventory to
learn a lesson that 6 hours of work on Saturday would have prevented. **Fix the surface first,
open the tap Monday.**

---

## What is genuinely strong (do not rebuild any of this)

Verified in-tree this session:

| Asset | Why it matters for hiring |
|---|---|
| Eval design — `src/eval/` golden tasks, retrieval eval, scoring, determinism assertion | The single most-cited hiring signal for 2026 AI-engineer roles, and the most under-built thing in most portfolios. He has it. |
| HITL with durable-write-before-`interrupt()` + idempotency key | Named directly in interview probes for agent roles. Best-in-class story in this repo. |
| `ToolReceipt` / `validateStepResult` — hallucinated actions structurally impossible | Prevention over detection, with a deleted 591-line regex guard as the counter-example. Strong narrative. |
| Postgres checkpointer, crash-safe resume | Explicit interview probe. |
| Pure-code supervisor, temp 0, byte-identical plans in CI | Determinism as a mechanism, not a claim. |
| Hybrid RAG — `rag-hybrid`, `rrf`, `rag-rerank`, `retrieval-golden` | RAG is the most in-demand skill in the market; his is evaluated, not just wired. |
| Cost ledger + budget caps | The rubric punishes missing cost analysis. He has the data. |
| README structure — problem → mechanism → evidence, with a "Mistakes I Made" section | Top-decile for a solo repo. All 40+ relative links resolve (checked). |

The raw material is there. It is unreadable to anyone who will not read 400 lines of markdown.

---

## Ranked findings — the recruitment side

### R1 · The follow-up loop is a comment, not a mechanism — CRITICAL, cheap

`job_applications` declares `followups_sent` and `last_contact_at`, with the comment
*"the Monday review follows up at day 7, then 14."*

`followups_sent` is **written by nothing in `src/`**. Grep returns one hit: its own schema
declaration. No Monday review exists for jobhunt. Stages `replied` / `rejected` / `dormant` are
declared and never transitioned by any code path.

This is rule #27 exactly: a rule with no mechanism decays. Cold-apply response rates sit in the
low single digits; a day-7 nudge is one of the few levers that measurably moves it, and the
schema has been pretending it exists.

### R2 · Zero referral or warm-intro path — CRITICAL, structural

Grep for `referral` / warm-intro across `src/tools/jobhunt/`: **no matches.** 100% of the design
is cold ATS submission, which is the lowest-converting channel available. The codebase already
holds LinkedIn tooling for the marketing department; the jobhunt department cannot reach it.

For NL specifically this is the wrong shape: the sponsor pool is small enough that a warm intro
per company is achievable, and cold-applying to the same company first burns the intro.

### R3 · The apply queue is a graveyard — HIGH

Age buckets at last measurement: 0 rows under 24h, 15 at 24–90h, 117 at 133–237h, 48 over 720h.
Median ≈ 8 days. A posting older than a day is already several hundred applicants deep, so the
19.6-hour freshness advantage the free lane was built to win is being handed back at the last mile.
*(From the 2026-08-20 plan; not re-verified today — no DB access from this session.)*

### R4 · The last mile requires his laptop and his clicks — HIGH

The Mac client (`mac-client/`) opens each form pre-filled and waits for a human click. That is
the correct safety design (ADR-018, no unattended submit) and it is also the entire throughput
ceiling. Realistic Monday capacity is whatever he can personally click through, which makes the
858-board registry decorative unless the queue is ranked tightly enough that 15 clicks is enough.

### R5 · Legal gates are correct and dated — GOOD, verify one thing

`filters.ts:25` — `HSM_UNDER_30_MONTHLY_EUR = 4357`, matching ind.nl for 2026, with a note that
it rises to €5,942 when he turns 30 on 2028-06-03. Thresholds re-index every 1 Jan and 1 Jul;
the constant is right for now but has no staleness alarm. Worth a dated assertion in CI later,
not before Monday.

### R6 · The CV source is invisible to this repo — UNVERIFIED, blocking

Everything — brief overlap scoring, `/draft`, the tailored PDF — depends on
`PERSONAL_CV_DIR/<track>/cv.md` on the box. Nothing in the repository can confirm those files
exist or what they say. On 2026-08-21 `read_cv` failed in production 90 seconds before the model
was asked for resumes, and it produced resumes with zero CV input. `buildApplicationPacket` now
makes that structurally impossible, which is the right fix.

**But the content is still unaudited.** The `ai`-track CV is the highest-leverage document in this
entire operation and no one has checked what it leads with.

---

## Ranked findings — the portfolio side

### P1 · The Evidence Console was designed, approved, and never built — THE headline finding

`docs/plans/2026-07-29-evidence-console-and-hiring-thesis.md` is a good plan. It did the market
research, picked ten proof surfaces, locked a security model, and sequenced a public URL to ship
first. Status three and a half weeks later:

| Artifact the plan called for | State |
|---|---|
| `src/gateway/web/` | does not exist |
| `apps/console/` | does not exist |
| `hono` (the plan's "already a dependency, no new deps") | **0 imports in `src/`** — and issue #539, filed automatically 2026-08-21, flags it as an unused dependency |
| `pnpm proof:record` / `pnpm proof:charts` | not in `package.json` |
| `proof.turicks.com` | **DNS ENOTFOUND** |

The HTTP surface is still `/health` and `/metrics`.

This is the frozen plan's own critical risk recurring — *"design loop never ships"* — on the single
artifact the 2026 market rewards most. The market data in that plan was right. The scoping was
wrong: four stages and ten surfaces is a month, and it got zero.

### P2 · GitHub says this is an HTML project — HIGH, 30 minutes

GitHub's language badge on `pushkarverma3698/FounderOS` reads **HTML**. Cause: 36 committed
`.html` files and 63 `.png`, almost all generated run output —
`creative-engine/runs/`, `runs/`, `.data/plates/`, plus `eng.traineddata` (5.2 MB) at the root.
Repo weight: 81 MB. There is no `.gitattributes`.

A reviewer's first three seconds on an AI-engineering portfolio should not say HTML.

### P3 · The README has no picture — HIGH, ~2 hours

Two image tags in 240 lines, both shields.io badges. No screenshot, no diagram, no demo, no live
URL. Ten mermaid diagrams sit in `docs/diagrams/` — GitHub renders mermaid inline and none of them
are in the README.

The market signal here is blunt: recruiters engage far more with projects showing runnable code
or a live demo, and portfolios are judged in roughly 90 seconds. Right now those 90 seconds are
spent reading.

### P4 · The evidence badge contradicts the evidence — HIGH, 30 minutes

The tests badge says **1,800+** and links to `docs/PROOF.md`. `PROOF.md` was generated
**2026-07-08** — six weeks stale — and says **1,213 tests**. README repeats "1,800+" in four
places. `docs/COSTS.md`, documented in CLAUDE.md as the output of `pnpm proof:costs`, does not
exist.

For a project whose entire pitch is *evidence over assertion*, the one number on the badge
disagreeing with the page it links to is the worst possible inconsistency to leave in place.

**Resolved 2026-08-22 from CI.** The PR carrying this document ran `pnpm test` green on
`aef0f37`: **3,465 tests across 317 files, 121s**
([job 96991211519](https://github.com/pushkarverma3698/FounderOS/actions/runs/32556417601/job/96991211519)).
So the badge is not inflated — it *understates* the number by roughly half, and `PROOF.md` is
stale by 2,252 tests. Underclaiming is the less damaging direction, but "1,800+" against a real
3,465 is still a number nobody can reproduce from the linked page. Set the badge to 3,465.

### P5 · The Issues tab is the second thing people click — MEDIUM, 20 minutes

20 open issues. Roughly 14 are noise a stranger will read as neglect: `E2E test run` (×4),
`P2 approve probe`, `E2E-1781638692`, `Known LangGraph limitations` (×2, agent research dumps
posted as issues), `Research: Top 3 Open-Source LangGraph Alternatives`. Several carry the label
**`agent:failed`**. Issue #426 publicly lists broken production workflows (expired Gmail grant,
missing `libnspr4.so`, a schema error).

Honesty about failure is an asset — `SEAM-FAILURES.md` does it deliberately and well. Stale test
scaffolding and `agent:failed` labels are not that; they read as an unmaintained repo.

### P6 · The public identity points at a different person — MEDIUM

The README links "my studio (Turicks)" → **turicks.com**, which is a SaaS-agency marketing site
whose featured work is a School Management System, an HR platform and an admin dashboard. An AI
hiring manager following that link lands on a generalist dev shop. `proof.turicks.com`, the
intended proof surface, does not resolve.

Also: commits are split across two author emails (176 + 170) plus 24 authored by
`Claude <noreply@anthropic.com>`. If `pushkar3698@gmail.com` is not attached to the GitHub
account, roughly half the contribution history is invisible on his profile.

### P7 · Docs describe an architecture that was deleted — MEDIUM, 1 hour

`ROADMAP.md` and `LIMITATIONS.md` still speak in v2 vocabulary — "departments", "office", "ReAct"
— for a system whose whole story is that it deleted them. `LIMITATIONS.md` is linked from the
README as honest accounting, so a careful reviewer, which is exactly the reviewer worth impressing,
finds the least accurate document in the repo.

### P8 · Everything is TypeScript — MEDIUM, structural, not fixable by Monday

The 17 Python files in the repo are all in `mac-client/`. Every agent, eval, RAG and orchestration
line is TypeScript.

Honest reading of the market: Python remains the default for AI engineering, and TypeScript/Node
is genuinely hired for — a real funnel, not a closed door. It narrows things most in Indian GCC
screening, which is machine-first and Python-keyword-heavy. This is not worth a rewrite. It is
worth a CV that says "TypeScript and Python" truthfully, and one small Python artifact so the
claim has a link behind it.

---

## Market reference (2026, verified this session)

**Netherlands.** HSM gross monthly, excl. 8% holiday allowance: **€4,357** under 30 · €5,942 at
30+ · €3,122 reduced (recent Dutch graduate / search year). Re-indexed 1 Jan and 1 Jul. Employer
must be an IND **recognised sponsor**; no labour-market test; ~2 weeks processing. Engineer bands:
junior €50–68K, mid €68–100K, senior €100–150K. His under-30 floor (≈€52.3K) sits *inside* the
junior band, so junior offers clear the visa bar. Hubs: Amsterdam, Eindhoven, Rotterdam.

**India.** GenAI carries a 25–40% premium over generalist ML. Mid-level GenAI ₹18–35 LPA;
senior LLM at product companies ₹35–60 LPA; remote-for-US from Bengaluru/Hyderabad ₹60–80 LPA
equivalent. Demand growing ~40% YoY against under-15% growth in qualified senior supply.
Screening is machine-first — the profile is parsed by a model before a human sees it.

**What the rubric rewards**, in order: eval design (repeatedly named the top signal) · RAG with a
real vector store · agent orchestration · production observability · cost optimisation ·
guardrails · MCP. **What kills credibility**: a glossy demo with no robustness discussion, no
cost or latency numbers, inflated claims, no failure candor. The gold-standard framing is
*"ran for 30 days, handled 200 real cases, failed 14 times, here's what each failure taught me."*

FounderOS can make that exact claim truthfully. It currently makes it nowhere a stranger will look.

---

## The plan

### Lane A — before Monday (~6–8 hours, do all of it)

| # | Action | Time | Why now |
|---|---|---|---|
| A1 | Add `.gitattributes` marking `creative-engine/runs/`, `runs/`, `.data/`, `assets/cinematic-presets/`, `apps/jarvis-next/public/` as `linguist-generated`; `git rm -r --cached` the run artifacts and `eng.traineddata`, add to `.gitignore` | 30 m | Language badge flips HTML → TypeScript. First three seconds. |
| A2 | Close the ~14 noise issues; keep #426, #498, #474 and the dependency findings | 20 m | Second thing a stranger clicks. |
| A3 | Run `pnpm proof:scoreboard` and `pnpm proof:costs`; set the tests badge to **3,465** (verified in CI, see P4) or swap in the live GitHub Actions badge | 30 m | Removes the badge-vs-PROOF.md contradiction, and generates the missing cost page. |
| A4 | Put three visuals at the top of the README: `01-system-architecture` mermaid inline, one real Telegram screenshot of an HITL approval card, one of a `FailureReport` | 2 h | The single highest-ROI change in this document. |
| A5 | Pin the repo; write a GitHub profile README; confirm both commit emails are attached to the account | 30 m | Recovers ~170 commits of visible history. |
| A6 | Drop or reframe the turicks.com link in the README | 10 m | Stops routing AI reviewers to a school-SaaS agency page. |
| A7 | **Founder: read the `ai`-track CV out loud.** It must lead with eval design, LangGraph StateGraph + Postgres checkpointing, HITL + idempotency, cost-per-run, and days-live — with numbers | 1 h | The most-read document in the operation, currently unaudited. |

### Lane B — week 1 (conversion)

| # | Action | Est. | Why |
|---|---|---|---|
| B1 | **Evidence Console, S1 + S2 only.** One public URL: replayed kernel trace + receipt ledger with the break-it button. Nothing else from the ten surfaces. | 2–3 d | The highest-value item in the audit. Scope is the whole lesson — the ten-surface version got zero. |
| B2 | Publish the numbers: cost/run, p50/p95 latency, days live, turns, failures. Data already exists in `ai_call_costs` and the seam journal | 0.5 d | "Missing cost/latency analysis" is a named credibility-killer. |
| B3 | Rewrite `EVAL.md` as regression-from-incident — each golden case linked to the production failure that created it — and link it from the README's first screen | 0.5 d | Top-cited hiring signal; he has it and it is buried. |
| B4 | Purge v2 vocabulary from `ROADMAP.md` and `LIMITATIONS.md` | 1 h | The careful reviewer is the one worth impressing. |

### Lane C — week 1–2 (the machine)

| # | Action | Est. | Why |
|---|---|---|---|
| C1 | Implement the day-7 / day-14 follow-up: write `followups_sent`, transition `replied`/`dormant`, one Monday digest | 1 d | Turns an existing schema comment into a mechanism. Cheapest real conversion lever available. |
| C2 | Warm-intro lane: for each shortlisted sponsor, surface a LinkedIn path before the cold apply, and hold the cold apply until it is declined | 1–2 d | Highest-converting channel, currently 0% of the design, and cold-applying first burns it. |
| C3 | Enforce the 24-hour apply queue and rank to a **15-row daily cap** | 0.5 d | Matches machine output to the human click budget that is the actual ceiling. |
| C4 | One page of interview prep against the probes the 2026-07-29 plan already identified: StateGraph, checkpointers, HITL, determinism, and "your prompt changed vs the model changed underneath you" | 0.5 d | The constraint immediately after an application lands. Nothing addresses it today. |

### Explicitly not recommended

- **Do not add job sources.** 858 boards against 2 lifetime applications. More supply is the most
  expensive way to avoid the real problem.
- **Do not rewrite anything in Python.** Fix the CV claim and add one small artifact.
- **Do not build all ten proof surfaces.** Two shipped beat ten designed. That is the finding.

---

## Honest limits of this audit

- **No database access.** No `ssh` binary in this sandbox, so the funnel numbers (334→2, queue ages,
  the 198-hour metered-lane outage) come from `docs/plans/2026-08-20-…` and are two days old.
  Re-check with `/jobs` before Monday.
- ~~**No `node_modules`.** `pnpm test` was not run, so the true test count is unverified.~~
  **Resolved** — CI ran it green on this PR's head: 3,465 tests, 317 files. See P4.
- **The CVs were not read.** They live outside the repository. R6 and A7 stand on that gap.
- **Salary and immigration figures** are from ind.nl-derived third-party guides. Verify at ind.nl
  before quoting one in a negotiation.
