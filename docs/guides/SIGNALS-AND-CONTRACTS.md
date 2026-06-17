# Signals & Contracts Guide

**Overview:** Departments communicate via typed events (signals) persisted durably to Postgres. This guide explains what signals are, current types, how to use them, and how to add new ones.

---

## What Are Department Signals?

**Signals** are **durable, typed, async inter-department messages**.

Instead of:
- Synchronously calling another department (blocks until response)
- Dumping raw text to a Telegram channel (unstructured, unvalidated)

Departments now:
- Publish a **typed signal** (e.g., `lead_discovered`) with a schema-validated payload
- Signal is **persisted to the `dept_signals` table** immediately (durable)
- **Hourly cron** sweeps the table, validates all signals, and surfaces them to Telegram
- **Founder decides action** (reply, edit, forward, or dismiss)

**Key property:** Signals **surface work; they don't execute actions automatically**. The founder retains decision authority.

---

## Current Signal Types (Registry)

All signal types are defined in `src/agents/contracts.ts` using Zod schemas:

```typescript
export const SIGNAL_CONTRACTS = {
  lead_discovered: z.object({
    context: z.string()
      .describe("Brief context: who (company), what (product fit), why (ICP match)"),
    prompt: z.string()
      .describe("Follow-up action supervisor should take (e.g., 'Draft outreach email')"),
    payload: z.record(z.any()).optional()
      .describe("Optional details: { company_name, founder_name, website, fit_score }"),
  }),

  proposal_approved: z.object({
    context: z.string()
      .describe("What was approved (e.g., 'Acme Corp cinematic-web proposal')"),
    prompt: z.string()
      .describe("Next action (e.g., 'Send contract, schedule kickoff call')"),
    payload: z.record(z.any()).optional()
      .describe("Deal details: { deal_id, amount, contract_link, timeline }"),
  }),

  demo_ready: z.object({
    context: z.string()
      .describe("What demo is ready"),
    prompt: z.string()
      .describe("Action: schedule, demo, or publish"),
    payload: z.record(z.any()).optional()
      .describe("Demo details: { feature_name, status, screenshot_link }"),
  }),
};
```

### Three Current Event Types

| Signal | Published By | Default Target | Payload Example |
|--------|------------|----------------|-----------------|
| **lead_discovered** | research | sales | `{ company, icpScore, source, notes? }` |
| **proposal_approved** | sales | engineering | `{ company, proposalId, amountUsd }` |
| **demo_ready** | engineering | sales | `{ company, repoUrl }` |
| **design_brief_ready** | marketing | engineering | `{ client, preset, copyBlocks, mood? }` |
| **site_deployed** | engineering | sales | `{ client, siteUrl, repoUrl?, presetUsed? }` |

*Web design service flow (ADR-032): marketing → `design_brief_ready` → engineering → `site_deployed` → sales Proof Drop.*

---

## How to Publish a Signal

### From a Department Agent

```typescript
// In src/agents/agent-tools/{dept}.ts or within a ReAct agent
const result = await publish_signal({
  event_type: "lead_discovered",         // Must match registry key
  context: "Acme Corp (Series B, $10M ARR)",  // Situational context
  prompt: "Strong fit for cinematic-web. Recommend: draft outreach.",  // Next action
  payload: {                             // Optional details
    company_name: "Acme Corp",
    founder_name: "Jane Doe",
    website: "acme.com",
    fit_score: 0.92,
    industry: "SaaS",
  },
});

if (!result.success) {
  log.error("Signal publish failed", { error: result.error });
  return { error: `Could not publish signal: ${result.error}` };
}

log.info("Lead signal published", { signal_id: result.signal_id });
return { status: "Lead discovered and surfaced to founder" };
```

### What Gets Logged

Signal is written to `dept_signals` table immediately:
```sql
INSERT INTO dept_signals (event_type, payload, published_at, consumed)
VALUES (
  'lead_discovered',
  '{"context":"Acme Corp...","prompt":"Draft outreach...","payload":{...}}',
  NOW(),
  false
);
```

### Return Value

```typescript
{
  success: true,
  signal_id: "550e8400-e29b-41d4-a716-446655440000"
}

// OR on error:
{
  success: false,
  error: "Validation failed: payload.fit_score must be a number"
}
```

