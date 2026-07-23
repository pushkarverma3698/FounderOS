# When "Recovery" Meant Data Loss

*Turicks Engineering — the v1 → v2 → v3 journey, part 4 of 5*

The most dangerous line of code in v2 was a `catch` block that presented itself as helpful. When a task looped, the system "recovered" by wiping the entire conversation from Postgres and telling the founder, cheerfully, "I've cleared that task — just send your next message." That is data loss wearing the costume of error handling. Here's how it got there and how v3 made failure honest.

**By the numbers**

| | |
|---|---|
| Fail-open catches in the gateway alone | **20+** `.catch(() => null)` / warn-and-continue sites |
| The observed loop (audit "Run D") | **14 LLM hops** → `GraphRecursionError` |
| Wasted context before the abort | **~14 KB** per hop, ten hops deep |
| The "recovery" | `clearThreadAfterAbort()` — **wiped the thread's checkpoints** |
| After v3 | typed `FailureReport`; threads wiped **only** by `/reset`; fail-open is CI-taxed |

**What it cost us — and how we got out.** The worst incidents were the quiet ones. A model would loop, hit the recursion limit, and the system would delete the founder's entire conversation — every completed step — then report it as a courtesy: *"I've cleared that task, just send your next message."* Work vanished and the system congratulated itself. And because twenty-plus catches swallowed errors and limped forward, the bot spent much of its time running in an unknown state nobody could see. We got out by treating failure as a **typed value the founder always sees**, and by making it a build-checked rule that no recovery path may destroy state.

---

## The Genesis (v1)

v1 didn't have sophisticated recovery — it had silent failure, which is its own kind of data loss. As covered in [part 2](02-lie-detector-for-our-own-ai.md), approvals produced audit rows but no action. The "error handling" was the absence of any signal that something had gone wrong at all. The founder's *intent* was lost every time, quietly. v1 lost your work by never doing it; v2 would lose your work by deleting the evidence you'd asked.

## The Bloat & AI Slop (v2)

v2's failure handling had two habits, both classic AI-generated defensiveness, and both corrosive.

**Habit one: fail open everywhere.** The gateway and entrypoint alone had **20-plus `.catch(() => null)` / warn-and-continue sites** — state reads, checkpoint purges, budget checks, restores. Each one, in isolation, looks like reasonable defensive code an agent would happily write for you. In aggregate they meant the system almost never *stopped* on an error; it swallowed the error and limped forward in an unknown state. A failed budget check that returns `null` doesn't protect you — it removes the budget guard.

**Habit two: destructive "recovery."** The worst case is worth tracing exactly, because we watched it happen live (audit "Run D"):

1. A realistic-but-weak model never finalized a task and kept calling a tool in a loop.
2. To stop runaway loops, a tool-call cap silently removed the tool from the schema. The model, not seeing why, kept calling it for ten more hops.
3. After ~14 hops, LangGraph threw `GraphRecursionError` at the recursion limit.
4. The `catch` block called `clearThreadAfterAbort()` — **which wiped the thread's checkpoints.** The complex task and every completed step in it were erased.

So a model loop cost the founder their entire conversation state, and the system reported it as a courtesy. Ten wasted LLM hops (roughly 14 KB of context each), then deletion, then a reassuring message. Nowhere in that path could any layer say *which step of the task* had died, or *resume* from it — because there was no concept of "a step" as a durable, named thing. Failure was a single undifferentiated event handled by forgetting.

This is the quiet danger of letting an agent write your error handling: it will reach for `try/catch (…) { return null }` and `clear-and-retry` because those patterns are everywhere in its training data and they make tests pass. They are also exactly how you lose data in production.

## The Production Reality (v3)

v3 treats failure as a first-class, typed value — not an exception to swallow and not a reason to delete state.

- **`FailureReport` is a contract**, same as everything else: `stage + component + evidence + retryable`. When something fails, the system produces an object that names *where* (which stage), *what* (which real component — db, provider, tool), *why* (evidence), and *whether it's worth retrying*. The founder always sees it. Compare that to v2's "something suspicious happened, I've cleared it."
- **Threads are never silently wiped.** The only thing that wipes a thread is the founder typing `/reset`. A model loop now terminates with a typed failure and a surfaced "this step stalled" message — the conversation survives. In the audit's own words, the definition of stable became: Run D's loop scenario ends in ≤3 hops with a surfaced reply **without wiping the thread**. That's now a passing test: `kernel-e2e: loop scenario (audit Run-D)`.
- **Fail-open is no longer free.** Any `catch` that swallows and continues must carry an explicit `// allow-failopen: <reason>` tag, and CI counts them via the architecture-debt ratchet. The number can only go down. Defensive silence now costs a code reviewer's signature and a visible entry in the debt ledger, instead of hiding in a diff.
- **Because a step is a durable, typed thing, the system is resumable.** HITL follows the same discipline: the approval row is written *before* `interrupt()`, side effects run only after approval, and the idempotency key is checked before every send — so a crash mid-approval resumes cleanly instead of double-sending or vanishing.

Failure stopped being an embarrassing event to paper over and became structured information the founder is entitled to.

## Key Engineering Takeaways

- **`catch (e) { return null }` is not error handling — it's error hiding.** One is defensible with a written reason; twenty is a system that never knows its own state. Make swallowing an error cost something visible (a required tag, a tracked count) so it can't accumulate silently.
- **Never let a recovery path do something more destructive than the failure it's recovering from.** Wiping durable state to escape a loop is a cure worse than the disease. Recovery should preserve information, not delete it — and "I cleared it for you" is a phrase to be deeply suspicious of.
- **Model failure as a value, not an exception.** A typed `FailureReport` that names stage + component + evidence turns "it broke" into "the provider returned 503 at the synthesize stage, retryable." One is a support ticket; the other is a fix. Failures that name the real component save the debugging session that a misattributed error would have wasted.
- **Resumability requires durable, named steps.** You can't resume from step 3 if "step 3" isn't a thing your system can point at. The typed plan and step results from parts 1 and 3 are what *make* honest recovery possible — good architecture compounds.
- **Watch what patterns your AI agent reaches for under pressure.** Agents default to fail-open catches and clear-and-retry because those satisfy the immediate test. Those are precisely the patterns that lose data at scale. Review error handling more skeptically than happy-path code, because that's where the agent's defaults hurt you most.

---

*Next: [Working With AI Coding Agents Without Drowning in Slop](05-working-with-ai-agents-without-slop.md) — the playbook the first four studies paid for.*

---

### Work with Turicks

Turicks builds AI-native software and puts the discipline from this story to work on client systems — agent architectures that ship in days, don't hallucinate their results, and stay simple under the velocity of an AI coding agent. See what we ship at **[turicks.com](https://turicks.com)**.

> *[Client outcome placeholder — add a one-line result + attributed quote here once cleared for publication.]*
