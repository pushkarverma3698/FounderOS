# Evidence Console — Design System & Mockup Reconciliation

_Date: 2026-07-29 · Source mockup: `FounderOS Jarvis Dashboard.dc.html` (Claude Design)_

## Verdict in one line

**Keep the entire visual language. Replace the entire data model.**

The mockup's craft is genuinely high — it is the best-looking artifact in this
project. Its *content* is fabricated business theatre, and shipping it as-is to
recruiters would trigger the exact credibility-killers the hiring research names:
*"glossy demos lacking robustness discussion"*, *"inflated capability claims"*,
*"unsubstantiated AI does X"*.

---

## 1. What the mockup actually shows

Five views on a numbered left rail:

| View | Contents |
|---|---|
| **01 CORE** | Agent roster (3 online) · Autonomy Index orb · Live Activity feed · Next Decision · stat tiles |
| **02 PLAN** | Mission Plan · Trajectory/Milestones · "System-generated / revision 14" |
| **03 ORG** | Org Topology · Founder/Human · Sub-agents · Tasks Owned |
| **04 SYS** | System Status · Runtime/Infra/Telemetry · Runtime Log (streaming) · Throughput |
| **05 DATA** | Business Analytics · **MRR Trajectory** · **Acquisition Funnel** · Trailing 11 months |

## 2. The problem, stated precisely

Every headline number in the mockup is invented, and several are **structurally
unknowable** — not merely placeholder data that real values could slot into.

| Mockup element | Status | Why it fails |
|---|---|---|
| "Growth Agent — drafting landing page variant B" **64%** | fabricated + unknowable | An LLM agent cannot honestly report percent-complete on an open-ended task. The progress bar is a *fictional affordance*. |
| "AUTONOMY INDEX **87**" | fabricated | Unfalsifiable composite. A reviewer's first question is "87 of what?" and there is no answer. |
| "ALL SYSTEMS NOMINAL" | fabricated | Static string. Asserts health rather than evidencing it. |
| "MEM GRAPH 1,204 NODES" · "42 THREADS" · "DECISIONS / HR" | fabricated | Vanity counters with no backing table. |
| **MRR TRAJECTORY** · **ACQUISITION FUNNEL** | fabricated | Invented revenue for a company that does not have this revenue. This is the single most damaging item — it reads as a fake SaaS dashboard. |
| "3 agents online / Growth · Eng · Sales" | wrong architecture | v3 has **8 workers** dispatched per typed plan step. There is no persistent "roster" of running agents. |

Additional architectural mismatch: the mockup's vocabulary ("agents", "missions",
"org topology") is closer to the **tombstoned v2 design** than to v3. CI hard-fails
if v2 modules return; the UI should not reintroduce their concepts either.

**And the honesty test the user set for this project:** *act on reality, not fictional
hallucination.* A dashboard whose flagship number is invented MRR fails that test on
its own terms — regardless of how good it looks.

---

## 3. What to keep — the visual system is excellent

Extracted tokens, to be carried into `apps/console` verbatim.

### Colour
```
--bg            #03060c   page
--surface       linear-gradient(160deg, rgba(11,22,36,.75), rgba(6,12,22,.55))
--border        rgba(94,234,212,0.13)
--border-hover  rgba(94,234,212,0.40)
--text          #dbeaf0
--text-muted    #9fb6c1
--text-dim      #5e7887
--text-faint    #3f5560
--accent        #5eead4   teal — primary
--accent-bright #7df3e2 / #eefffb
--indigo        #818cf8   secondary
--amber         #fbbf24   tertiary / warning
```

### Type
```
display  'Chakra Petch'   600–700, wide letter-spacing — headings, numerals
mono     'JetBrains Mono' 400–600, 8.5–10px, letter-spacing 1.5–3px — labels
body     'Manrope'        400–700, 11–13px — prose
```

### Signature effects (all worth keeping)
- Radial + grid background with a radial mask, inset vignette
- Animated scanline overlay (`scanline-move 9s`)
- Corner brackets on cards (9px L-shaped borders, top-left / bottom-right)
- Conic-gradient radar sweep behind the central orb
- Canvas particle sphere with orbiters and depth-faded trails
- `pulse-dot`, `breathe`, `flicker`, `rise-in`, `flash-in` micro-animations
- 1px borders, 2–3px radii, `backdrop-filter: blur(8px)`

