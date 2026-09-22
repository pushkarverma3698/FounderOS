# 2026-09-23 — production hallucination audit (8 defects)

## What we did

Read the real production chat and journal end to end — 366 turns and the full
`founderos.service` journal back to 2026-07-14 — looking for one thing: places
where FounderOS states something is working, or explains why something is not,
without evidence for the claim.

Eight defects were found. Every one is reproduced from a named production turn
with its timestamp, and every one has a regression test that fails on the old
code. No defect in this document is inferred from reading source alone.

## What we fixed

| # | Defect | Where | Founder-visible symptom |
|---|---|---|---|
| D1 | `read_logs` summarised the returned SLICE, not the scanned window | `src/tools/read-logs.ts` | "Healthy / Fully Operational (0 errors, 1 warning)" — the window held 5 warnings |
| D2 | `isFailureResult` missed prose failures, so failed tools were recorded `ok:true` | `src/kernel/tool-failure.ts` | "✓ 1 action completed and verified" printed under "Mission incomplete … execution failed" |
| D3 | A malformed planner response was terminal, `retryable:false`, no retry | `src/kernel/planner.ts` | Founder typed "Try again" 3× in 9 minutes; it worked every time |
| D4 | Synthesizer was free to invent CAUSES for things it only observed as absent | `src/kernel/synthesizer.ts` | "…because it is currently actively executing the implementation, test suite and verification pipeline" — nothing observed that |
| D5 | `resolveExecutorCwd` refused a model-invented home prefix instead of re-rooting | `src/tools/claude-code-cwd.ts` | Engineering capability reported broken; the workspace existed |
| D6 | No route for "create a GitHub issue"; nothing stopped a memory write standing in for a task | `src/kernel/planner.ts` | Issue request answered with "I have recorded your preference"; no issue filed |
| D7 | History was capped at 20 turns and 16k chars — and at no age | `src/kernel/state.ts` | A 4-day-old instruction hijacked an unrelated request (root cause of D6) |
| D8 | 48% of the journal was a third-party upgrade nag | `src/tools/read-logs.ts` | Halved the capacity of the only self-diagnosis instrument |

### The evidence behind each

**D1** — 2026-09-22 20:25, "Check production logs for founder Os". `summarizeLogs()`
ran on `filtered.slice(-limit)` instead of `filtered`. Measured on the real
journal: the 1-hour window held 66 lines and 5 warnings; the returned last-50
slice held 1. The reply reported 1 and called the system healthy, and `truncated`
was `false` — the model was told the window was complete. This is the same
confident false negative the `SCAN_CAP` comment in that file was written to kill;
that fix corrected journalctl's `-n` and left the identical bug one layer down.
Verified against the real window after the fix: **5 warnings, `truncated: true`,
16 lines named as withheld.**

**D2** — 2026-09-22 20:30, "Ping claude and check what all models are available".
`claude_code` refused and the wrapper returned `"Claude Code failed: Access
denied: …"` — a bare string with no `❌`, no `[[TOOL_FAILURE` marker and no JSON
envelope, so `isFailureResult()` returned false and the ToolReceipt was written
`ok:true`. **58 call sites in `src/agents/agent-tools/` return failure this way**,
including `Email send failed:`, `Calendar event creation failed:`, `Deploy
failed:` and `Command failed:`. The detector was fixed rather than the 58 sites
because `ok = !isFailureResult(…)` in `worker.ts` is the one choke point every
tool result passes through — the sites cannot regress past it and new wrappers
are covered on arrival. Patterns are `^`-anchored with a subject prefix that
excludes `:` and `,`, so a successful result whose *content* discusses failure
("4482 passed, 0 failed", a log read returning error lines) stays a success.

**D3** — 2026-09-16 19:42, 19:45, 19:51. Three "Planner did not return JSON"
failures; each fixed by the founder typing "Try again"; 100% manual-retry success
rate against a failure the contract declared `retryable:false`. Now retried once
in-band with the rejected text and the specific complaint fed back — which is
what "Try again" supplied by hand. Bounded at one: two failures against a
corrective instruction is a real defect and stays loud.

**D4** — 2026-09-16 19:47, "Why is it that it haven't worked on a branch?". No
tool in the catalog can observe an Antigravity workspace; the step results held
an issue state and the absence of a branch and a PR. Six minutes later the same
system reported "Branch spawned: No. Work completed: No." The existing prompt
forbade inventing URLs — a fact-shaped claim — and said nothing about inventing
causes, which is the shape that shipped. This is the most expensive class for
daily use: it is unfalsifiable and it counsels waiting.

**D5** — same 20:30 turn. The worker passed
`cwd="/home/pushkar/Projects/agent-workspace"`; the service runs as
`HOME=/home/founderos` and `/home/founderos/Projects/agent-workspace` exists. The
model cannot know the host's home directory and the schema never asked it to.
An absolute path naming a `Projects/` segment is now resolved against the real
`~/Projects`. Both guards are unchanged and asserted: the FounderOS self-repo
refusal and `isProjectPath()` containment both still fire after re-rooting.

