# FounderOS — Zero-Base System Criticality Report

**Date:** 2026-07-07 · **Method:** source-only analysis + live execution probes (no docs consulted except build config)
**Probes:** `scripts/_zero-base-hello-probe.ts`, `scripts/_zero-base-trace-probe.ts`, `scripts/_zero-base-loop-probe.ts` — all runs reproduced below verbatim.

---

## 0. Headline

FounderOS does not fail at simple tasks because the graph is broken. The LangGraph supervisor/department machinery works — proven live in this audit. It fails because **three competing control systems** (a regex pre-router, the LLM supervisor, and a regex post-hoc "lie detector") fight over every message, each one added to patch the layer before it. The system's real behavior is the intersection of ~77 regexes, an 11.5 KB routing prompt, and whatever model happens to be configured. That intersection is undiagnosable, and every production incident has been fixed by adding a fourth layer instead of removing one.

Measured reality vs. stated reality:

| Claim (CLAUDE.md) | Measured |
|---|---|
| "~500 LOC core" | 27,819 LOC in `src/`, 11,697 LOC in `scripts/`, 19,941 LOC in `tests/` |
| "1,098 green tests" | The agentic loop's only integration test (`office-hitl.test.ts`) **skips itself** without a live API key. Green ≠ loop tested. |
| "7 departments" | 8–10 routing targets depending on 3 feature flags; 3 additional regex "fast paths" bypass the graph entirely |
| "typed handoffs (rule #21)" | Typed only on the async `dept_signals` side channel. The hot path (every message) is untyped. |

---

## 1. Execution Path Map — one message, input → tool call

Traced from source (`telegram.ts` → `office-run.ts` → `office.ts`), then executed live:

```
Telegram message
 → telegram.ts (grammy handler)
 → office-run.runOfficeText()                        [1,210-line module]
    → withChatTurnLock (per-chat mutex)
    → stale-approval resolution + wedge recovery      [wedge.ts]
    → FAST-PATH CHECKS (regex, bypass the graph):
        inbox-fast-path / github-read-fast-path / shell-hitl-fast-path
    → buildOfficeInput()                              [pre-router.ts — ROUTER #1, regex]
        9 keyword regexes pick a department
        injects SystemMessage: "[ROUTING DIRECTIVE…] CRITICAL — … NEVER … immediately"
    → daily-budget check (fail-open on error)
    → office.invoke()  + turn timeout + budget callbacks
        → supervisor LLM                              [ROUTER #2 — 11,501-char prompt, 8 transfer tools]
        → transfer_to_<dept>  (untyped: empty args, shared message history)
        → department ReAct loop (own 4–9 KB prompt, tool-call caps)
        → tool execution → transfer_back_to_supervisor
        → supervisor LLM again → final text
    → getPendingApproval (HITL interrupt check)
    → needsExecutionGuardRetry()                      [ROUTER #3 — execution-guard.ts, regex lie detection]
        suspicious? → RE-INVOKE THE ENTIRE GRAPH a second time (2× cost)
        still suspicious? → purge messages from the Postgres checkpoint + send canned refusal
    → finalReply(): strip leaked XML tags, redact injection echoes, keyword-scan for tool errors
 → Telegram reply
```

Three routing systems must agree for a message to execute cleanly. Two of them are regexes maintained by hand.

---

## 2. Execution Gap Analysis — the Hello World, watched failing

### Run A — as configured (no model key)
```
Error: OPENROUTER_API_KEY is required for openrouter: models.
    at buildModel (src/agents/model.ts:227)
    at getModel (src/agents/model.ts:147)
    at buildOffice (src/agents/office.ts:85)
```
Fails loud at compile time. This part is healthy. Note the seam defect it exposes: `buildOffice()` calls `getModel()` internally — **the LLM is not injectable**, so nothing can exercise the orchestration offline. This is why the integration suite self-skips.

