# Evidence Console + Hiring Thesis — Design Spec

_Date: 2026-07-29 · Status: approved design, pre-implementation_

## Goal

Ship a public, production-grade web surface that makes FounderOS's **invisible
engineering guarantees visible**, and a twelve-chapter LinkedIn thesis backed by
real data from it — targeting AI-engineer roles in the **Netherlands (primary)**
and **India (secondary)**.

This is not a chat UI. Every surface exists to answer a specific thing hiring
managers screen for.

## Context: why this exists

FounderOS has no frontend. Two prior attempts (`apps/jarvis` Vite HUD,
`apps/jarvis-next` Next client) were deleted in the v3 kernel rebuild (`a53a6f2`)
and are untracked. Only stale build output survives on disk; it polls
`/api/v1/missions` in an unthrottled retry loop against a dead v2 API and speaks
tombstoned vocabulary (`office`, MISO, "departments"). **It is a liability, not a
starting point — delete it.**

Today's entire HTTP surface is `src/infra/health.ts`: `/health` and `/metrics`.

Meanwhile the kernel scores on nearly every 2026 hiring rubric item — deterministic
routing, Postgres checkpointing, HITL with idempotency, golden-set evals, cost
ledger, CI architecture gates, weeks of live production — and **exposes none of it**.

## Decisions locked

| Decision | Choice |
|---|---|
| Primary target role | AI engineer (backend/frontend secondary) |
| Approach | Evidence Console — proof surfaces, not chat-first |
| Scope | Full console, sequenced so a public URL ships early |
| Demo reliability | Deterministic replay mode + explicit live toggle |
| Access | Public read-only demo |
| Primary market | Netherlands first; India in parallel funnel |
| HSM band | Under 30 → €4,357/mo ≈ €52.3K/yr |
| LinkedIn cadence | Weekly, build-in-public, 12 chapters ≈ 3 months |
| Design file | `FounderOS Jarvis Dashboard.dc.html` unread (MCP unavailable); reconcile later |

## Market findings driving the design

**Rubric (global).** Portfolios are evaluated in ~90 seconds on "production signals
— error handling, eval rigor, observability — not project count." Eval engineering
is "the single highest-leverage skill in 2026" and "the most under-built and most
over-rewarded project." Gold standard framing: *"ran for 30 days, handled 200 real
cases, failed 14 times, and here's what each failure mode taught me."* Deploy with
live URLs. Credibility-killers: glossy demo with no robustness discussion, missing
cost/latency analysis, inflated claims, no failure candor.

**Interview probes** converge on StateGraph, **Postgres checkpointers**,
**human-in-the-loop**, **deterministic routing**, kill-switch, prompt injection and
destructive-op prevention, and distinguishing a regression caused by your prompt
change from one caused by the model updating underneath you.

**Netherlands.** Junior (0–2y) €50–68K · Mid (3–5y) €68–100K · Senior €100–150K.
HSM 2026: €5,942/mo (30+), €4,357/mo (under 30), €3,122/mo (recent grad).
Under-30 threshold (≈€52.3K) sits **inside** the junior band — junior offers clear
the visa bar. Hard filter: employer must be an **IND recognised sponsor**.
⚠️ All immigration figures are from third-party guides — **verify against ind.nl
before acting**.

**India.** 1M+ AI positions projected by end-2026 vs ~120K trained AI professionals
in GCCs; roughly one qualified engineer per ten openings. Four roles every GCC hires
against: AI/ML, prompt engineering, MLOps, **platform engineering**. Entry ₹7L ·
Mid ₹15L (AI avg ₹18L) · Senior ₹28L. Screening is **machine-first**: skills-graph
encoding, semantic sourcing across LinkedIn + GitHub + Stack Overflow + Naukri,
AI-led pre-screening at 400–600 candidates/week.

**Implication:** profiles are parsed by models before humans see them. Content needs
a machine layer (explicit skill tokens, crawlable pages) *and* a human layer (the
argument).

## Positioning

