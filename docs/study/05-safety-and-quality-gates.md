# Safety & Quality Gates

*All the mechanisms that prevent FounderOS from doing the wrong thing: sending twice,
fabricating facts, leaking secrets, blowing the budget, or writing outside the home
directory. Read this alongside `src/infra/` and `src/gateway/execution-guard.ts`.*

---

## The Three-Layer Quality Gate for Outbound Copy

Every outbound send (`send_email`, `linkedin_post`) passes through three gates in sequence:

```
Draft text
   │
   ▼ Gate 1 — Brand Validator (deterministic, always runs)
   │   src/infra/brand-validator.ts
   │   Checks: banned phrases, word-count limits, required disclosures
   │   Fail: logs + triggers re-draft (capped at BRAND_MAX_RETRIES)
   │
   ▼ Gate 2 — Claude Judge (fail-open, only when ANTHROPIC_API_KEY set)
   │   src/infra/judge.ts
   │   Model: Claude (different family from Gemini drafter → no sycophancy)
   │   Verdict: { verdict: "pass" } | { verdict: "revise", critique: "..." }
   │   Fail-open: any error → pass (HITL is the real gate)
   │
   ▼ Gate 3 — HITL (always, mandatory for all outbound sends)
       LangGraph interrupt()
       Approval card shown in Telegram with critique (if Gate 2 flagged)
       Founder taps Approve / Reject
       Only on Approve → actual send happens
```

**The key insight:** Gates 1 and 2 are advisory. Gate 3 is mandatory. The human is always
the final decision-maker for external side effects.

---

## Anti-Hallucination Execution Guard (ADR-032)

### The Problem

Production exhibited the most damaging failure: the agent answered internal-knowledge
questions from its own weights instead of calling memory tools. Root cause:

1. **Wrong model.** A weaker model skips tool calls.
2. **No structural guard.** The anti-fabricate sentinels inside tools only fire if the
   tool is *called*. Skip the call, skip the guard.

A model swap should never be one config change away from this failure class.

### The Fix: Deterministic Execution Guard

`src/gateway/execution-guard.ts` — a pure, unit-tested function:

```typescript
export function detectUnbackedMemoryClaim(
  messages: BaseMessage[],
  toolsUsedThisTurn: string[],
): boolean {
  const lastHuman = findLastHumanMessage(messages);
  if (!lastHuman) return false;

  // Matches: "what did we decide about", "turicks strategy", "naggar retreat",
  //          "our ICP", "founder context", etc.
  if (!INTERNAL_KNOWLEDGE_RE.test(lastHuman.content as string)) return false;

  // Exclude explicit web/research requests — those legitimately skip memory
  if (EXTERNAL_RESEARCH_RE.test(lastHuman.content as string)) return false;

  // No memory tools fired? → guard triggers
  const MEMORY_TOOLS = ["read_context", "search_memory", "search_knowledge", "search_turicks_brain"];
  return !toolsUsedThisTurn.some((t) => MEMORY_TOOLS.includes(t));
}
```

When triggered, the gateway forces a retry with an explicit directive:

```typescript
if (detectUnbackedMemoryClaim(messages, toolsUsed)) {
  const retryMessages = buildGuardRetryMessages(messages, "memory");
  return office.invoke({ messages: retryMessages }, config);
}
```

**Why deterministic?** The guard is pure regex + array membership — it doesn't call an LLM
to decide whether to call an LLM. Even a weak model that skips tools is forced onto the
memory path by the gateway's retry.

---

## Tool Failure Envelope (ADR-032)

### The Problem

Tool failures were reported as:
- `"✅ Done."` — success message hiding an underlying DB failure
- `"Ollama unavailable"` — wrong component named (it was a Postgres issue)
- Raw JS exceptions — crashing the tool instead of a recoverable result

### The Fix: `src/agents/tool-result.ts`

```typescript
// Structured failure with a stage tag
export function toolFailure(stage: string, message: string): string {
  return `❌ ${message}\n[[TOOL_FAILURE stage=${stage}]]`;
}

// Deterministic detection (marker-first, then legacy formats)
export function isToolFailure(result: string): boolean {
  if (result.includes("[[TOOL_FAILURE")) return true;        // stable marker
  if (result.includes('"success":false')) return true;       // legacy JSON format
  if (/^(❌|Error:|Failed:)/.test(result.trim())) return true; // keyword fallback
  return false;
}
```

The `stage` parameter names the **real** failing component:

```typescript
// In context.ts DB tools:
try {
  const row = await db.query.context.findFirst({ ... });
  return row?.value ?? null;
} catch (err) {
  return toolFailure("db", `Postgres query failed: ${err.message}`);
  //                  ^^^  → "db" not "Ollama", not "agent", not "unknown"
}
```

**Why it matters:** A misattributed error is worse than no error — it sends debugging down
the wrong road. Rule #22: "an embedding failure says Ollama; a DB failure says Postgres."

---

## Idempotency (No Double-Sends)

Every outbound send checks an audit log before executing:

```typescript
// In send_email (and linkedin_post, github_write, etc.):
const idempKey = idemKey("send_email", to, subject, body);

if (await hasBeenAudited(idempKey)) {
  return "✅ Already sent (idempotency check) — skipped.";
}

// ... actual send ...

await writeAuditEntry({
  action: "send_email",
  idempotency_key: idempKey,
  payload: { to, subject },
});
```