### Run B — key present, provider fails
```
[fetch #1] → https://openrouter.ai/api/v1/chat/completions
[fetch #1] ← 403 Forbidden
ERROR: 403 Host not in allowlist: openrouter.ai
```
One call, dead. The error taxonomy in `model.ts:is503Error()` matches 15 hand-picked substrings ("503", "high demand", "socket hang up"…). A 403/401/404-class failure matches nothing → **no fallback fires** → the founder gets a raw `❌ Error` dump. This is the exact mechanism behind the documented 2026-06-27 incident where the retired `:free` model returned 404 "and the fallback chain won't catch it" — the fix was a comment in CLAUDE.md, not code.

### Run C — scripted cooperative model (real graph, real tools)
```
hop 1: 14,447 bytes, 8 tools → transfer_to_research
hop 2: 11,233 bytes, 8 tools → search_web            (tool executes for real)
hop 3: 11,825 bytes, 8 tools → dept final answer
hop 4: 15,100 bytes, 8 tools → supervisor final
TOTAL: 4 LLM calls, 52,605 bytes uploaded, for ONE one-line question
```
The orchestration **works** when the model cooperates. Cost of the architecture: every trivial routed question is 4 round-trips carrying ~13k tokens, the supervisor's 11.5 KB prompt re-sent twice.

### Run D — scripted *realistic* weak model (never finalizes) ← **the stall**
```
hop 2–3:  search_web called (cap = 2; real fetches stop here)
hop 4:    search_web REMOVED from offered tools (7 tools, not 8)
hop 4–14: model keeps calling search_web anyway; graph keeps accepting it
FAILED after 14 LLM hops: GraphRecursionError (recursion limit 25)
```
This is the precise anatomy of "it stalls on simple tasks":

1. `SEARCH_TOOL_LIMITS` (office.ts:66, comment: *"prompt instructions alone are not enough on OpenRouter"*) removes a capped tool from the schema — **but has no terminal action**. The model that was already misbehaving now hallucinates calls to a tool that no longer exists, and the ReAct loop dutifully appends error ToolMessages forever.
2. Ten wasted LLM hops (~14 KB each) later, `GraphRecursionError` aborts the run.
3. The catch block in `office-run.ts:976` then calls `clearThreadAfterAbort()` — **it wipes the thread's checkpoints**. A model loop costs the founder their entire conversation state. "I've cleared that task — just send your next message" is data loss presented as recovery.

**Root cause, stated plainly:** the decision surface (8-way routing + multi-step ReAct + HITL protocol + 11.5 KB of prompt rules + "CRITICAL" directives + banned-phrase policies) exceeds what the configured free/cheap models can reliably drive. Every guard in the codebase is a compensation for that mismatch, and none of the guards close the loop — they narrow it, lengthen it, or erase the evidence.

---

## 3. Orchestration Logic Critique — is the handoff typed?

**On the hot path: no.** The supervisor→department handoff is `transfer_to_research({})` — an empty-argument tool call whose only payload is *the shared message history*. The department re-reads the whole conversation and re-infers the task. Nothing forces the supervisor to state *what* it is delegating, and nothing lets the department reject a malformed delegation. The return path is equally untyped: `outputMode: "last_message"` hands back one prose string.

**On the cold path: yes, and it's good code.** `src/agents/contracts.ts` is exactly what the whole system should look like — one Zod schema per event, a total, never-throwing validator, compiler-enforced registry parity. But it gates only the *asynchronous* `dept_signals` table (lead_discovered, demo_ready…), which is peripheral. The one place a typed contract was attempted on a synchronous boundary (`handoff-engineering.ts`) embeds the typed object **as a marker-string inside prose** in a SystemMessage — a typed schema smuggled through an untyped channel, parsed back out with regex on the other side.

So: yes, the absence of strictly-typed hot-path handoffs is a primary structural failure — with one refinement. Untyped handoffs are the reason failures are **undiagnosable and unrecoverable** (there is no boundary at which you can validate, reject, or retry a delegation; there is only prose). But the reason failures *occur* at the volume they do is the model/decision-surface mismatch in §2. Typing the handoffs fixes the first; shrinking the decision surface (or paying for a supervisor-class model) fixes the second. Both are required; neither alone is sufficient.

---

## 4. Entropy Audit — where over-engineering lives

**The compensation stack (≈1,300 LOC of regex control flow):**