### Layout
60px header · 92px numbered nav rail · 3-column content grid
(`minmax(210px,270px) / minmax(280px,1fr) / minmax(210px,280px)`) · stat-tile row.
This grid is good and should be reused.

**Accessibility work required before ship** (the mockup does none of it):
8.5px mono at `#3f5560` on `#03060c` fails WCAG contrast — raise minimum body size
and dim-text luminance · honour `prefers-reduced-motion` (currently ~10 infinite
animations) · the nav rail needs real focus states and keyboard operation · the
canvas orb needs `aria-hidden` plus a text equivalent.

---

## 4. The replacement data model

Same five slots. Real, falsifiable content. Every value traces to a table or file.

| Rail | Was | Becomes | Backing source |
|---|---|---|---|
| **01 CORE** | Agent roster + Autonomy Index | **Live kernel trace** — plan → dispatch → worker → collect → synthesize; click any stage for the real `TaskEnvelope` / `StepResult` / `ToolReceipt` | `infra/trace.ts` TraceSink |
| **02 PLAN** | Mission Plan rev.14 | **The typed Plan** — actual `PlanSchema` output, step cursor, `MAX_PLAN_STEPS` budget, plus the determinism proof (two runs, identical hash) | `kernel/contracts.ts`, eval |
| **03 ORG** | Org Topology / sub-agents | **Capability matrix** — 8 workers × tools, 17 HITL-gated marked, context-isolation boundaries | `agents/capabilities.ts` |
| **04 SYS** | System Status / throughput | **Failure theatre + ratchet** — live `FailureReport` (stage·component·evidence·retryable), chaos toggles, model-fallback chain, CI ratchet board | `FailureReportSchema`, `architecture-baseline.json` |
| **05 DATA** | MRR / Acquisition Funnel | **Cost ledger + eval scoreboard** — $/run, $/day, per-model, budget headroom; golden set as regression-from-incident | `ai_call_costs`, `src/eval/` |

### Element-level substitutions

| Fabricated | Real replacement |
|---|---|
| "AUTONOMY INDEX 87" | **Receipt coverage** — % of action claims backed by a successful `ToolReceipt`. Falsifiable, and it is the actual thesis. |
| Agent progress bars (64%) | **Step cursor** — "step 2 of 4", which is genuinely known from the typed Plan |
| "ALL SYSTEMS NOMINAL" | **Live health** from `/health` + last-turn outcome; shows degraded states honestly |
| "MEM GRAPH 1,204 NODES" | **Real row counts** from the RAG store, or cut entirely |
| "42 THREADS" | Real active thread count, or cut |
| MRR / funnel charts | **Cost-per-turn distribution** and **latency waterfall** (9ms kernel vs 14–32s model) |
| "3 ONLINE" | **Days live · turns handled · failures** — the longitudinal production stat the rubric explicitly rewards |

**Rule for the build:** if a number cannot be traced to a table, a file, or a
recorded trace, it does not go on screen. An empty state that says
*"no runs recorded yet"* is strictly better than a plausible invented one.

---

## 5. Implementation notes

- The `.dc.html` is a **Claude Design prototype format** — `<x-dc>`, `sc-for`,
  `sc-if`, `{{ }}`, driven by a generated `support.js` runtime
  (`GENERATED from dc-runtime/src/*.ts — do not edit`). It is **not portable to
  production**. Port the visual design to React; do not attempt to run this runtime.
- Two mockup versions exist (`v1` 584 lines, current 785). The current one supersedes.
- The boot sequence intro ("mounting agent runtime… OK") is good stagecraft and worth
  keeping — but each line must correspond to something real that is actually happening,
  or it is more invented content.

## 6. Open questions

- Keep the central orb as pure ornament, or drive it from real step/thread counts?
  Recommendation: drive it, or cut it. Ornament that *looks* like data is the failure
  mode this document exists to prevent.
- Does the numbered-rail metaphor survive once content is evidence rather than
  narrative? Likely yes, but validate after 01 CORE is built.