Reject *"full-stack developer who learned AI."* Adopt **"I build production agent
infrastructure"** — backend depth is the reason the agents don't fall over, not
something being left behind. Agents are "systems engineering problems, not pure
prompt engineering challenges"; the market gap is in *qualified* supply, not
applicants. Lead with **agent platform engineering** — the least-crowded of the four
GCC lanes and the best fit for a REST/Postgres/CI-CD background.

## Architecture

**Load-bearing discovery:** `src/infra/trace.ts` already exposes
`setTraceSink(sink: TraceSink | null)` and the kernel already emits typed
`TraceEvent`s over a `Seam` taxonomy. The web layer registers a sink and fans out
over SSE. **Zero kernel changes** — this cannot destabilise production.

`hono`, `zod`, `langsmith`, `playwright` are already dependencies. No new runtime deps.

```
src/gateway/web/          new API — only gateway imports gateway (R1 ✓)
  sse-hub.ts              TraceSink → SSE fan-out
  demo-guard.ts           read-only tenant, tool allowlist, rate limit, budget cap
  redact.ts               PII/secret scrubbing at record time
  contracts.ts            Zod response schemas mirroring src/kernel/contracts.ts
  routes/                 trace · replay · receipts · hitl · cost · eval
                          ratchet · capabilities · stats
apps/console/             React + Vite + TS, standalone npm dir — same pattern as
                          video-factory, NOT in the pnpm workspace so `pnpm test`
                          stays $0 and unaffected
scripts/record-trace.ts   pnpm proof:record <thread> → redacted replay fixture
scripts/proof-charts.ts   pnpm proof:charts → committed SVGs from Postgres
src/proof/replay.ts       deterministic replay engine
```

Routes are one-per-file to stay under the **400-LOC budget (R4)**. `apps/` is
already in `FROZEN`, so the client is excluded from src rules by design.

**Vite, not Next.** No SSR requirement, one static bundle served by the existing
node process, one less runtime on the VPS. Trades some Next-on-CV signal for demo
reliability. Static-rendered summary pages per surface cover crawlability.

**Must not** re-create tombstoned modules (`office-run.ts`, `office.ts`,
`pre-router.ts`, fast-paths…) — CI hard-fails. UI vocabulary is v3:
plan · step · envelope · receipt · failure report.

## The ten proof surfaces

| # | Surface | Rubric item answered |
|---|---|---|
| S1 | **Kernel trace viewer** — plan → dispatch → agent⇄tools → collect → synthesize; expand any stage to the real `TaskEnvelope` / `StepResult` / `ToolReceipt`; per-stage latency | trace-reading / agent debugging |
| S2 | **Receipt ledger + break-it button** — inject a fabricated action claim, watch `validateStepResult` reject it | zero-hallucination as mechanism |
| S3 | **HITL console** — exact payload, approve/reject, kill-and-resume, double-approve → idempotent no-op | HITL, kill switch |
| S4 | **Cost ledger** — $/run, $/day, per-model, budget headroom, cost-per-task-type | per-call cost awareness |
| S5 | **Eval scoreboard as regression-from-incident** — each golden case linked to the production failure that created it; determinism proof | eval rigor (highest leverage) |
| S6 | **Failure theatre** — live `FailureReport` (stage·component·evidence·retryable) + chaos toggles (force 503 / fallback / timeout) | production reliability |
| S7 | **Architecture ratchet board** — violations trending down only | CI gates before deploy |
| S8 | **Capability matrix** — 8 workers × tools, 17 HITL-gated, context isolation | tool design, destructive-op prevention |
| S9 | **Production stats** — days live, turns, actions, failures, uptime | longitudinal production evidence |
| S10 | **90-second guided tour** — autoplays a curated replay through S1→S6 | the 90-second window |

Chat exists only as a small input bar.

## Modes

- **REPLAY** (default, public): deterministic playback of real recorded traces.
  Zero model calls, $0, cannot fail. Fixtures produced by `pnpm proof:record` from
  Postgres checkpoints, then redacted.
- **LIVE** (explicit toggle): real kernel turn, read-only tool allowlist, hard
  per-session and global daily budget caps.

Rationale: a live-only demo dies with the provider. The 2026-07-13 Gemini 503 storm
failed 14/15 turns of a battery test. The recorder is also a strong interview artifact.

## Security model

