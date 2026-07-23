# The Lie Detector We Built for Our Own AI

*Turicks Engineering — the v1 → v2 → v3 journey, part 2 of 5*

The scariest failure mode of an action-taking agent isn't crashing. It's **saying it did something it didn't do** — "✅ Email sent to the client" when no email left the building. We spent an embarrassing amount of v2 trying to catch those lies after the fact with pattern matching. v3 made the lie structurally impossible instead. This is the difference between detection and prevention, learned the hard way.

**By the numbers**

| | |
|---|---|
| The lie detector | `execution-guard.ts` — **591 LOC**, **~77 regexes**, **68 exports** |
| Cost of a false positive | **2× LLM spend** (full re-invoke) + a canned refusal replacing a correct answer |
| Worst side effect | the gateway **rewrote its own Postgres history** on a regex verdict |
| Growth pattern | **+1 regex per incident**, forever |
| After v3 | **1** receipt check in a pure validator; the guard is a CI tombstone |

**What it cost us — and how we got out.** The detector only ever grew, because a missed lie cost nothing visible while every incident added a pattern. Worse, its false positives silently replaced *correct* answers with refusals and edited our durable message history — so we were debugging a system whose memory of the past kept changing underneath us. That's a special kind of suffering: you can't trust the logs because the "safety" layer rewrote them. We got out by deleting the detector entirely and moving the question from "does the reply *sound* honest?" to "is there a **receipt**?"

---

## The Genesis (v1)

v1 had the inverse problem, and it's what taught us to fear this failure mode. As covered in [part 1](01-three-router-trap.md), v1's finalize node wrote an audit-log row and returned without calling the tool. So the system would confidently report success — there was even a database row to "prove" it — while nothing had happened.

The lesson we *should* have taken: an action is only real if the thing that performs it hands back evidence. The lesson we actually took into v2: "the AI sometimes claims things that aren't true, so let's build something to catch it."

## The Bloat & AI Slop (v2)

Enter `execution-guard.ts`: **591 lines, roughly 77 regexes, 68 exports.** It was a hand-built lie detector for our own model, with functions like `detectUnbackedShellClaim`, `detectUnbackedGithubWriteClaim`, and `FAKE_INBOX_CLAIM_RE`. After the graph produced a reply, the guard scanned that reply for phrases that *sounded like* an unbacked claim and rendered a verdict.

This is AI slop in its purest form, and it's seductive because it feels responsible. Every past production incident became a new regex. The file only ever grew, because a false negative (a missed lie) costs nothing visible, while every incident adds a pattern. And the verdicts were expensive when wrong:

- **False positive** → the gateway re-invoked the entire graph (2× the LLM spend), and sometimes replaced a *correct* answer with a canned refusal.
- To "clean up," it ran `purgeFabricatedAiFromCheckpoint` — **the gateway rewrote LangGraph's own history in Postgres based on a regex verdict.** The durable record was no longer append-only. The next turn saw an edited past.

We had built a probabilistic component (the LLM), then a second brittle heuristic system (77 regexes) to police it, then wired that heuristic into the ability to *rewrite the system's memory.* Three layers of "maybe" stacked on top of each other, and the bottom one held the eraser.

The tell that this was slop and not engineering: the guard could never be *right*, only tuned. There is no regex that reliably distinguishes "I sent the email" (true) from "I sent the email" (false), because **the truth isn't in the text.** It's in whether the send happened. We were trying to read the outcome off the prose.

## The Production Reality (v3)

v3 deleted the lie detector — it's a CI tombstone now — and moved the question from *"does the reply sound honest?"* to *"is there a receipt?"*

The mechanism is small and boring, which is how you know it's right:

1. **Every tool execution emits a code-recorded `ToolReceipt`** — not written by the model, written by the adapter that runs the tool. It records what ran, with what arguments, the result, and the cost.
2. **A step's `StepResult` is validated against `OUTPUT_CONTRACTS`** by `validateStepResult` — a pure function. An action step with no successful receipt is a *terminal, typed failure*, not a passing step with a nice sentence.
3. **The synthesizer only ever sees validated results.** The final LLM call that writes "✅ Email sent" is physically incapable of claiming an action that has no receipt behind it, because the unbacked action never reaches its input.

So the invariant went from "we try to catch the model lying" to "**the model cannot express an action claim that isn't backed by evidence.**" There's nothing to tune. A greeting costs exactly one LLM call and produces no receipts because it needs none; a send produces a receipt or it produces a `FailureReport`. Both are executable scenarios in the kernel test suite, run offline at $0 — see `docs/PROOF.md`, where "every tool execution emits a receipt; unproven action claims are rejected" is a test named `kernel-e2e: fabricated action`, not a promise.

We stopped grading the essay and started checking the work.

## Key Engineering Takeaways

- **Detection scales linearly with every incident; prevention is a one-time structural cost.** A regex guard grows forever because you add a pattern per incident. A receipt contract is written once and every future tool inherits it. If your safety mechanism gets bigger every sprint, it's the wrong mechanism.
- **Truth about an action lives in the action's evidence, never in the model's description of it.** The instant you find yourself pattern-matching an LLM's output to decide whether it "really" did something, you've already lost — go instrument the thing that does it and return a receipt.
- **Never let a heuristic hold the eraser.** A guard that can be wrong should never be wired to something irreversible like rewriting durable history. Keep your audit log append-only; a "cleanup" path that edits the past is a data-integrity bug wearing a safety vest.
- **Make your guarantees executable, not aspirational.** "The system doesn't hallucinate actions" is worthless as a sentence in a README. As a named test that runs in CI at $0, it's a guarantee. Convert every safety claim into a scenario.
- **Boring beats clever for trust.** The receipt model is far less impressive-looking than a 77-regex lie detector. It's also correct. When a component's job is trust, optimize for "obviously can't go wrong," not "sophisticated."

---

*Next: [Empty Braces: The Handoff That Lost the Task](03-empty-braces-handoff.md) — where the data went to die between agents.*

---

### Work with Turicks

Turicks builds AI-native software and puts the discipline from this story to work on client systems — agent architectures that ship in days, don't hallucinate their results, and stay simple under the velocity of an AI coding agent. See what we ship at **[turicks.com](https://turicks.com)**.

> *[Client outcome placeholder — add a one-line result + attributed quote here once cleared for publication.]*
