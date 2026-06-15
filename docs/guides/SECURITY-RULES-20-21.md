# Security Rules 20-21: Context Isolation & Typed Handoffs

These two rules operationalize the multi-agent hardening (Phases 1-6).

---

## Rule #20: Context Isolation

**What it prevents:** Dept A seeing Dept B's internal tool calls, supervisor seeing raw tool results.

### Implementation

**Code:** `src/agents/office.ts:142`
```typescript
return createSupervisor({
  agents: [research, comms, engineering, marketing, sales, personal, jobhunt],
  llm,
  prompt: createTrimmedPrompt(buildSupervisorPrompt(), supervisorBudget) as any,
  tools: SUPERVISOR_TOOLS,
  outputMode: "last_message",  // ← CRITICAL
  includeAgentName: "inline",
}).compile({ checkpointer });
```

### How to Verify

1. **Check office.ts has `outputMode: "last_message"` pinned:**
   ```bash
   grep -n 'outputMode:' src/agents/office.ts | grep 'last_message'
   ```

2. **Run context isolation tests:**
   ```bash
   pnpm test -- tests/unit/infra/office-guard.test.ts
   ```

3. **Monitor trace logs:**
   ```bash
   TRACE_ENABLED=1 pnpm start
   grep "seam:supervisor" /tmp/founderos.log
   # Should see: turn.in → route.decided → dept.invoke → turn.out (clean boundary)
   # Should NOT see: supervisor.invoke containing tool_use
   ```

### Failure Symptoms

- Supervisor history contains `tool_use` or `tool_result` messages
- Departments see each other's reasoning
- Token budget explodes (trimmed history balloons)

### Audit Checklist

- [ ] `outputMode` pinned to `"last_message"`
- [ ] office-guard tests pass
- [ ] Trace logs show clean seams (no tool leakage)
- [ ] Per-turn token measurement shows stable prefix (implicit caching working)

---

## Rule #21: Typed Inter-Department Handoffs

**What it prevents:** Malformed signal payloads crashing workflows silently.

### Implementation

**Code:** `src/agents/contracts.ts`
```typescript
export const SIGNAL_CONTRACTS = {
  lead_discovered: z.object({...}),
  proposal_approved: z.object({...}),
  demo_ready: z.object({...}),
};

export function validateSignalPayload(eventType: string, payload: unknown) {
  const schema = SIGNAL_CONTRACTS[eventType];
  const result = schema.safeParse(payload);
  return { valid: result.success, errors: ... };
}
```

**Code:** `src/agents/agent-tools/signals.ts`
```typescript
export async function publish_signal(payload: {...}) {
  const validation = validateSignalPayload(payload.event_type, payload);
  if (!validation.valid) {
    return { success: false, error: ... };
  }
  await db.insert(deptSignals).values({...});
  return { success: true, signal_id: ... };
}
```

### How to Verify

1. **Check contracts registry exists:**
   ```bash
   grep -A 20 "export const SIGNAL_CONTRACTS" src/agents/contracts.ts
   ```

2. **Verify validation is called before DB write:**
   ```bash
   grep -B 3 -A 3 "validateSignalPayload" src/agents/agent-tools/signals.ts
   # Should show: validate → if (!valid) return error → else db.insert
   ```

3. **Run contract tests:**
   ```bash
   pnpm test -- tests/unit/agents/contracts.test.ts
   # Should pass: happy path, validation, parity, malformed payloads
   ```

### Failure Symptoms

- `publish_signal` rejects valid-looking payloads (schema mismatch)
- `sweepDeptSignals` silently skips malformed signals (check logs)
- New signal types added but schema not updated (parity test fails)

### Adding a Signal Type

1. Add Zod schema to `SIGNAL_CONTRACTS` in contracts.ts
2. Update parity test: add `expect(contractKeys).toContain("new_type")`
3. Run tests (parity enforced)
4. Call `publish_signal("new_type", {...})`

### Audit Checklist

- [ ] `SIGNAL_CONTRACTS` has schemas for all 3 event types
- [ ] `validateSignalPayload` called before any DB write
- [ ] Contracts tests pass (parity + validation)
- [ ] Per-signal validation logs visible in production
- [ ] No schema versioning issues (all signals use current schema)

---

## Monitoring Both Rules

### Logs to Watch

```bash
# Context isolation seams
grep "seam:" /tmp/founderos.log | grep "supervisor\|dept"

# Signal validation
grep "validateSignalPayload" /tmp/founderos.log | grep "failed"

# Token measurement (implicit caching)
grep "budgetTracker\|inputTokens\|outputTokens" /tmp/founderos.log
```

### Queries to Run

```sql
-- Context isolation working? (supervisor not seeing tool calls)
SELECT COUNT(*) FROM turn WHERE dept_name = 'supervisor' AND message_contains_tool_call = true;
-- Should be 0 or very low (supervisor only sees final results)

-- Signals validating? (malformed signals caught before DB)
SELECT COUNT(*) FROM dept_signals WHERE validation_failed = true;
-- Low count = good (bad signals rejected upfront)

-- Token budget tracked?
SELECT SUM(model_cost) FROM turn GROUP BY dept_name;
-- Should show breakdown by dept, total reasonable
```

### Alerts to Set

- **Context leakage detected:** If supervisor message history ever contains tool_use, alert
- **Signal validation failures spike:** If > 5 failures in 1 hour, alert
- **Token budget exceeded:** If daily cost > COST_LIMIT, alert

---

## References

- **Phase 1 (Context Isolation):** [PHASE-1-CONTEXT-ISOLATION.md](../phases/PHASE-1-CONTEXT-ISOLATION.md)
- **Phase 2 (Typed Contracts):** [PHASE-2-TYPED-CONTRACTS.md](../phases/PHASE-2-TYPED-CONTRACTS.md)
- **Implementation details:** [PHASE-HARDENING-GUIDE.md](PHASE-HARDENING-GUIDE.md)
- **Signal usage:** [SIGNALS-AND-CONTRACTS.md](SIGNALS-AND-CONTRACTS.md)
