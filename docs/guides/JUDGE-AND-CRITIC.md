# Judge & Critic Pattern Guide

**What is the judge?** A Claude-powered quality gate that evaluates outbound copy (email, LinkedIn posts) before HITL approval. Different model from the drafter (prevent sycophancy).

## Two-Gate System

```
Draft (Gemini 2.5)
  → Gate 1: Brand-Validator (deterministic: banned phrases, word count, phishing check)
  → Gate 2: Claude Judge (LLM-based: tone, clarity, compliance)
  → HITL Approval (founder approves or rejects)
  → Send
```

## Judge Implementation

**File:** `src/infra/judge.ts`

```typescript
export async function judgeOutboundCopy(content: string, context: {
  tool_name: string; // "linkedin_post", "send_email"
  draft_context: string;
}): Promise<{
  passed: boolean;
  violations: string[];
  guidance?: string;
}> {
  // Call Claude (NOT Gemini) with JUDGE_PROMPT
  // Returns: { passed, violations[], guidance? }
}
```

## What Judge Checks

1. **Brand Voice**: Does it sound like Turicks (authority, direct, no fluff)?
2. **Clarity**: Can reader understand the ask? Scannable in 30s?
3. **Compliance**: No phishing ("claim prize"), no false claims ("guaranteed")
4. **Length**: Within bounds (email <500w, LinkedIn <300w)

## Interpreting Feedback

| Response | Action |
|----------|--------|
| `passed: true, violations: []` | Clean. Go to HITL. |
| `passed: false, violations: [...]` | Fix issues, resubmit. |
| `guidance: "..."` | Optional polish advice. |

## Fail-Open Semantics

If `ANTHROPIC_API_KEY` is missing:
```typescript
return { passed: true, violations: [] }; // No-op pass
```

No blockage — Telegram judge gate can't crash the bot.

## Memoization (60-min cache)

Same draft within 1 hour reuses prior judgment (free, instant).

## Critical Rule

**Generator ≠ Critic.** Always use Claude for gate 2, even if Gemini is cheaper. Reason: Gemini drafter + Gemini judge = feedback loop = rubber-stamping.

## Observability

- Judge calls logged in `budget_tracker`
- Violations logged per turn
- Memoization hits tracked separately

---

See [PHASE-3-CLAUDE-JUDGE.md](../phases/PHASE-3-CLAUDE-JUDGE.md) for full Phase 3 details.