Non-negotiable — this runs on the box that runs the real business.

- Demo tenant is a **separate thread namespace**; the founder thread is unreachable.
- **No write path in demo mode** — HITL approve renders the consequence, executes nothing.
- Gated tools (`vps_run`, `run_shell`, `write_file`, `send_email`, …) are **absent**
  from the demo registry, not merely gated.
- Redaction runs at **record time**, not render time — secrets never reach a public fixture.
- Per-IP rate limit + global daily budget kill-switch on LIVE.
- `WEB_GATEWAY_TOKEN` (already in `config.ts`, currently unused) gates non-public routes.

## Testing

- Unit: route contracts (Zod), redaction, replay determinism.
- Component: React Testing Library on each surface.
- E2E: **Playwright against REPLAY mode** — deterministic and $0, runs in CI on every
  PR. Satisfies the zero-paid-calls rule with no exception carved out.

## Sequencing

1. API + SSE + S1 trace viewer + replay of one recorded trace → **deploy to VPS, first public URL**.
2. S2 receipts · S3 HITL · S6 failure theatre — the adversarial trio.
3. S4 cost · S5 eval-as-regression · S7 ratchet — the numbers.
4. S8 capabilities · S9 stats · S10 guided tour · a11y, perf, polish.

## Parallel docs track

Fix v2 rot in `ROADMAP.md` and `LIMITATIONS.md` (both still describe the dead 7-ReAct-department
architecture). Reframe the golden set as regression-from-incident. Rewrite `README.md`
as a product spec: problem → architecture → eval results → next steps. Highest
value-per-hour in the project and it does not block the UI.

## The LinkedIn thesis

**Thesis:** *Agent reliability is an engineering problem, not a prompting problem —
and here is the instrumented proof from a system running in production.*

Twelve chapters, weekly, one chart + one number + one deep link each. All charts
generated by `pnpm proof:charts` from real Postgres data — never hand-drawn.

| # | Chapter | Chart | Metric | Source |
|---|---|---|---|---|
| 1 | Every way my agent failed | failures by stage × component | N days, M turns, K failures | `FailureReport` |
| 2 | What one turn actually costs | cost histogram + by task type | $X median/turn, p50/p95 | `ai_call_costs` |
| 3 | 9ms is mine, 32s is the model | latency waterfall by stage | 9ms kernel vs 14–32s model | `infra/trace.ts` |
| 4 | Same input, same plan — byte for byte | plan diff, identical hash | 100% plan determinism | eval determinism test |
| 5 | ⭐ My agent can't lie about what it did | contract flow + rejected claim | 0 unbacked claims possible | `ToolReceipt` |
| 6 | I approved it twice. It happened once. | HITL sequence diagram | 0 double-sends | `action_log` |
| 7 | I killed the process mid-approval | before/after + recording | approval survived restart | checkpointer |
| 8 | ⭐ My eval set is 200 production failures | case→incident map + pass rate | every case from a real incident | `golden-tasks.ts` |
| 9 | I made architectural decay a build failure | ratchet trend | gateway-imports 0, kernel-purity 0 | `architecture-baseline.json` |
| 10 | Postmortem: 6 hours of 503s | incident timeline + error classes | 14/15 turns failed | fallback logs |
| 11 | I deleted my own architecture | v2 vs v3 + tombstones | 4 traces → full rebuild | `ZERO-BASE-AUDIT.md` |
| 12 | Everything I needed I learned building APIs | — | the capstone | — |

