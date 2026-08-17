# Reality Benchmark runner — make real evidence cheaper than fake evidence

**Date:** 2026-08-13 · **Branch:** `claude/benchmark-runner`
**Serves:** Task 0 of the self-improvement remediation plan, which gates Task 6.

## The problem this solves

Task 0 has never been done. The file that looks like a baseline —
`docs/product-recovery/benchmark-runs/2026-08-08-baseline.md` — fails its own
verifier:

```
Tasks with an evidence block: 0/34 (0 declared NOT RUN)
FAIL — 2 problem(s). This run is not a baseline.
  · 34 of 34 tasks have no evidence block: A1, A2, … E4
  · no raw evidence export at …evidence.jsonl
```

It is the scorecard-written-from-code-inspection that `verify-benchmark-run.ts`
was built to reject: 34 tasks scored, 0 transcripts.

The verifier was the right response, but it only made faking expensive. Nobody
made *collecting* cheap, so the task sat undone. Done by hand it is 34 prompts
sent one at a time, 34 replies transcribed, 34 turnIds correlated out of
journald, and 272 dimension scores — three to four hours.

## Binding constraint

Not scoring — that is irreducible human judgment, and it is the part worth the
founder's time. The constraint is **transcription and correlation**: mechanical
work that a script does perfectly and a human does slowly and with errors.

Two specific frictions make the manual path worse than it looks:

- **`turnId` never appears in Telegram.** It is a `randomUUID()` correlation id
  (`src/infra/trace.ts:76`) that reaches journald and the kernel, never the
  reply. It cannot be read off a phone.
- **journald carries only the first 200 chars of a reply**
  (`src/gateway/kernel-run.ts:243`, `replyPreview: reply.slice(0, 200)`), so the
  verbatim reply must come from Telegram, not the logs.

## Design

`scripts/run-benchmark.ts`, two subcommands, on top of the MTProto client the
`pnpm qa:telegram` harness already proved (only an MTProto *user* session can
send as the founder — the Bot API posts as the bot, which the bot never
re-ingests).

| Step | Who | Command |
|---|---|---|
| Send 24 canonical prompts, capture verbatim replies + ISO timestamps | script | `pnpm benchmark:run` |
| Export journald corroboration | founder (needs VPS) | `ssh founderos-vps 'sudo -n journalctl …'` |
| Correlate every prompt to its `turnId` | script | `pnpm benchmark:turnids <run.md>` |
| Score 34 tasks × 8 dimensions | **founder** | by hand |
| Gate | script | `pnpm verify:benchmark <run.md>` |

Group D (9 adversarial setups) and E4 have no canonical wording — they are
setups a human performs. Those blocks are scaffolded with a `**setup:**` line to
fill in or mark `NOT RUN — <reason>`.

## What keeps this honest

The runner **cannot** manufacture a passing run, and this is structural, not a
promise:

1. **Scores are written as `_`, never `0`.** The verifier rejects `_`, so a file
   the runner produced cannot pass until a human has judged every task.
   Defaulting to zeros would have let an unjudged run through — the same defect
   as the scorecard that made the verifier necessary.
2. **The runner does not write the evidence file.** `verify:benchmark` still
   requires every `turnId` to appear in a journald export produced by a command
   the founder runs against prod.
3. **Silence and refused sends are recorded as `NOT RUN — <reason>`**, never as
   an empty passing block.
4. **An uncorroborated task keeps its `FILL-ME` placeholder.** `benchmark:turnids`
   reports unmatched tasks rather than guessing, and the verifier then rejects
   them.

`CANONICAL` is now **exported** from `verify-benchmark-run.ts` and imported by
the runner. One list, one source: a runner with its own copy would drift by a
word and fail every task on wording *after* the founder had already spent the
session collecting replies.

## Alternatives rejected

- **Extend `scripts/e2e-telegram-qa.ts`.** It is 790 lines of production
  acceptance tooling with no test coverage and a different task model
  (HITL approval, audit-row assertions). Bending it to a second purpose risks
  the acceptance suite for no gain. The MTProto plumbing moved to
  `scripts/lib/mtproto.ts` instead; the old private copy is left in place, with
  the duplication documented rather than hidden.
- **Auto-score from reply text.** An LLM judging whether the bot told the truth
  is precisely the measurement under test. The number would be worthless.
- **Skip journald and trust the runner's own record.** That is the forgery the
  verifier exists to prevent, and the runner must be subject to it too.

## Not covered

The scoring rubric itself, Group D setups, and running the thing — all founder
work, by design. This ships the tooling, not the baseline.