---

## How Signals Are Consumed (Hourly Sweep)

### Automatic Process (Runs at 6:01 AM and 6:01 PM)

```typescript
// src/infra/scheduler.ts
async function sweepDeptSignals() {
  // 1. Get all unconsumed signals
  const signals = await db.query.deptSignals.findMany({
    where: eq(deptSignals.consumed, false),
  });

  for (const signal of signals) {
    try {
      // 2. Validate signal (defense in depth)
      const validation = validateSignalPayload(signal.event_type, signal.payload);
      if (!validation.valid) {
        log.warn("Signal validation failed", { errors: validation.errors });
        // Mark as consumed (don't retry bad signals forever)
        await db.update(deptSignals)
          .set({ consumed: true, consumed_at: new Date() })
          .where(eq(deptSignals.id, signal.id));
        continue;
      }

      // 3. Surface to Telegram (founder sees notification)
      await sendSignalToTelegram({
        event_type: signal.event_type,
        context: signal.payload.context,
        prompt: signal.payload.prompt,
        details: signal.payload.payload,
      });

      // 4. Mark as consumed (atomic: only after Telegram succeeds)
      await db.update(deptSignals)
        .set({ consumed: true, consumed_at: new Date() })
        .where(eq(deptSignals.id, signal.id));

    } catch (error) {
      log.error("Sweep error", { signal_id: signal.id, error });
      // Retry on next sweep (within 12 hours)
    }
  }
}

scheduler.add("sweep_dept_signals", "1 6,18 * * *", sweepDeptSignals);
```

### What Founder Sees (Telegram)

```
🔔 Signal: lead_discovered

Acme Corp (Series B, $10M ARR)

Strong fit for cinematic-web. Recommend: draft outreach.

📊 Details:
company_name: Acme Corp
founder_name: Jane Doe
website: acme.com
fit_score: 0.92

[Take Action] [Archive] [View Raw]
```

### Founder Actions

- **Take Action**: Supervisor receives signal as context, routes to appropriate department (e.g., "Sales, draft outreach email based on this lead")
- **Archive**: Marks consumed (acknowledged, no action)
- **View Raw**: Shows full JSON payload (for debugging)

---

## How to Add a New Signal Type

**When:** Your department wants to publish a new kind of work signal.  
**Example:** Marketing wants to publish `content_scheduled` when scheduling a blog post.

### Step 1: Define Zod Schema in contracts.ts

```typescript
// src/agents/contracts.ts
export const SIGNAL_CONTRACTS = {
  // ... existing types ...
  
  content_scheduled: z.object({
    context: z.string()
      .describe("What content and where (e.g., 'Blog post: FounderOS for CTOs')"),
    prompt: z.string()
      .describe("What to do next (e.g., 'Promote on Twitter, LinkedIn')"),
    payload: z.object({
      content_title: z.string(),
      platform: z.enum(["blog", "twitter", "linkedin", "email"]),
      published_at: z.string().datetime(),
      url: z.string().url(),
    }).optional(),
  }),
};
```

### Step 2: Update Registry Parity Test

```typescript
// tests/unit/agents/contracts.parity.test.ts
test("SIGNAL_CONTRACTS keys match expected event types", async () => {
  const contractKeys = Object.keys(SIGNAL_CONTRACTS);
  
  // When you add a new type, add it here
  expect(contractKeys).toContain("lead_discovered");
  expect(contractKeys).toContain("proposal_approved");
  expect(contractKeys).toContain("demo_ready");
  expect(contractKeys).toContain("content_scheduled"); // ← ADD THIS
  
  // Ensures schema parity (test will fail if schema missing)
});
```

### Step 3: Update Signal Processing (optional)

If your new signal needs custom handling in the sweep, add logic:

```typescript
// src/infra/scheduler.ts
async function sweepDeptSignals() {
  // ... existing logic ...
  
  // Custom handling for content_scheduled
  if (signal.event_type === "content_scheduled") {
    const payload = signal.payload as any;
    if (payload.platform === "twitter") {
      await postToTwitter(payload.url, payload.content_title);
    }
  }
}
```

### Step 4: Call publish_signal with Matching Payload

