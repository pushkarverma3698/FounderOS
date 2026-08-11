# Execution Audit

## The canonical trace

**Prod turn `a194c5e5-237a-4c49-a24c-e4d852b482c6`, 2026-08-08T05:23:32Z.**
Source: `journalctl -u founderos.service`. Every line below is quoted from the running system.

### Input

```
what all jobs has been captured give me a csv.
```

### Timeline

| t+ | Seam | Event |
|---:|---|---|
| 0.02s | `turn.in` | received |
| 1.60s | `turn.progress` | `🔧 jobhunt: List all jobs currently captured in the job pipeline/databa…` |
| 2.12s | `tool.call` | `job_brief {"skip_liveness":false}` |
| 11.97s | `tool.result` | `🎯 JOB BRIEF · 2026-08-08 / 6 to apply to today · 1 worth a stretch · 19 one question away / 35 screened…` |
| 13.54s | `turn.progress` | `🔧 admin: Format the retrieved job data into a CSV string.` |
| 14.81s | `turn.progress` | `✍️ Writing your reply…` |
| 15.82s | `turn.out` | `Mission complete. Here is the CSV data for the captured jobs:\n\ncompany,role,status\nAdyen,…\ngitlab,…\nApiux Tech,Desa…` |

15.8 seconds, 8 LLM calls, 1 tool call.

### Link-by-link verdict

| Link | Verdict | Detail |
|---|---|---|
| **INTENT** | ✅ | "all captured jobs" + "CSV" both parsed |
| **OBJECTIVE** | ✅ | goal normalised correctly |
| **PLAN** | ✅ | 2 steps, right shape, right workers. **The planner was not the problem.** |
| **CAPABILITY** | 🚫 | jobhunt has no tool that reads `job_applications`. Nothing to route to. |
| **TOOL** | ⚠️ | worker substituted `job_brief` — the nearest-sounding tool. Returns *ranked prose*, not records. |
| **EXTERNAL** | ✅ | brief built, liveness checked (9.8s) |
| **OBSERVATION** | ❌ | nothing counted the rows returned or compared them to what exists |
| **VERIFICATION** | ❌ | `VERIFIERS["jobhunt"]` undefined → `verifyStepResult` returns unchanged |
| **ARTIFACT** | ❌ | no file written. `/opt/founderos/artifacts` does not exist. |
| **DELIVERY** | ❌ | CSV as inline chat text |
| **COMPLETION CLAIM** | ❌ | **"Mission complete."** |

### The gap between claim and reality

| | Claimed | Actual |
|---|---|---|
| Scope | "the captured jobs" | 39 rows exist; brief covered 35 screened; reply named ~3 |
| Format | "CSV data" | 3 columns (`company,role,status`) of ~40 available |
| Delivery | implied artifact | chat text |
| Status | "Mission complete" | objective not met |

**This is a false success, produced by a correct plan.** No amount of prompt tuning fixes it. Two
things were missing: a tool to read the data, and a check that the answer matched the ask.

---

## Why the chain broke — three structural causes

### C1 — No Tier-0 read of the system's own structured state

The single highest-leverage gap in FounderOS. Every "what is the state of X" question hits it:
jobs, applications, schedules, costs, approvals. The data is in Postgres with good schemas. No
worker can query it.

The worker did the only thing available: pick the nearest-sounding tool. **A missing capability
degrades into a plausible wrong one, silently.**

### C2 — No artifact create → deliver path

Two tools exist and cannot compose:

| | `write_artifact` | `send_file` |
|---|---|---|
| Worker | admin | personal |
| Root | `./artifacts` → `/opt/founderos/artifacts` (**absent**) | `personalRoot()` = `/home/founderos` |
| Format | hardcoded `.md` | any |

Different workers, non-intersecting filesystem roots, wrong extension. Even a perfect plan cannot
join them.

### C3 — "Mission complete" is emitted by structure, not by evidence

`kernelReply()` returns `state.reply`; the synthesizer writes it from step results. The system has
`validateStepResult` and `OUTPUT_CONTRACTS` — a **step** must match its declared `schema_ref`.
Nothing checks that the **mission** met the founder's goal.

Contract-level validation is present. Objective-level validation is absent. That distinction is
the whole product gap.

---

## Generalisation — the same three causes elsewhere

| Request | C1 | C2 | C3 |
|---|:--:|:--:|:--:|
| "what jobs have been captured, CSV" | ● | ● | ● |
| "which applications are waiting on me" | ● | | ● |
| "what did this cost last week" | ● | | ● |
| "export my contacts" | ● | ● | ● |
| "did the deploy work" | ● | | ● |
| "post this to LinkedIn" | | | ● |
| "open this site and check it's up" | | | ● |

**C1 and C3 dominate.** They are Phases 2 and 4.

---

## The second execution failure — autonomous, not conversational

The job lane (`03-CAPABILITY-MAP.md` §3) fails differently and worse: it runs **48 times a day**,
reports 285 boards and 20,550 candidates, and screens **0**. It has produced 5 rows in 8 days.

The funnel counts that would expose it **are computed** — `filterCandidates` returns `notes[]`
with per-reason drop counts — and then **discarded** on quiet sweeps, because only the alert path
renders them.

> A system that computes the evidence of its own failure and throws it away is worse than one that
> never measured. Phase 1 does not fix the funnel — it makes the funnel **visible**, then fixes
> what the numbers name.
