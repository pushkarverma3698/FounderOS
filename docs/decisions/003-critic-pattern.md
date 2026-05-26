# ADR-003: The Critic Pattern — Cross-Model Quality Gate

**Date:** 2025-05  
**Status:** Accepted  
**Context:** AI agents produce output that goes to real prospects, gets committed to GitHub, or publishes to LinkedIn. We need a quality gate that catches mistakes before human review.

---

## The Problem

AI-generated content has characteristic failure modes:
- **Hallucinated facts** — model claims something specific that isn't in the context
- **Generic outputs** — "We help companies like yours" fails for a sales email
- **Rule violations** — email exceeds 150 words; code has `any` types; LinkedIn post has 5 emojis
- **Sycophancy** — when asked to critique its own output, a model tends to approve it

The naive approach is to ask the same model that wrote the email to review it. This fails badly — the model that wrote "I wanted to reach out to share our game-changing solution" will not flag its own banned phrases.

---

## Options Considered

### Option A: Same Model Self-Review
Ask the generator model to "review the following for quality issues."

**Experiment results:** When we tested this with Gemini Flash generating and reviewing its own sales emails, it approved 94% of outputs — including ones with explicit banned phrases. The model rationalised rule violations ("this phrase establishes rapport") rather than flagging them.

**Verdict:** Fails due to sycophancy. Not viable.

### Option B: Rule-Based Linting
Write a TypeScript function that checks outputs against a rules file using regex and keyword matching.

**Pros:** Deterministic, fast, zero cost.  
**Cons:** Can only check what you explicitly coded. Misses nuanced issues like "the opening paragraph leads with our capabilities, not their pain." Can't check tone, specificity, or contextual relevance. Would need to be maintained as rules evolve.

**Verdict:** Good for a first filter (e.g. word count, banned phrase detection) but not sufficient as the sole quality gate.

### Option C: Cross-Model Critique (Different Provider Family)
Use a different model family for critique than for generation:
- Generator: Gemini family (Google)
- Critic: Claude family (Anthropic)

The critic receives the output plus the rules from `governance/critique-rules.md` and produces a structured `CritiqueRecord`.

**Pros:**
- Different training data + RLHF process → genuinely different perspective
- Claude is notably good at following rules and structured output — ideal for a critic role
- Cross-provider means the critic has no "loyalty" to the generator's output
- `critique-rules.md` is a plain Markdown file the critic loads at runtime — rules are versionable and updatable without code changes

**Cons:** Extra LLM call = extra cost and latency (~$0.003 per critique at Claude Haiku rates). Acceptable for our scale.

---

## Decision: Cross-Model Critique as a LangGraph Node

### Why a NODE, not a conditional edge

This is the most important implementation detail. In LangGraph:
- **Conditional edges** are pure functions — they read state and return a destination node name
- **Nodes** can have side effects — they read state, call external services, write to DB, and return state updates

The critic **must** be a node because it:
1. Makes an LLM API call (external service call — not a pure function)
2. Writes a `CritiqueRecord` to the state (state mutation)
3. Increments `revision_count` (state mutation)
4. Could log to LangSmith / DB (side effect)

```typescript
// ✅ CORRECT — critic is a NODE
graph.addNode("critic", criticNode);
graph.addConditionalEdges("critic", afterCriticEdge); // pure routing only

// ❌ WRONG — never put LLM calls inside conditional edges
graph.addConditionalEdges("generator", async (state) => {
  const result = await callLLM(...); // side effect in edge → non-deterministic routing
  return result.approved ? "hitl" : "generator";
});
```

The conditional edge `afterCriticEdge` is a pure function that reads `state.critiques` and `state.revision_count` — no external calls, fully deterministic.

### The Generator-Critic Loop

```
generator ──► critic ──► [afterCriticEdge]
    ▲                         │
    │    NEEDS_REVISION        │ revision_count < max_revisions
    └─────────────────────────┘
                              │ APPROVED or revision_count >= max
                              ▼
                           hitl_node
```

When `revision_count >= max_revisions`, the critic sends to HITL *regardless of critique result* — with an escalation note. This ensures the human always sees the output after 2 failed revisions. The human decides whether the escalated output is acceptable.

### governance/critique-rules.md

Rules live in a plain Markdown file, not in code:

```
## Sales Department
- Pain-first opening — lead with their problem, not our capabilities
- Word count — outreach ≤ 150 words; proposals ≤ 500 words
- Banned phrases: "I wanted to reach out", "Hope this finds you well"...
```

The critic node reads this file at runtime:
```typescript
const rules = await fs.readFile("governance/critique-rules.md", "utf-8");
// Injected into the critic's system prompt
```

This means rules can be updated without touching code or redeploying. The governance team (or the founder) can update rules.

---

## Consequences

- **Two LLM calls per generation cycle** — generator + critic. For `md` tier, that's roughly $0.001 + $0.003 = $0.004 per cycle. Acceptable.
- **Model family discipline** — never use the same provider for both generator and critic in the same pod. Code review this.
- **Revision count matters** — always check `revision_count < max_revisions` before looping. Without this guard, a persistent rule violation would loop forever.
- **CritiqueRecord is append-only** — the `critiques` array uses an append reducer. Full critique history is preserved in state — useful for debugging why something escalated to HITL.
- **governance/critique-rules.md is in the Docker image** — `Dockerfile` copies the `governance/` folder. Any update to rules requires a new Docker image in production.