`idemKey()` is deterministic: same content → same key. Even if the graph `invoke()` is
called twice (network retry, duplicate Telegram event), the email sends exactly once.

**The rule:** idempotency check before EVERY external action. No exceptions. This is enforced
by the wiring maps in `docs/rules/PROGRAMMING-RULES.md`.

---

## Suppression List (GDPR/CAN-SPAM)

Before any outbound email, the `send_email` tool checks the `do_not_contact` Postgres table:

```typescript
if (await isSuppressed(TENANT, to)) {
  return `BLOCKED: ${to} is on the do-not-contact list.`;
}
```

This runs *after* `interrupt()` approval (so the founder can still see the draft) but *before*
the actual send. Adding a contact to the suppression list via `/suppress` command guarantees
no future email reaches them, even if the founder accidentally approves.

---

## Budget Guard

`src/infra/budget.ts` — two caps:

| Cap | Default | Env var |
|-----|---------|---------|
| Per-run | $0.50 | `BUDGET_PER_RUN_USD` |
| Daily | $5.00 | `BUDGET_DAILY_USD` |

The budget callback is injected into every `office.invoke()` call. When a cap is hit, the
current run fails with a clear error message — the graph does not continue.

**Note:** This is separate from Gemini's implicit caching (which reduces input token cost).
The budget guard caps total spend regardless of caching.

---

## Path Guard (Personal Department)

The `personal` department can read/write/execute on the founder's machine. Without a guard,
a confused model could read `~/.ssh/`, `~/.env`, or write to system directories.

`src/infra/path-guard.ts` — three rules enforced before every personal tool call:

```typescript
export function assertPathSafe(inputPath: string): void {
  const resolved = path.resolve(inputPath);
  const home = process.env["HOME"] ?? "/home/user";

  // Rule 1: Must stay under $HOME
  if (!resolved.startsWith(home)) {
    throw new PathGuardError(`Path outside home directory: ${resolved}`);
  }

  // Rule 2: Blocked secret patterns (regardless of location)
  const BLOCKED_PATTERNS = [/.ssh/, /.gnupg/, /\.env$/, /id_rsa/, /id_ed25519/, /\.pem$/];
  if (BLOCKED_PATTERNS.some((p) => p.test(resolved))) {
    throw new PathGuardError(`Blocked path (secrets): ${resolved}`);
  }

  // Rule 3: Blocked directories
  const BLOCKED_DIRS = ["/etc", "/usr", "/var", "/sys", "/proc", "/dev"];
  if (BLOCKED_DIRS.some((d) => resolved.startsWith(d))) {
    throw new PathGuardError(`Blocked system directory: ${resolved}`);
  }
}
```

All personal tools call `assertPathSafe()` before executing. The guard throws — the error
surfaces as a ToolMessage to the agent ("path blocked"), which reports back to the founder.

**ADR-013:** `personal` and `engineering` are separate departments specifically to enforce
least-privilege. Engineering tools have no path access; personal tools have no GitHub access.

---

## Single-Instance Lock

`src/infra/single-instance.ts` — PID file lock prevents duplicate bot processes:

```
On start: write PID to /tmp/founderos.pid
          if file exists with alive PID → crash with clear error
On exit:  delete the PID file
```

**Why this matters:** Two running bot instances both receive the same Telegram update, both
invoke the same thread, both try to call `interrupt()`. The LangGraph state gets corrupted.
The PID lock makes this structurally impossible.

---

## History Window

`src/infra/history-window.ts` — bounds the message history per thread to 12 human turns.
Beyond this, the oldest messages are dropped.

**Why 12?** Lab testing showed routing quality degrades past ~20 messages as the context
grows stale. 12 human turns ≈ a natural conversation boundary. Older context is available
in Postgres (turicks-brain, episodic memory) if explicitly needed.

**Why not trim at the checkpointer level?** Checkpointer trimming mutates persisted state —
a dangerous, hard-to-recover operation. History trimming happens at read time (before
`invoke()`), leaving the stored state intact.

---

## Summary: Safety Stack

```
External Request
       │
       ▼
[History window]          — prevents stale context loops
       │
       ▼
[Execution guard]         — forces memory tools on internal-knowledge questions
       │
       ▼
[HITL interrupt()]        — mandatory approval for all writes/sends
       │
       ▼
[Idempotency check]       — prevents double-sends even on retry
       │
       ▼
[Brand validator]         — Gate 1: banned phrases, word-count
       │
       ▼
[Claude judge]            — Gate 2: different model, fail-open critique
       │
       ▼
[Suppression check]       — GDPR: do-not-contact list
       │
       ▼
[Path guard]              — personal dept: home-dir confinement
       │
       ▼
[Budget guard]            — per-run + daily cost cap
       │
       ▼
Actual external action
       │
       ▼
[Audit log write]         — idempotency key persisted in action_log
```

Each layer is independent, deterministic, and unit-tested. Failure in one layer surfaces
to the founder as a clear, stage-tagged error message — never a swallowed exception or a
silent success.

---

*See also: [PRODUCTION.md](../PRODUCTION.md) for how these guardrails run on the live VPS, and
[LIMITATIONS.md](../LIMITATIONS.md) for the ones that are still open.*