**D6 / D7** — 2026-09-21 07:23. Verbatim: *"Create a GitHub issue in FounderOS to
add a visible test comment to the bottom of the README.md file, and explicitly
label it agent:ready so the VPS dispatcher picks it up"*. FounderOS called
`update_context`, rewrote the founder's persistent business context, and replied
that a PDF preference had been saved. Sixteen minutes later he wrote the dispatch
brief by hand. The PDF instruction was real — given 2026-09-16 17:13, **4 days
14 hours earlier** — and still in the replayed conversation, because the 20-turn
window that day spanned 4.5 days. A count cap cannot express "we stopped
talking". Bound is now a 6-hour session gap, not an absolute age, so a continuous
working session keeps its full history and "send it" still resolves.

**D8** — measured 2026-09-23: 674 of 1,398 journal lines in 24 hours (48%) were
composio-core's upgrade nag, every ~2 minutes. Excluded by default from
`read_logs`, never banned — an explicit `grep` opts back in and the excluded
count is always reported in the note.

## Why

Seven of the eight are one failure shape: **a confident statement that no
instrument supports.** D1 and D8 make the instrument lie, D2 makes the receipt
lie, D4 lets the reply lie, D3 and D5 report working capabilities as broken, and
D6/D7 make the system act on something the founder did not ask for and report
success for it.

That shape is what blocks switching FounderOS on for everyday workflows. A bot
that fails loudly is usable. A bot that says "Healthy", prints "✓ 1 action
completed and verified" under a failure, and explains that work is "currently
actively executing" when nothing is running, is worse than no bot — the founder
cannot tell which of its statements to act on, so he has to check all of them,
which is the work the product exists to remove.

Two architectural notes:

- **The fix went to the choke point, not the call sites.** D2 touches one
  function instead of 58 wrappers, because the detector was the thing that was
  wrong and a wrapper-by-wrapper fix leaves every future wrapper free to regress.
- **Failure direction was chosen deliberately in D7.** After a 6-hour gap the bot
  asks what "it" refers to (loud, cheap) rather than inventing an action from
  stale context (silent, mutates founder state).

## Metrics

| | Before | After |
|---|---|---|
| `pnpm gate` | exit 0 | **exit 0** |
| Test files | 401 | 408 |
| Tests | 4482 | **4554** (+72) |
| `loc-budget` violations | 6 (baseline) | 6 (baseline — held by extracting 2 modules) |
| Real-window `read_logs` on 2026-09-22 19:25→20:25 | 0 errors, 1 warning, `truncated:false` | **0 errors, 5 warnings, `truncated:true`, 16 withheld named** |
| Journal lines that are third-party nag | 48% | excluded from the default window, count reported |

Two modules were extracted to hold the LOC ratchet at its baseline rather than
raise it: `src/kernel/tool-failure.ts` (failure classification) and
`src/tools/claude-code-cwd.ts` (executor workspace resolution). Both are pure
moves — every symbol is still re-exported from its original module, so no
importer changed.

### Verification status

- **VERIFIED** — `pnpm gate` exit 0, run fresh in this session, output above.
- **VERIFIED** — D1 replayed against the real production journal window that
  produced the "Healthy" reply; before/after numbers in the table.
- **VERIFIED** — D2 asserted end-to-end through the real kernel graph
  (`kernel-e2e.test.ts`): a tool failing in prose yields `ok:false` and no
  "action completed and verified" line.
- **NOT VERIFIED — no Telegram tester session.** Rule #36 real-path verification
  (Telegram → kernel → tool → reply → DB row) could not run:
  `TELEGRAM_TESTER_SESSION` is unset and the login is interactive and
  founder-only. Nothing here was driven through the real transport. The kernel
  E2E runs the real StateGraph, checkpointer, interrupt/resume, receipts and
  validation with scripted models at the provider boundary — which is a stronger
  seam than tool-level `.execute()`, and still not the transport.

## Outstanding

1. **Google re-authorization (founder only).** 41 `invalid_grant` failures in 14
   days; Gmail and Calendar are dead in production. AG-014 classifies and alerts
   correctly — the token itself needs a human re-consent.
2. **`TELEGRAM_TESTER_SESSION` (founder only).** Blocks every rule-#36 real-path
   assertion, in this session and every future one. One interactive login:
   `pnpm tsx scripts/telegram-tester.ts login`.
3. **Deploy.** These fixes are on a branch; production still runs `09bd76b`,
   which contains all eight defects.
4. **Not fixed, low impact.** `remotive` returned `fetch failed` twice in 7 days
   and 567 results across 334 sweeps. The other three aggregator sources are
   healthy (arbeitnow 179,400 over the same window) — the single sweep showing
   three zeros was transient, not systemic. Recorded so it is not re-investigated
   as a defect.