| Module | LOC | What it actually is |
|---|---|---|
| `execution-guard.ts` | 591 | ~77 regexes, 68 exports: `detectUnbackedShellClaim`, `detectUnbackedGithubWriteClaim`, `FAKE_INBOX_CLAIM_RE`… a hand-built lie detector for the LLM, driving graph re-invokes and checkpoint rewrites |
| `pre-router.ts` | 267 | Router #1. `RESEARCH_RE` matches `\bwhat (does|is|are|'s)\b` — nearly any English question force-routes to research |
| 3 × fast-paths | 225 | inbox / github-read / shell — hand-coded agent behaviors that bypass the graph because routing was unreliable |
| task-ledger, wedge, repeat-guard, office-guard | 223 | more loop/lie compensation |

**Silent error handling that masks bugs** (the "why didn't we see it?" class):
- 20+ `.catch(() => null)` / warn-and-continue sites in `office-run.ts` and `index.ts` alone (state reads, purges, restores, budget checks — all fail-open).
- `getWorkerModel()` silently falls back to the primary model on misconfig — a cost/behavior change with no surface.
- The Claude judge (rule #6) is fail-open: no `ANTHROPIC_API_KEY` → silent pass.
- `finalReply()` keyword-scans tool output for `/fail|error|blocked|denied/` — error detection by vocabulary, already patched twice (F1) for false positives.
- The entire live-loop test tier is `describe.skip` without keys, so CI green is structurally incapable of catching any of the above.

**Dead weight riding along:** two web apps (`apps/jarvis`, `apps/jarvis-next`, `client/`) plus `cockpit.ts`, `mission-control.ts`, `stream-hub.ts` inside the gateway of a single-tenant Telegram bot; 3 feature-flagged alternate topologies (engineering/revenue/creative subgraphs) compiled into the same file; 109 scripts including a `_probe-*` graveyard; 80+ npm scripts with five parallel generations of gate pipelines (`gate:p2`, `gate:p3`, `gate:p456`, `gate:beta`, `gate:webdesign`).

---

## 5. The 3 Critical Files (most friction per line)

1. **`src/gateway/office-run.ts` (1,210 LOC)** — a god module that *competes with the graph for control*: per-chat locking, wedge recovery, three fast-path bypasses, the double-invoke guard retry, checkpoint purging (`purgeFabricatedAiFromCheckpoint` — the gateway rewrites LangGraph history based on regex verdicts), budget, timeout, HITL restore, reply extraction. Every stall, every duplicate send, every lost thread passes through here, and it is only testable with a fake office.

2. **`src/gateway/execution-guard.ts` (591 LOC)** — the regex immune system. Every historical production failure is fossilized here as another pattern. False positives cost a full second graph invoke (2× spend) or a canned refusal replacing a correct answer; false negatives cost nothing visibly, which is why it only ever grows. It is imported by both the pre-router and the run loop, coupling routing and post-hoc judgment to the same brittle pattern set.

3. **`src/gateway/pre-router.ts` (267 LOC)** — Router #1 of 3. Nine keyword regexes claim messages before the LLM supervisor ever sees them, then inject shouting directives ("CRITICAL — … NEVER…") that the departments' own prompts must not contradict. It duplicates `office.ts`'s department list by hand and silently diverges from it (it has no `creative`, no `revenue` awareness beyond a remap). Any department change requires synchronized edits in 3+ places.

(Dishonorable mention: `src/agents/model.ts` — the string-taxonomy error classifier that decides whether a fallback fires.)

---

## 6. The Structural Flaw Preventing Scaling

**Control inversion by accretion.** Authority over "what happens for this message" is split across three layers that don't share a contract:

```
regex pre-router  →  LLM supervisor  →  regex post-guard
   (claims it)        (re-decides it)     (overrules it, re-runs it, or erases it)
```

Each layer was added because the one inside it was unreliable, and each new layer *increases* total unreliability because they interact: the pre-router's injected directive changes supervisor behavior; the post-guard's checkpoint purges change the next turn's history; the fast paths mean the same request executes through entirely different code depending on wording. Adding department #9 means: a new regex block in pre-router, new lie-detector patterns in execution-guard, a new prompt, a new DEPARTMENT_DESCRIPTIONS entry, new routing rules in the 11.5 KB supervisor prompt, and eval updates — the blast radius CLAUDE.md itself admits is "10 files."

A system scales when one layer owns each decision. Here, no layer owns anything, so every fix is a cross-layer negotiation — which is exactly why "simple tasks" fail: a one-line request must survive three uncoordinated veto points before its tool call runs.

---

## 7. The Kill Order

Delete today to reach a base-level stable state. Nothing below is load-bearing for: *message in → route → tool (HITL-gated) → reply, durably checkpointed.*

**Tier 1 — the compensation stack (this is the actual reset):**
- `src/gateway/execution-guard.ts` + all its call sites in `office-run.ts` (`needsExecutionGuardRetry`, `purgeFabricatedAiFromCheckpoint`, `purgeStaleFabricatedKnowledgeFromCheckpoint`, the double-invoke retry block)
- `src/gateway/pre-router.ts` regex rules — keep only the explicit `[route directly to X]` prefix and `buildOfficeInput`'s plain passthrough
- `src/gateway/inbox-fast-path.ts`, `github-read-fast-path.ts`, `shell-hitl-fast-path.ts`
- `src/gateway/task-ledger.ts`, `src/agents/agent-tools/repeat-guard.ts`
- *Compensate with the real fix:* pin the **supervisor** to a strong tool-calling model (the code already supports the split via `WORKER_AGENT_MODEL` — it is currently used backwards: strong model everywhere or weak model everywhere), and give tool caps a terminal action (cap hit → force `transfer_back`, not schema removal).

**Tier 2 — parallel products inside the bot:**
- `apps/jarvis`, `apps/jarvis-next`, `client/`, `src/gateway/cockpit.ts`, `cockpit-ui.ts`, `mission-control.ts`, `mission-sync.ts`, `stream-hub.ts`, `web.ts` (keep bare `/health`)
- Feature-flagged alternate topologies, all off in production: `engineering-domain.ts`, `revenue-domain.ts`, `creative-department.ts` + their flags and 4 subgraph test files

**Tier 3 — process archaeology:**
- `scripts/_probe-*.ts` and ~70 of 109 scripts (keep: setup-db, run-eval, e2e-telegram-qa, telegram-tester, sync-turicks-brain)
- npm scripts: 80+ → ~12 (`dev`, `build`, `test`, `lint`, `eval`, `setup`, one `gate`)
- `src/outbound/`, `cinematic-build.ts` pipeline directives (revenue features can return *after* the loop is stable)

**Explicitly KEEP:** `office.ts` (the graph is fine), `contracts.ts` (extend it to the hot path: give every `transfer_to_*` a required Zod args schema — `{ task, expected_output, constraints }` — validated at the boundary like `validateSignalPayload`), `agent-tools/hitl.ts` + DB-backed approvals, the Postgres checkpointer, `model.ts` minus the string taxonomy (replace with status-code classes), the unit-test tier, `format.ts`.

**Post-kill definition of stable:** the Hello World probe (Run C) passes against the real configured model in <5 s and 2 hops for an unrouted message; Run D's loop scenario ends in ≤3 hops with a surfaced "department stalled" reply **without** wiping the thread.

---

## Appendix — Evidence Inventory

- Run A/B trace: `scripts/_zero-base-hello-probe.ts` (`PROBE_PHASE=A|B`)
- Run C trace: `scripts/_zero-base-trace-probe.ts` (4 hops, 52,605 bytes measured)
- Run D trace: `scripts/_zero-base-loop-probe.ts` (`PROBE_LOOP=1`, 14 hops → GraphRecursionError)
- LOC: `find src -name '*.ts' | xargs wc -l` → 27,819; per-module counts in §4
- Prompt sizes measured at runtime: supervisor 11,501 chars; marketing 8,823; engineering 6,337; research 3,966
- NOT VERIFIED in this environment: live Telegram gateway loop (no bot token/DB here) and real-model behavior on OpenRouter (egress allowlist blocks `openrouter.ai`) — both traced at source level only; everything else above was executed.