Opening with failure (#1) is deliberate: failure candor is explicitly rewarded and
earns the attention later chapters need. #11 is the judgment post — few can write it.

**Console additions to support the thesis:** `pnpm proof:charts`; deep-linkable
surfaces (`/trace/:id`, `/eval`, `/cost`); a public case-study page per chapter;
auto-generated OG images.

**Machine layer:** exact skill tokens (LangGraph · Postgres checkpointer · evals ·
HITL · RAG · observability · MLOps) in headline, About, GitHub repo topics, README.
Separate Naukri profile for the India funnel. Console must be crawlable.

## Success criteria

1. Public URL live on the VPS, reachable without install or login.
2. Replay mode runs end-to-end with **zero model calls** and cannot fail.
3. A cold viewer reaches "this person builds real systems" within 90 seconds (S10).
4. `pnpm gate` stays green; architecture ratchet does not regress.
5. Playwright E2E against replay runs in CI at $0.
6. All twelve charts regenerate from live data via one command.
7. Docs contain no v2 architecture references.

## Risks

- **Scope.** Full console is multi-week. Mitigated by sequencing a public URL at step 1.
- **Security.** A web surface on the prod VPS reaching gated tools would be severe.
  Mitigated by tool absence (not gating) in the demo registry.
- **Live-model dependency.** Mitigated by replay-first.
- **Doc rot** actively costs credibility under a "README read first" rubric.
- **Immigration figures unverified** — must be confirmed against ind.nl.
- **LinkedIn strategy is unsourced reasoning**, not researched consensus (search
  tooling returned CAPTCHAs).

## Open questions

- Contents of `FounderOS Jarvis Dashboard.dc.html` — reconcile visual direction when available.
- Whether v3 retained the Claude-as-judge gate; if not, judge calibration (human
  concordance) is a named-rare skill worth adding.
- Whether to add a LangSmith or Promptfoo bridge for keyword coverage against lab screening.

---

## Amendments — 2026-07-29 (design file received, research corrected)

### A1. Design mockup received and reconciled
`FounderOS Jarvis Dashboard.dc.html` read and rendered. Verdict: **keep the visual
system, replace the data model** — the mockup's headline numbers (Autonomy Index 87,
MRR trajectory, acquisition funnel, agent progress bars) are fabricated, and several
are structurally unknowable rather than merely placeholder. Full analysis, extracted
design tokens, and the fiction→evidence substitution table:
[`docs/design/DESIGN-SYSTEM.md`](../design/DESIGN-SYSTEM.md).

The mockup's five-view rail (CORE/PLAN/ORG/SYS/DATA) maps cleanly onto the ten proof
surfaces — the information architecture survives, the content does not.

### A2. EU AI Act timeline — CORRECTED
An earlier assumption that high-risk obligations bite on **2 Aug 2026** was **wrong**.
The Digital Omnibus (Council approval 29 June 2026) moved Annex III standalone
high-risk to **2 Dec 2027** and Annex I embedded to **2 Aug 2028**.

This *strengthens* the plan: the control-plane build-out runs through 2026–2027, which
is the hiring window. See [`docs/strategy/07-NL-AI-MARKET-AND-TARGETING.md`](../strategy/07-NL-AI-MARKET-AND-TARGETING.md) §1,
including the control-to-obligation mapping and the explicit rule **never to claim
"AI Act compliant"** (a legal conclusion requiring conformity assessment).

### A3. Dutch market pain points identified
Techleap's *AI Scaling Challenges for Dutch Founders* names four hurdles; two are
directly exploitable: **talent acquisition crisis** (remedy explicitly includes
international recruitment) and **insufficient industry knowledge** producing "unclear
regulations, slow adoption by end-users, and negative media sentiment."

The second reframes the whole pitch: the binding constraint on Dutch AI adoption is
**trust, not capability**. FounderOS is a trust architecture. Lead with auditability
and reliability, not model cleverness.

### A4. MCP decision — publish our own, don't integrate someone else's
Open question resolved. Rather than adding a third-party MCP server for novelty,
**publish FounderOS's existing read-only MCP surface (`src/mcp/`) as a public
endpoint** backed by the same evidence data as the console.

Rationale:
- A recruiter can connect their own Claude/Cursor and *interrogate the live system* —
  "how many turns has it handled? show me a failure report" — from their own client.
  That is a materially stronger demonstration than any integration.
- It proves **MCP server authoring**, a scarce and current skill, rather than MCP
  consumption, which is trivial.
- **Zero marginal cost** — it reads Postgres, makes no model calls.
- The server already exists and is read-only by design, so the security surface is
  already the right shape.

Constraints: same demo-tenant isolation, redaction and rate limiting as the HTTP API;
no write tools exposed; publish the connection snippet on the console's front page.

