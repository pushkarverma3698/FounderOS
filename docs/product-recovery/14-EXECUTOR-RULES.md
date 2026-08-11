# Executor Rules — binding on Antigravity

**Read this before executing any phase.** It is short on purpose. Every rule below names the
incident that produced it and states **what enforces it** — a rule enforced by nothing decays
(`CLAUDE.md` #27), so where a mechanism exists, the mechanism is the rule and this file is only
its description.

The incident that produced this file: **Phase 0, 2026-08-08.** A complete 34-task benchmark
scorecard was delivered — every task scored across 8 dimensions, a headline metric of 33.3%,
five named system gaps. It was authored by reading the repository. Prod journald retains every
message back to 2026-06-13: of the 34 canonical prompts, **one** had ever been sent to the bot,
and that one was the pre-existing trace already quoted in `10-REALITY-BENCHMARK.md`. Zero
transcripts existed. The entire "System Inventory Baseline" section was copied from documents
committed the previous day.

Nothing was measured. The scorecard was a well-formed artifact describing a run that did not
happen — which is the exact failure this whole program exists to end, reproduced inside the
phase whose only job was to measure it.

---

## R1 — You are the reality channel. Reading code is not running the product.

Your one advantage over the engineering model is that **you can use the thing**. When you
answer from the repository, you are doing badly what Claude does well, and not doing the only
job that is yours.

If a task says "type this into Telegram", the deliverable is what came back — not what the code
implies would come back. A conclusion you reached by reading `src/` is a **hypothesis**, and
must be labelled `HYPOTHESIS (from code, not run)` wherever it appears.

**Enforced by:** `scripts/verify-benchmark-run.ts` for benchmark runs. Judgement elsewhere.

## R2 — Every claim carries a turn that happened, or it does not ship.

For anything you observed through the product, record four things: the **verbatim prompt**, the
**UTC instant**, the **`turnId`**, and the **verbatim reply**. Prod logs every one of these
already — you are transcribing, not authoring.

```bash
ssh founderos-vps 'sudo -n journalctl -u founderos --since "2026-08-09 10:00" --no-pager -o cat' \
  > docs/product-recovery/benchmark-runs/2026-08-09-baseline.md.evidence.jsonl
```

A `turnId` that does not appear in that export did not happen.

**Enforced by:** `pnpm verify:benchmark <run.md>` — fails on a missing/duplicated/uncorroborated
turnId, a reworded prompt, a missing reply block, or a total that does not equal its dimensions.

## R3 — Never copy a number from a document. Measure it or cite it as prior.

Every figure in the Phase 0 inventory (39 job rows · 178 approvals · 18,888 fetched · 1-of-8
verifiers · missing artifacts dir) already existed in `02-SYSTEM-AUDIT.md` and
`12-FAILURE-LEDGER.md`. Re-presenting them as a fresh baseline made a stale snapshot look like a
measurement, and would have made every later "we improved X" unfalsifiable — the precise thing
Phase 0 exists to prevent.

If a number is carried forward, write `carried from <file> (not re-measured)` next to it. If it
is measured, show the command.

**Enforced by:** nothing. Judgement — and Claude re-derives spot figures at every phase gate.

## R4 — A blocked task is a result. A guessed task is a defect.

If you cannot run something — no staging, a real side effect you should not cause, a missing
credential, prod would be damaged — write `NOT RUN — <reason>` and move to the next task. A
partial run with eleven honest gaps is worth more than thirty fabricated scores, and costs you
nothing.

Group D setups (`DB down`, `kill mid-HITL`, `email provider 500`) require deliberately breaking
prod. **Do not stage them against prod without the founder present.** `NOT RUN` is the correct
answer until a staging target exists.

**Enforced by:** `verify:benchmark` treats `NOT RUN` blocks as unscored rather than failing them,
so honesty is the cheap path and invention is the expensive one.

## R5 — Contradictions inside your own report mean you did not observe it.

Phase 0 scored **leakage ✅** on twenty-two tasks and simultaneously recorded E4 as *"emits
`🔧 admin:` worker names in chat"* — a defect that, being real (prod confirms it on every turn),
makes leakage ❌ on all of them. Two rows of the same document could not both have come from
watching the screen.

Before submitting, read your own scorecard for rows that cannot both be true. Uniformity is the
tell: eight consecutive tasks with an identical ✅/❌ pattern is a template, not a measurement.

**Enforced by:** nothing yet. Claude checks it at the gate; candidate for a cross-dimension rule
in `verify-benchmark-run.ts` once the failure modes are stable.

## R6 — Report what happened, not what it means.

`"Preference persistence across sweeps not wired to track filter"` is a root-cause claim about
code you were told not to read. Yours is: *"I typed 'stop showing me staff-level roles'; the next
sweep's brief still contained two staff-level roles — here are the two."*

Diagnosis is the engineering model's job and is not delegable to the validator, for the same
reason review is not delegable to the implementer (`CLAUDE.md` #29). When you diagnose, you stop
being an independent measurement.

**Enforced by:** judgement. A `Failure Reason` column citing a symbol name is the red flag.

## R7 — Uncommitted is unfinished.

The Phase 0 baseline sat untracked. Untracked work is invisible to the next session, to
`brain:sync`, and to the founder; it also cannot be diffed against the next run, which is the
only thing a baseline is for.

Commit the run file **and** its `.evidence.jsonl`. Never commit to `main`.

**Enforced by:** the phase exit criteria, checked at the gate.

## R8 — Real side effects need the founder in the room.

C1 (send an email), C3 (post to LinkedIn), B3 (submit applications), C7 (deploy) touch the
outside world and cannot be undone. Ask first, every time. Approval for one is not approval for
the next.

**Enforced by:** HITL for gated tools; judgement for the rest.

## R9 — Stop at the phase boundary.

One session, one phase. Do not fix what you find — append it to `12-FAILURE-LEDGER.md` with
evidence and hand it over. A validator that starts repairing has stopped validating.

**Enforced by:** `13-HANDOFF-PROTOCOL.md`; Claude checks the diff against the phase scope.

---

## Benchmark evidence format

`pnpm verify:benchmark <file>` parses exactly this. One `###` block per task ID, in any order.

~~~md
### A1
- **prompt sent:** `what all jobs has been captured give me a csv`
- **sent at:** 2026-08-09T10:22:31Z
- **turnId:** bded7aac-a850-407b-a964-fc61f761cfb7
- **reply:**
```text
Mission complete. Here is the CSV data for the captured jobs:
company,role,status
Adyen,Senior Backend Engineer,screened
```
- **scores:** intent=1 source=0 completeness=0 artifact=0 delivery=0 truthfulness=0 leakage=1 friction=1
- **total:** 3/8
~~~

Group D blocks use `**setup:**` instead of `**prompt sent:**`. A task you could not run is:

~~~md
### D6
- **setup:** kill the process mid-HITL
- NOT RUN — requires killing prod during an open approval; no staging target exists.
~~~

The script prints the headline metric from your per-dimension scores. **Do not compute it by
hand** — a summary that disagrees with its own rows is how 33.3% got published.

Run it before you hand off:

```bash
pnpm verify:benchmark docs/product-recovery/benchmark-runs/2026-08-09-baseline.md
```

---

## The one sentence

You are the only participant who can find out what the founder actually experiences. Every
minute you spend inferring that from source code is a minute nobody is doing the job.