```typescript
// In marketing department agent
const result = await publish_signal({
  event_type: "content_scheduled",
  context: "Blog post: FounderOS for CTOs published",
  prompt: "Promote on Twitter and LinkedIn",
  payload: {
    content_title: "FounderOS for CTOs",
    platform: "blog",
    published_at: new Date().toISOString(),
    url: "https://blog.founderos.ai/ctos",
  },
});
```

### Step 5: Document in This Guide

Update the "Current Signal Types" table above with the new signal.

**Done!** Tests enforce parity, so if you forget to add a schema, tests fail. ✅

---

## Error Handling & Edge Cases

### Signal Validation Fails

```typescript
// If payload doesn't match schema, publish_signal returns error:
{
  success: false,
  error: "Validation failed: payload.fit_score must be a number"
}
```

**Department should:**
- Log the error
- Return an error message to the founder (via Telegram)
- Not try to republish (bad data will fail validation again)

### Sweep Fails Silently (Telegram Unreachable)

```typescript
// If sendSignalToTelegram() throws:
} catch (error) {
  log.error("Sweep error", { signal_id, error });
  // Retried on next sweep (6:01 AM / 6:01 PM) — no message lost
}
```

**Safety:** Consumed is not marked true, so signal retries until successfully surfaced.

### Malformed Signal in Database (Poison Pill)

```typescript
// If validation fails during sweep:
if (!validation.valid) {
  log.warn("Signal validation failed", { errors });
  // Mark as consumed anyway (don't retry forever)
  await db.update(deptSignals).set({ consumed: true }).where(...);
  continue;
}
```

**Why:** Prevents bad signals from looping infinitely. Logged for debugging.

---

## Monitoring Signals

### Query Unprocessed Signals

```sql
SELECT id, event_type, published_at, payload
FROM dept_signals
WHERE consumed = false
ORDER BY published_at DESC;
```

If > 0 signals and oldest > 12 hours, sweep might be stalled. Check:
- Postgres connection (is `founderos` DB up?)
- Cron job running (check systemd timer)
- Telegram API (is bot token valid?)

### Manual Sweep (if needed)

```bash
# Trigger sweep without waiting for cron
curl -X POST http://localhost:3000/api/internal/sweep-signals

# Or from code:
await sweepDeptSignals();
```

### Signal Metrics

```sql
-- Signals published today
SELECT COUNT(*) FROM dept_signals WHERE published_at > NOW() - INTERVAL '1 day';

-- Signals by type (for product insights)
SELECT event_type, COUNT(*) FROM dept_signals
GROUP BY event_type ORDER BY COUNT(*) DESC;

-- Processing latency (publish → consume)
SELECT event_type, AVG(EXTRACT(EPOCH FROM (consumed_at - published_at)))
FROM dept_signals WHERE consumed = true
GROUP BY event_type;
```

---

## Limitations & Future

### Current Limitations

- **Schema registry is static** (hardcoded in contracts.ts; no runtime schema updates)
- **No schema versioning** (if you change a schema, old signals won't validate)
- **No ordering guarantees** (signals processed in DB order, not publish order)
- **Hourly only** (sweep runs at 6:01 AM and 6:01 PM; faster feedback not yet needed)

### Future Improvements (Phase E+)

- **Semantic signals**: Publish signals that trigger automatic actions (e.g., `auto_send_email` with founder decision flag)
- **Multi-tenant signals**: Separate signal queues per company (Phase E — SaaS pivot)
- **Signal subscriptions**: Departments subscribe to specific signal types (instead of sweep surfacing all)
- **Schema versioning**: Support evolving schemas without breaking old signals

---

## References

- **Contracts implementation**: `src/agents/contracts.ts`
- **publish_signal tool**: `src/agents/agent-tools/signals.ts`
- **Sweep scheduler**: `src/infra/scheduler.ts`
- **Database schema**: `src/db/schema.ts` (dept_signals table)
- **Phase 2 details**: [PHASE-2-TYPED-CONTRACTS.md](../phases/PHASE-2-TYPED-CONTRACTS.md)
- **Phase 4 details**: [PHASE-4-DEPT-SIGNALS.md](../phases/PHASE-4-DEPT-SIGNALS.md)
