# AG-011 — Point the existing judge at answer quality (async evaluator)

**Milestone:** eval infrastructure (limitations L5 + L6)
**Branch:** `feat/answer-quality-judge` — cut from fresh `origin/main`. PR base: `beta`.
**Status:** dispatched
**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Goal

`src/infra/judge.ts` is the best-built thing in this repo that almost nothing uses. It already does
what a 2026 interview probes for: it runs on a **different model family** from the agent
(specifically to avoid LLM-as-judge identity bias), at temperature 0, with a deterministic verdict
parser and a fail-open path so infra failure can never block the founder.

It has **one** caller. `judgeOutbound` is invoked from `src/agents/agent-tools/comms.ts:34` to grade
outbound brand voice. It never sees an answer the system gives the founder.

Separately, FounderOS has inline guardrails (`flagDangerousCommand`, `hitlGate`, budget caps) and
**zero async evaluation**. The distinction between the two — a guardrail blocks a specific failure
inline on a millisecond budget; an evaluator scores quality asynchronously off the hot path — is
used as a seniority filter in interviews, and we are currently on one side of it only.

**Done means:** every completed turn is scored **asynchronously, off the reply path**, by the
existing judge, and the verdict is persisted. The founder's reply latency must not move by a
measurable amount.

---

## Measured starting state — verify these yourself before you begin

```bash
grep -rn "judgeOutbound\|isJudgeEnabled" src/ | grep -v "^src/infra/judge.ts"
grep -c "" src/infra/judge.ts
```

| Measure | Value |
|---|---|
| Callers of `judgeOutbound` in `src/` | **1** — `src/agents/agent-tools/comms.ts:34` |
| Async evaluators in the system | **0** |
| Judge model default | free OpenRouter Llama-70b — a **different family** from the Gemini agent, deliberately |
| Judge behaviour on error | fails open to `pass`, logs a warning (`judge.ts` ~line 205) |

Existing public signature:

```ts
export async function judgeOutbound(
  text: string,
  channel: Channel,
  opts: { model?: JudgeModel; now?: () => number; tool?: string } = {},
): Promise<JudgeVerdict>;
// JudgeVerdict = { verdict: "pass" } | { verdict: "revise"; critique: string }
```

---

## Files in scope

| Path | Change |
|---|---|
| `src/infra/judge.ts` | add an answer-quality entry point beside `judgeOutbound` |
| `src/infra/answer-eval.ts` | **new** — the async evaluation sink |
| `src/db/schema.ts` | **new table** for verdicts — the ONE schema change allowed in this brief |
| `drizzle/` | the generated migration |
| `tests/unit/infra/` | tests for the new entry point and the async sink |

**Do not edit `src/kernel/synthesizer.ts` or `src/gateway/kernel-run.ts`.** AG-008 and AG-009 own
those two files on parallel branches. Find a hook that does not touch them — if you cannot, **stop
and report** rather than editing a contested file.

---

## The pattern to follow

**Reuse, do not rebuild.** `judgeOutbound`'s internals — model resolution, TTL memoisation,
`parseJudgeVerdict`, the fail-open catch — are all correct and already tested. Add a sibling entry
point that reuses them with a different prompt. Read `buildJudgePrompt` and follow its shape. **A
second judge module is an automatic rejection of this PR.**

**Asynchrony is the whole point.** The evaluation must not be awaited on the reply path. Follow the
fire-and-forget shape already used for `writeTaskOutcome` (`src/kernel/synthesizer.ts:130`) and
`kernelCostSink` (`src/gateway/kernel-run.ts:69`): `void`-ed, `.catch()`-ed, tagged
`// allow-failopen: <reason>` so `pnpm verify:arch` passes.

**What to score.** Three dimensions, scored separately — do not collapse them into one number:

| Dimension | Question |
|---|---|
| Groundedness | Is every factual claim in the reply supported by a `StepResult` the turn actually produced? |
| Relevance | Does the reply answer the goal that was planned? |
| Completeness | Were any planned steps left unaddressed in the reply? |

Groundedness is the one that matters most here, because it is the machine-checkable complement to
the receipts mechanism the kernel already enforces.

**Fail open, always.** A judge outage must degrade to "not evaluated" and must be *visibly*
distinguishable from "evaluated and passed". Read the header of
`src/infra/rag-optimization-sweep.ts` — a failure path that renders as a clean all-clear is the
specific bug that file exists to prevent, and it is the easiest mistake to make here.

---

## Explicitly forbidden

- **Do not gate, block, or modify the founder's reply.** This is an evaluator, not a guardrail. If
  the verdict is `revise`, that is recorded, not enforced. The human gate stays the only gate.
- **Do not add measurable latency to the reply path.** Never `await` the judge before replying.
- **Do not write a second judge module** or a second model-resolution path.
- **Do not use a paid model for the judge.** It defaults to the OpenRouter free tier; keep it there.
- **Do not edit `src/kernel/synthesizer.ts` or `src/gateway/kernel-run.ts`** (contested files).
- No `any`, no `console.log`, no file over 400 LOC.

---

## Verify

Run and **paste raw output**:

```bash
pnpm lint && pnpm verify:arch && pnpm test
```

Then prove the asynchrony claim rather than asserting it — show the reply path contains no `await`
on the judge:

```bash
grep -rn "await.*judgeAnswer\|await.*answerEval" src/
```

That grep returning **no results** is the pass condition; paste it either way.

In the PR body, state whether you ran a live evaluation against a real turn or unit tests only.
**"NOT VERIFIED — reason" is acceptable. A claim of live verification that did not happen is not.**
