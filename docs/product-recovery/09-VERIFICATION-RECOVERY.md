# Verification, Observation & Recovery

## Current state — measured

### What exists and works

| Mechanism | Location | Status |
|---|---|---|
| `ToolReceipt` — code-recorded, not model-claimed | `src/kernel/tool-adapter.ts` | ✅ genuine |
| `validateStepResult` against `OUTPUT_CONTRACTS` | `src/kernel/contracts.ts` | ✅ genuine |
| `FailureReport` = stage + component + evidence + retryable | `contracts.ts` | ✅ genuine |
| One corrected retry per retryable failure | `src/kernel/supervisor.ts` | ✅ |
| Failure-lesson lookup on retry | `src/kernel/lessons.ts` | ✅ wired (2 rows) |
| HITL: DB row **before** `interrupt()`, side effect only after approval, idempotency key, audit row only on real success | `src/infra/hitl.ts`, `tool-adapter.ts` | ✅ genuinely enforced |

**This substrate is real and must be preserved.** It is what makes the rest cheap to add.

### What is missing

#### V1 — `VERIFIERS` covers 1 of 8 workers

`src/kernel/verify.ts` in full:

```ts
export const VERIFIERS: Record<string, StepVerifier> = {
  "comms": { /* regex: unresolved {{placeholders}} or [Recipient] */ }
};
```

`verifyStepResult` is correctly wired into `worker.ts` and correctly returns a typed
`stage: "validation"` failure. **The seam is built. It is empty.**

`admin`, `research`, `engineering`, `marketing`, `sales`, `personal`, `jobhunt` → no verification.

#### V2 — No observation distinct from action

Every tool returns a **result string**. None returns *what changed in the world*.

| Tool | Returns | Missing observation |
|---|---|---|
| `browser` click | stdout | did the page change? |
| `github_write` | success msg | does the commit exist on the remote? |
| `send_email` | provider ack | message-id present? |
| `claude_code` | agent output | do tests pass? |
| `write_artifact` | `"✅ Artifact written"` | does the file exist and is it non-empty? |

`write_artifact` is the sharpest case: it returns `✅` after `fs.writeFile` without a `stat`, into
a directory that does not exist on prod.

#### V3 — No mission-level completion check

`OUTPUT_CONTRACTS` validate a **step's shape**. Nothing asks *"does the final reply satisfy
`mission.goal`?"* This is the mechanism that let "Mission complete" ship with 3 of 39 rows as
chat text.

#### V4 — Recovery is one blind retry

Retryable → one retry, with a lesson if one exists. There is no:
- partial-success resume (steps 1–2 done, step 3 failed → whole mission fails)
- alternate-path fallback
- explicit "I got this far, here is what is blocked" reply shape

`src/gateway/mission-resume.ts` exists — Phase 4 must check whether it is wired before adding
anything.

#### V5 — Outcomes are never recorded

`writeTaskOutcome` (`src/db/queries.ts:528`): **zero production callers**.
`agents.agent_results`: **0 rows**.

The system cannot answer *"how often do I actually finish?"* — which is why the only quality
number available is a routing eval scoring 29%.

---

## Target — three additions, no new subsystem

### T1 — Fill the existing `VERIFIERS` map (Phase 4)

One verifier per worker. Cheap, pure, unit-testable. Examples:

| Worker | Verifier asserts |
|---|---|
| `jobhunt` | a record-returning step reports a **count**, and it is > 0 unless the step declared an empty result |
| `admin` | an artifact-producing step yields a path that **exists** and is non-empty |
| `engineering` | a code-change step reports a **command run** and its exit status |
| `research` | every factual claim carries a source URL from a receipt |
| `personal` | a file-send step reports bytes sent |
| `marketing` / `sales` / `comms` | keep + extend the placeholder check |

**No new abstraction — populate a map that already has a caller.**

### T2 — `ObservedResult` on consequential tools (Phase 4)

Extend the existing `ToolResult` envelope with an optional observation, populated by the executor,
never by the model:

```ts
observed?: {
  kind: "file" | "http" | "record" | "commit" | "message";
  evidence: string;   // path+size · status+url · count · sha · message-id
}
```

Start with the five tools that already fail silently: `write_artifact`, `send_file`,
`github_write`, `browser`, `claude_code`. Optional field, so nothing breaks.

### T3 — Mission-level completion gate (Phase 4)

One pure function in the synthesize path:

```
missionSatisfied(goal, steps, results) -> { ok } | { ok: false, unmet: string[] }
```

If unmet, the reply **must not** say complete. It states what was achieved and what is blocked.

The founder gets the truthful shape the thesis asked for:

> *"⚠️ 1 application needs your attention. Adyen's form changed and I couldn't complete the final
> step. I've preserved the session. Want me to continue?"*

### T4 — Record every outcome (Phase 11)

Call `writeTaskOutcome` from the terminal node. It exists, it is tested, it has no caller. One
line closes the self-improvement loop that Phase 11 depends on.

---

## Enforcement

Verification rules must not live in markdown. Add to `scripts/verify-architecture.ts` (Phase 8):

```
verifier-coverage: assert Object.keys(VERIFIERS) ⊇ WORKERS  → ratchet 0 missing
```

Per `CLAUDE.md` #27: a rule with no mechanism decays. This one gets a mechanism.