### A5. Repo cleanup — **PENDING, founder action required**
Deletion of `apps/jarvis` and `apps/jarvis-next` was **attempted and blocked** by the
sandbox permission layer (`rm -rf` denied). The directories are **still present** and
still untracked.

Verified safe to delete: the source is recoverable from git at `a53a6f2^` (49 files);
only stale build output (`dist/`, `.next/`, `node_modules/`) sits on disk.

Founder runs:
```bash
rm -rf apps .claude/launch.json
```
`.claude/launch.json` is stale — it references `founderos-jarvis-next`, which is no
longer a workspace package (`pnpm-workspace.yaml` lists only `.`). A fresh config
gets added when `apps/console` exists.

### A7. Benchmark promoted to centrepiece
Self-critique found three failures in the original spec: every surface was
inward-looking (proved FounderOS works, not that the author makes *other* systems
reliable); numbers had no baseline ("$0.003/turn" versus what?); and the "break-it"
button was author-curated, i.e. marking my own homework.

Fix: **[Agent Reliability Benchmark](2026-07-29-agent-reliability-benchmark.md)** —
same tasks, same model, same tools through three arms (FounderOS kernel / naive ReAct /
raw tool-calling), measuring fabricated-action rate, determinism, cost, latency,
failure recovery and idempotency. Open-sourced with a mandatory threats-to-validity
section. This becomes the flagship artifact and the spine of LinkedIn chapters 1, 5, 8.

New console surface **S11 — Benchmark**. The fabricated-action-rate comparison replaces
the mockup's invented "Autonomy Index" as the headline number.

### A8. Public adversarial harness (S12)
Strangers attempt to make the agent fabricate an action, escape its tool allowlist, or
double-send. Every attempt logged; success rate published. Headline becomes
*"N attempts, 0 successes"* — evidence the author did not curate.

Hard requirements: replay/read-only tenant · no write tools present in the registry at
all · per-IP rate limiting · prompts retained for analysis · abuse and moderation path
defined before launch.

### A9. Design interaction model — inspector, not dashboard
**Keep the mockup's visual identity; rebuild the interaction as a DevTools-grade
inspector.** Reasoning: generated dark-glow dashboards are now cheap and therefore
signal little. The genuinely hard component — and the one a senior frontend interviewer
probes — is a **real-time, virtualized, diffable execution-graph inspector**: DAG
layout, thousands of streamed events without frame drops, out-of-order SSE handling,
reconnection with backpressure, side-by-side plan diffing.

Reference points: Chrome DevTools Performance panel, Linear, Datadog. Note the dead v2
frontend failed at exactly this seam (unthrottled retry loop, no backoff) — a visibly
correct streaming state machine is itself the proof.

Additional senior signals to ship: publish the console's own measured Core Web Vitals
on the site · motion only on state transition, interruptible, `prefers-reduced-motion`
honoured · full keyboard operation and screen-reader support on a dense dark UI.

### A10. Own-agent hosted run (S13) — founder decision, risk noted
Visitors configure and run an agent against the harness. **Flagged as a serious
security and cost problem; founder chose it with that stated. Proceeding.**

The design eliminates the side-effect risk class rather than accepting it:

- **Never on the prod VPS.** Separate host/container with egress firewalling. Non-negotiable.
- **No free-form code.** Visitors compose from a **Zod-validated schema**; arbitrary
  code execution is not part of the surface.
- **All tools are sandboxed no-ops** — they record structured results but cannot act.
  A "send email" tool produces a real receipt and no email. The run is genuine (real
  model, real kernel, real receipts, real failures); the effects are inert.
- **Budget**: per-session hard cap, global daily cap, automatic kill switch.
- **Limits**: step caps reuse `MAX_PLAN_STEPS`; wall-clock timeout; per-IP rate limit.
- **Auth**: lightweight (e.g. GitHub OAuth) to raise abuse cost, if abuse appears.
- Full audit logging of every submitted configuration.

Residual risk after mitigation is **cost**, not compromise — bounded by the caps.

### A6. Sequencing change
Docs/positioning track is promoted to run **first and in parallel**, not after the UI.
Rationale: it is the cheapest credibility win, it unblocks applications immediately,
and the market research shows README/profile quality is screened before any demo is
opened.
