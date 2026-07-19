# Empty Braces: The Handoff That Lost the Task

*Turicks Engineering — the v1 → v2 → v3 journey, part 3 of 5*

Multi-agent systems live or die at the boundaries between agents. v2 taught us that a handoff which *looks* clean in the code — one tidy function call — can be silently throwing the task away. The culprit was two characters: `{}`.

**By the numbers**

| | |
|---|---|
| The handoff carrier | `transfer_to_engineering({})` — an **empty-argument** call |
| Context available to the receiver | a **~4,000-token** rolling window, trimmed before every call |
| The safety net | `preserveTaskAnchor` — **defaulted `false`**, never enabled on the main path |
| Return trip | one **prose string** (`outputMode: "last_message"`) |
| The "typed" attempt | a real schema **serialized into a marker string** and regex-parsed back |
| After v3 | a validated **`TaskEnvelope`** at every boundary |

**What it cost us — and how we got out.** Complex tasks played telephone with themselves. Step 2 would lose the URLs, scores, and lead lists that step 1 had produced, because they had to survive a prose round-trip to get there — and the original request could be trimmed out of the window before the receiving worker even read it. The maddening part: it *looked* fine in the diff. A clean function call, a passing test, a task quietly gutted at runtime. We got out by making the task a **typed object that every boundary must validate** — no empty braces, no re-inferring from a trimmed history.

---

## The Genesis (v1)

v1 passed data between its pods through a shared, mutable state object and a hand-rolled registry (`registry.ts`) whose `allowed_tools` arrays referenced tool names that **didn't exist** in the tool index. The boundaries weren't typed; they were conventions, and the conventions drifted. Data crossed between stages by hope. It mostly worked in the demo and fell apart on anything with more than one step, which is a pattern you'll see in every part of this series.

## The Bloat & AI Slop (v2)

v2's handoffs looked modern and were arguably worse. The supervisor delegated to a department with:

```
transfer_to_engineering({})
```

An **empty-argument tool call.** The receiving department got no task object at all. It re-inferred what it was supposed to do from the shared message history — a history that was trimmed to a ~4,000-token rolling window before every call. The one mechanism that could have pinned the original request through that trimming (`preserveTaskAnchor`) defaulted to `false` and was never enabled on the main path.

The return trip was the mirror image. Departments handed back a single prose string (`outputMode: "last_message"`). So any structured data produced in step 1 — email addresses, URLs, ICP scores, a list of leads — had to survive a **round-trip through prose** to be usable in step 2. By the second handoff, a complex task was playing telephone with itself.

And here's the part that best captures the self-deception of AI slop: the one place we *tried* to do it right, we did it wrong in a way that looked right. The engineering handoff (`handoff-engineering.ts`) built a proper typed object — and then **serialized it into a marker string embedded inside prose** in a SystemMessage, shipped it through the untyped channel, and regex-parsed it back out on the other side. A real Zod schema, smuggled through a text field. It passed review because there *was* a type. The type just wasn't load-bearing at the boundary where it mattered.

We had, meanwhile, written a genuinely good typed-contract module (`contracts.ts`) — total validator, compiler-enforced parity, one schema per event. But it only gated the *asynchronous, peripheral* signal table. The synchronous boundary that actually carried the task was strings all the way down.

## The Production Reality (v3)

v3's rule is blunt: **every boundary is a typed, Zod-validated object, or it isn't a boundary — it's a bug.** The contracts moved from decoration to load-bearing structure, and the whole architecture is named after them.

- The supervisor hands a worker a **`TaskEnvelope`** — a validated object carrying the step's goal, inputs, and constraints. There is no `{}`. There is no re-inferring from a trimmed history, because the worker's context *is* the envelope. The worker runs with **isolated, envelope-only context** — it can't be poisoned or starved by whatever else is in the thread.
- The worker returns a **`StepResult`**, validated against `OUTPUT_CONTRACTS`. Structured data stays structured; it never has to survive a prose round-trip to reach the next step.
- A schema mismatch at any boundary is a **terminal, typed failure**, not a retry-and-hope. If the planner emits garbage, validation catches it at the seam and names it, instead of a downstream agent quietly doing the wrong thing.

The proof is, again, an executable scenario rather than a claim: `kernel-e2e: route override / garbage planner` asserts that a malformed plan is caught and typed, and the determinism test asserts identical inputs produce byte-identical `TaskEnvelope`s. The task now survives every boundary it crosses, because at every boundary it's a validated object — not a sentence someone hopes the next agent reads correctly.

## Key Engineering Takeaways

- **A handoff with no payload is a bug that compiles.** `transfer_to_x({})` type-checks, runs, and looks intentional in a diff. If your agents pass control without passing an explicit, validated payload, they're re-deriving the task from ambient context — and ambient context gets trimmed. Make the payload mandatory and typed.
- **A type is only worth anything at the boundary it actually guards.** We *had* Zod schemas. They protected the wrong seam while the load-bearing one carried strings. Point your strongest typing at the boundary where the task's data physically crosses between components, not at the easy peripheral one.
- **If structured data has to survive a prose round-trip, you will lose it.** Prose is a lossy encoding for a list of URLs or a set of scores. Keep structured results structured end-to-end; only render to prose at the very last step, for the human.
- **"Typed object serialized into a string and regex-parsed back" is a code smell with a specific diagnosis.** It means someone knew the boundary needed a contract but the channel wouldn't carry one — so fix the channel. Smuggling a schema through a text field is strictly worse than no schema, because it *looks* safe.
- **Isolate each worker's context to exactly what it needs.** Envelope-only context isn't just cleaner — it's what makes a step testable in isolation and immune to unrelated junk in the conversation. Least-context is the multi-agent version of least-privilege.

---

*Next: [When "Recovery" Meant Data Loss](04-when-recovery-meant-data-loss.md) — the cleanup path that deleted the founder's work.*

---

### Work with Turicks

Turicks builds AI-native software and puts the discipline from this story to work on client systems — agent architectures that ship in days, don't hallucinate their results, and stay simple under the velocity of an AI coding agent. See what we ship at **[turicks.com](https://turicks.com)**.

> *[Client outcome placeholder — add a one-line result + attributed quote here once cleared for publication.]*
