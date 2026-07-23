# Receipts Over Vibes: Why Action-Taking Agents Must Prove Their Work

*Turicks — engineering notes*

There's a category of AI failure that's worse than a crash: the agent that
confidently tells you it did something it didn't do. "✅ Email sent to the client."
"✅ Deployed." "✅ Refund issued." No email, no deploy, no refund — just a sentence.
For a chatbot that's embarrassing. For an agent that acts on your behalf, it's the
whole ballgame.

We learned this twice, from both directions, building FounderOS.

## Two ways to lie

**Version 1 lied by omission.** Our first system would report success — it even
wrote a database row as "proof" — while the actual action never fired. The tool
that should have sent the email was fully built and connected to nothing. The
system believed its own paperwork.

**Version 2 tried to police the lie and made it worse.** We built a 591-line,
77-regex "lie detector" that scanned the agent's replies for phrases that *sounded*
like unbacked claims. It could never be right, only tuned — because there is no
regex that distinguishes "I sent the email" (true) from "I sent the email" (false).
**The truth isn't in the text.** When it guessed wrong, it replaced correct answers
with refusals and, to "clean up," rewrote our own database history. We had stacked
a brittle heuristic on top of a probabilistic model and handed it an eraser.

## The truth is in the receipt

The fix was to stop reading outcomes off the prose and start requiring evidence
from the thing that does the work.

In FounderOS today, every tool execution emits a **receipt** — recorded by the code
that runs the tool, never by the model. It captures what ran, with what arguments
(hashed), the result, whether it succeeded, and the idempotency key. Then one rule
governs the whole system: **an action step is rejected unless it carries a
successful receipt.** And the component that writes the final "✅ Sent" reply only
ever sees validated results — so it is physically incapable of narrating an action
that has no receipt behind it.

The difference is the difference between *detection* and *prevention*:

| | Detect (v2) | Prevent (v3) |
|---|---|---|
| Mechanism | 77 regexes scanning the reply | one receipt check |
| Grows with | every incident | never |
| Can it be wrong? | constantly (and expensively) | no — the unbacked claim can't reach the writer |
| Source of truth | the prose (wrong) | the execution receipt (right) |

There's nothing to tune. A greeting produces no receipts because it needs none; a
send produces a receipt or it produces a typed failure. The synthesizer can only
say what the evidence supports.

## Why this matters more every month

As agents take on more real actions — and [merge more code that no one
reviewed](https://addyosmani.com/blog/agentic-code-review/) — the cost of a
confident false claim scales with the privilege you've granted. An agent that can
send email, push code, or move money cannot be trusted on its own say-so. It has to
be *structurally unable* to claim an action it didn't take.

This is also why we're skeptical of "we added guardrails" as a safety story. A
guardrail that scans output is a heuristic that can be wrong, and a wrong heuristic
wired to something irreversible is a liability. Prevention beats detection:
instead of grading the essay, check the work.

## The principle, portable

You don't need our exact system to apply this. The rule generalizes to any
agent that acts:

1. **Instrument the action, not the description.** The code that performs the side
   effect returns the evidence. The model never writes its own proof.
2. **Gate the claim on the evidence.** No receipt, no success — full stop.
3. **Show the human only what's proven.** Whatever writes the final message should
   never see an unvalidated action, so it can't narrate one.
4. **Keep the audit append-only.** Never let a "safety" or "cleanup" step rewrite
   the record of what happened.

Receipts over vibes. It's less impressive-looking than a clever detector, and it's
the reason our agent can take real actions without us holding our breath.

---

*The receipt model is the zero-hallucination guarantee at the core of FounderOS —
diagrammed in [07 — Receipts & Zero-Hallucination](../diagrams/07-receipt-and-zero-hallucination.md)
and dissected in [The Lie Detector We Built for Our Own AI](../turicks-case-studies/02-lie-detector-for-our-own-ai.md).
Turicks builds action-taking software that proves its work. [turicks.com](https://turicks.com).*
