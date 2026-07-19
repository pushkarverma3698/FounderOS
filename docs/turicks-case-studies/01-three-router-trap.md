# The Three-Router Trap: How Patching Each Layer Built a System Nobody Could Debug

*Turicks Engineering — the v1 → v2 → v3 journey, part 1 of 5*

The single most expensive lesson in FounderOS was this: **every time a layer was unreliable, we added another layer to police it — and each new layer made the whole system less reliable, not more.** By v2 we had three separate control systems deciding what a single Telegram message should do, and two of them were hand-maintained regex piles. This is the story of how that happened and how we tore it down.

**By the numbers**

| | |
|---|---|
| v1 orchestrator | **10,678 LOC** |
| v2 claimed size vs actual | **"~500 LOC"** → really **27,819 LOC** in `src/` |
| Control systems per message | **3** (2 regex + 1 LLM) |
| Routing logic | **~77 regexes** + an **11.5 KB** prompt |
| Blast radius to add one department | **10 files** |
| After v3 | **1** typed pipeline; `regex-routing = 0`, CI-enforced |

**What it cost us — and how we got out.** For weeks nobody could predict what the bot would do with a given sentence, because its real behavior was the *intersection* of three systems that had to agree. Every production incident was "fixed" by adding a fourth layer, which made the next incident harder to diagnose. The suffering wasn't a dramatic outage — it was the slow, grinding kind: undebuggable behavior, fear of touching the routing, and a blast radius that made every feature expensive. We got out exactly one way — by **deleting two of the three routers** and letting CI forbid their return, so the fix couldn't quietly erode.

---

## The Genesis (v1)

v1 was an ambitious, hand-rolled orchestrator: a custom pre-router, a custom supervisor, five "department pods," a custom critic node, a hand-written two-phase tool executor reimplementing what the framework already did. It was **10,678 lines of code**, and it looked like a serious system.

Then a 2026-06-01 audit found the defect that reframed everything. For four of five departments, the "finalize" node wrote an audit-log row to Postgres and returned — **it never called the tool that would execute the approved action.** The email tool was fully built, fully tested, and connected to nothing. Every approval a user had ever given since launch produced a database row, not a sent email.

The hypothesis behind v1 was reasonable: model the org as departments, give each a rich internal state machine, keep tight control of every step. The failure was that the scaffolding grew faster than the substance. We had 983-line prompt files and an 826-line custom LLM executor, and underneath all of it, the actual action didn't fire.

## The Bloat & AI Slop (v2)

v2 was supposed to be the cure. We rebuilt on framework primitives — `createSupervisor` + `createReactAgent` — and the ADR proudly described collapsing "10,678 LOC → ~500 LOC." It felt like the classic AI-assisted glow-up: less code, modern patterns, tests green.

It was slop, just better-dressed slop. A zero-base audit a month later found the real numbers: **27,819 lines in `src/`**, not 500. And more importantly, the control flow had metastasized into three routers that all had to agree for one message to run:

```
regex pre-router  →  LLM supervisor  →  regex post-hoc "lie detector"
   (Router #1)         (Router #2)          (Router #3)
```

- **Router #1** — `pre-router.ts` (267 LOC): nine keyword regexes claimed each message on first match, then injected shouting directives (`CRITICAL — … NEVER…`) into the prompt. "Research competitors and then email the summary to Sam" matched `\bresearch\b` and got force-routed to a single department, its own content now contradicting the directive stapled to it.
- **Router #2** — the LLM supervisor, steered by an 11.5 KB routing prompt.
- **Router #3** — `execution-guard.ts` (591 LOC, ~77 regexes): a lie detector that scanned the model's output after the fact and, if it looked suspicious, re-invoked the entire graph (2× cost) or purged messages from the Postgres checkpoint.

Every one of those layers was added to compensate for the one inside it. That is the trap. The pre-router existed because the supervisor mis-routed; the guard existed because the model sometimes lied; the fast-paths existed because the guard was slow. Adding a ninth department meant synchronized edits across the pre-router regexes, the guard patterns, the supervisor prompt, the department descriptions, and the eval set — a blast radius our own docs admitted was "10 files." The system's true behavior was the intersection of ~77 regexes, an 11.5 KB prompt, and whatever model happened to be configured. Nobody could hold that in their head, which meant nobody could debug it.

## The Production Reality (v3)

v3 started from a directive: stop adding layers, and make the *shape* of the system impossible to re-complicate. We replaced three routers with one honest pipeline:

```
message → plan → dispatch → agent ⇄ tools → collect → (repeat) → synthesize → reply
```

- **Plan** is one LLM call that returns a typed `PlannerDecision`: either a direct reply, or a validated `Plan` — an explicit, ordered list of steps. There is now *an object* representing the task, instead of a prose plea injected into a prompt.
- **Dispatch is pure code.** The supervisor is no longer an LLM; it's a deterministic function that hands `plan[cursor]` to a worker as a typed `TaskEnvelope`. No regex claims the message. No directive gets stapled on.
- **Synthesize** is a final LLM call that sees only the validated results.

The two regex routers are gone — and they can't come back. CI enforces **tombstones**: if anyone recreates `pre-router.ts`, `execution-guard.ts`, or `office.ts`, the build fails. An **architecture-debt ratchet** holds `regex-routing` at `0` and only lets it shrink. A **400-line-per-file budget** kills god modules before they form. The routing logic that used to be spread across 77 regexes and an 11.5 KB prompt is now a set of pure functions with unit tests, and the golden set runs twice in CI to prove identical plans come out.

The blast radius of adding a capability dropped from "10 files and three routers must agree" to "add a tool, add it to a capability list." The system fits in your head again.

## Key Engineering Takeaways

- **A new layer to police an old layer is a debt, not a fix.** If your instinct is "add a guard for when the agent gets it wrong," stop — you're about to build Router #3. Fix the boundary so the wrong thing can't be expressed, don't detect it after the fact.
- **"We cut it from 10k to 500 lines" is a claim, not a fact — go count.** v2's headline was off by 55×. Line-count and "it's simpler now" are exactly the claims an AI agent will assert confidently and you will want to believe. Measure with `wc -l`, not vibes.
- **Make the good shape the only shape the CI allows.** Deleting bad architecture is worthless if it can grow back. Tombstones, a debt ratchet, and a hard per-file line budget turn "please don't re-complicate this" from a code-review plea into a build failure.
- **Prefer one deterministic pipeline over three probabilistic ones.** Three control systems that must agree don't average out to more reliable — their failure modes multiply. One typed path you can unit-test beats a committee of routers every time.
- **The task deserves to be a data structure.** The moment "the plan" is a sentence inside a prompt instead of a typed object, you've lost the ability to track, test, or resume it. Give the task a type early.

---

*Next: [The Lie Detector We Built for Our Own AI](02-lie-detector-for-our-own-ai.md) — what happens when you try to regex your way to trust.*

---

### Work with Turicks

Turicks builds AI-native software and puts the discipline from this story to work on client systems — agent architectures that ship in days, don't hallucinate their results, and stay simple under the velocity of an AI coding agent. See what we ship at **[turicks.com](https://turicks.com)**.

> *[Client outcome placeholder — add a one-line result + attributed quote here once cleared for publication.]*
