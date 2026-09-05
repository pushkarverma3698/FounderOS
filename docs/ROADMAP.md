# FounderOS — Roadmap & Strategic Direction

*For Pushkar Verma, Turicks. Updated: 2026-08-28.*

> 🟢 **PRODUCTION LIVE** since 2026-06-14 — Hetzner VPS, systemd, GitHub Actions CD.
> Architecture is **v3 (contract-first kernel)** since 2026-07-08.

---

## What FounderOS Is

**A deterministic agent kernel that takes real business actions — safely — with a Telegram gateway.**

A message becomes a typed `Plan`. Pure code — not a model — walks that plan and hands each
step to a worker as a `TaskEnvelope`. Workers call tools; every tool call is recorded as a
`ToolReceipt`. Results are validated against an output contract before a synthesizer is
allowed to describe them. Anything that leaves the building stops at a human approval first.

```
message → plan → dispatch (pure) → agent ⇄ tools → collect → synthesize → reply + receipts
```

**The properties that matter, and the mechanism behind each:**

| Property | Mechanism, not intention |
|---|---|
| Deterministic | temp 0; routing/parsing/guards are unit-tested pure functions. CI runs the golden set twice and diffs the plans |
| Zero-hallucinated actions | an action claim needs a successful receipt (`validateStepResult`); the synthesizer only ever sees validated results |
| Crash-safe approvals | the DB row is written **before** `interrupt()`; pending approvals survive restarts (Postgres checkpointer) |
| No double-sends | idempotency key checked before every external send; the audit row is written only on real success |
| Failures name a component | `FailureReport` = stage · component · evidence · retryable, always shown to the founder |
| Debt can only shrink | `governance/architecture-baseline.json` ratchet, enforced in CI |

---

## Measured state (2026-08-28, counted not remembered)

| Measure | Value |
|---|---|
| Test suite | 332 files · **3,649 tests**, offline, $0 |
| Source | 344 files · 58,141 LOC |
| DB tables | 29 |
| Behavioural golden tasks | 41 |
| Golden-set score (live model) | **85%** — routing 90% · tools 96% · HITL 95% |
| Free ATS boards polled | **1,297** across 10 platforms, every 30 min, at $0 |
| Architecture ratchet | gateway-imports 0 · kernel-purity 0 · regex-routing 0 · orphan-subsystem 0 · fail-open-catch 11 · loc-budget 6 |

Full honest accounting, including what is deferred and where the ceilings are:
**[LIMITATIONS.md](LIMITATIONS.md)**.

---

## Current work — the job hunt is the product

The system's first real user is its author, and the job it has to do is get him hired in the
Netherlands. That is the priority through Q3, and it is also the best available proof that
the kernel works on something with a consequence.

**The constraint is not supply.** 1,297 boards feed a pipeline that has stored 554 screened
applications and submitted 2. Everything upstream of "apply" is finished and over-built;
everything downstream is thin.

Ranked by effect on applications submitted:

1. **Outcome instrumentation** — nothing records what comes back. `stage` supports
   `replied`/`rejected`/`dormant` and no code path ever transitions them, so response rate,
   time-to-response and per-company outcome are all unmeasurable. Until this exists, every
   other improvement here is a guess.
2. **Follow-up** — `followups_sent` and `last_contact_at` are declared in the schema with a
   comment describing a day-7/day-14 nudge that nothing implements.
3. **Warm intros** — the pipeline is 100% cold ATS submission, the lowest-converting channel
   there is, into a recognised-sponsor pool small enough to exhaust.
4. **A public evidence surface** — the kernel scores on nearly every 2026 AI-engineer hiring
   rubric item (eval design, checkpointing, HITL, cost ledger, CI gates, weeks of production)
   and exposes none of it. Designed 2026-07-29, still unbuilt; `proof.turicks.com` does not
   resolve.

Audit and sequencing: `docs/plans/2026-08-22-portfolio-and-recruitment-readiness-audit.md`
(not linked: it arrives on a separate PR, and a link that 404s is worse than a path).

---

## What NOT to do (intentional defers)

| ❌ Deferred | ✅ Why |
|---|---|
| **SaaS pivot / multi-tenancy** | Gated on the single-user system producing a real outcome first. It has not yet produced the one it was built for |
| **More job sources** | 1,297 boards against 2 submitted applications. More supply is the most expensive way to avoid the actual problem |
| **Rewriting the agent layer in Python** | The market hires TypeScript for AI engineering; the gap is a CV claim and one artifact, not a rewrite |
| **All ten proof surfaces** | The ten-surface design shipped zero in three weeks. Two surfaces shipped beat ten designed |
| **Homerun ATS** | No public API, no token corpus, and every subdomain probe is indistinguishable from a typo. Guessing slugs is forbidden — a wrong board is worse than no board. Unblocks when a corpus exists or a posting URL is harvested in the wild |
| **Safari-MCP browser** | ADR-012; `personal.browser` covers current use |

---

## Metrics that matter

**Primary, and currently 2:** applications actually submitted per week.

**Secondary:**
- Reply rate per 100 applications *(unmeasurable today — see item 1 above)*
- Fresh roles surfaced within 24h of publication
- Cost per run, and daily spend against `BUDGET_DAILY_USD`
- Uptime, and turns completed without a `FailureReport`

**Not tracked:** LOC, test count, board count. Those are inputs. A board polled is not a job
applied for, and the gap between the two is this project's whole problem.

---

## How to contribute

1. **Read** [docs/README.md](README.md) — the documentation index
2. **Follow** [rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md) — wiring maps for adding tools
3. **Start with a failing test** — every bug fix does; [rules/TESTING-RULES.md](rules/TESTING-RULES.md)
4. **Run** `pnpm gate` — lint, build, wiring, architecture, tests
5. **Open a PR.** Branch protection on `main` requires both CI checks. Claude may merge its own
   green PRs (founder directive, 2026-08-01 — work sat finished-but-undeployed waiting on a
   human click while prod ran stale code). Merging on red is never acceptable, and a merge is
   not a deploy: watch CD and verify prod actually moved.

---

## Business context

### Turicks
- Solo founder: Pushkar Verma · ICP: AI/dev-tool startups (seed–Series A)
- Website: turicks.com · Proof gallery: proof.turicks.com — **planned, does not resolve**

### Built on FounderOS
1. **FounderOS** — the kernel, and the thing running the job hunt
2. **video-factory** — client social-video engine ([VIDEO-FACTORY.md](VIDEO-FACTORY.md))
3. **cinematic-web** — Gumroad presets → DFY tier

---

## See also

- **[Root README.md](../README.md)** — what it does, architecture, eval results
- **[PROOF.md](PROOF.md)** — regenerable scoreboard (`pnpm proof:scoreboard`)
- **[LIMITATIONS.md](LIMITATIONS.md)** — honest tech-debt and deferred work
- **[SEAM-FAILURES.md](SEAM-FAILURES.md)** — production failures and what each one taught
- **[decisions/](decisions/)** — ADRs
- **[guides/DEPLOYMENT.md](guides/DEPLOYMENT.md)** — production runbook
