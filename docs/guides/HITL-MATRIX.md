# HITL-Gated Tools Matrix

**Quick Reference:** Which tools require founder approval before execution?

---

## Full Matrix

| # | Tool | Department | Type | Gate Pattern | Why HITL? | Escalation | If Rejected |
|---|------|-----------|------|--------------|----------|-----------|------------|
| 1 | `send_email` | comms, sales | External write | Full gate | Sender reputation, CAN-SPAM compliance, privacy violations | Founder approves content + recipient | "Email not sent (rejected by founder)" |
| 2 | `linkedin_post` | marketing | External write | Gate 1 (brand) → Gate 2 (judge) | Brand safety, regulatory risk (no false claims), LinkedIn terms violation | Founder approves after brand-validator + Claude judge | "Post not published (rejected)" |
| 3 | `schedule_social_post` | marketing | External write (deferred) | Gate 1 (brand) → Gate 2 (judge) → HITL once | Same outbound risk as immediate post; approval covers **both** queueing and future auto-publish (no second card at cron time) | Founder approves draft + `scheduled_at`; cron publishes with zero LLM | "Post not scheduled (rejected)" |
| 4 | `github_write` | engineering | External write | Full gate | Account security (commits, PRs, pushes affect production), code review required | Founder reviews PR content + target branch | "PR not created (rejected)" |
| 5 | `project_workflow` | engineering | External action | Full gate | CI/CD triggers, deployment automation (can break production), affects other teams | Founder confirms workflow + deploy targets | "Workflow not executed (rejected)" |
| 6 | `claude_code` | engineering | Local execution | Full gate | Arbitrary shell/git execution on founder's machine, file writes to any path (unless path-guarded) | Founder reviews: files touched, shell commands, git operations | "Code not executed (rejected)" |
| 7 | `create_calendar_event` | comms | External write | Full gate | Calendar namespace collision, privacy (attendees see event details), can overwrite existing events | Founder confirms event + attendees | "Event not created (rejected)" |
| 8 | `write_file` | personal | Local write | Full gate | Arbitrary file modification on founder's machine, overwrites existing files, can corrupt configs | Founder reviews: file path, content, file size | "File not written (rejected)" |
| 9 | `run_shell` | personal | Local execution | Full gate | Arbitrary shell commands, can delete files, kill processes, install software | Founder reviews: command, working directory, env vars | "Command not executed (rejected)" |
| 10 | `send_file` | personal | External send | Full gate | File exfiltration risk, sharing confidential files via Telegram | Founder confirms: file path, recipient, content type | "File not sent (rejected)" |
| 11 | `browser` | personal | Local automation | Full gate | Arbitrary browser automation, can access private data (cookies, autofills), login to founder's accounts | Founder reviews: URL, actions (click/type/navigate), scope | "Browser action not executed (rejected)" |
| 12 | `read_emails` | comms | External read | **NO gate** | Read-only, instant execution, no side effects, no privacy loss (founder's own inbox) | N/A | N/A |
| — | `list_scheduled_posts` | marketing | External read | **NO gate** | Read-only queue inspection; no publish side effect | N/A | N/A |

---

## Gate Patterns Explained

### Full Gate (10 tools)
**Sequence:** Agent drafts/decides → HITL approval card → Founder reviews/approves → Side effect executes

Example (send_email):
```
Agent: "I'll draft a cold email to Jane@acme.com"
       ↓
HITL Card: [Draft preview] [Approve] [Edit] [Cancel]
       ↓
Founder clicks [Approve] (or edits + re-approves)
       ↓
send_email executes, email sent, audit record written
```

### Two-Gate (2 tools)
**Sequence:** Agent drafts → Gate 1 (brand-validator, no LLM) → Gate 2 (Claude judge) → HITL approval → Post

Example (`linkedin_post` — publish now):
```
Agent: "I'll post about FounderOS on LinkedIn"
       ↓
Gate 1 (Brand Validator): Checks banned phrases, word count, phishing language
       ↓
Gate 2 (Claude Judge): Evaluates tone, brand alignment, compliance
       ↓
HITL Card: [Draft preview] [Judge feedback] [Approve] [Edit]
       ↓
Founder clicks [Approve]
       ↓
linkedin_post executes, post published, audit record written
```

Example (`schedule_social_post` — publish later):
```
Agent: "I'll schedule this post for Tuesday 9am"
       ↓
Gate 1 + Gate 2 (same as linkedin_post)
       ↓
HITL Card: [Draft + scheduled_at] [Approve] [Edit]
       ↓
Founder clicks [Approve] once
       ↓
Row inserted in scheduled_posts (status: scheduled)
       ↓
Later: runScheduledPostSweep() publishes via providerLinkedInPost — no second HITL
```

### No Gate (1 tool)
**Sequence:** Agent reads → Instant execution (no HITL, no side effect)

Example (read_emails):
```
Agent: "I'll check your inbox"
       ↓
read_emails executes immediately
       ↓
Results returned to agent (internal use, no external send)
```

---

## Key Principles

### 1. **All External Writes Gate**
- `send_email`, `linkedin_post`, `schedule_social_post`, `github_write`, `project_workflow`, `create_calendar_event`
- **Why:** Affects others (recipient, followers, CI/CD, attendees) → consent required

### 2. **All Local Writes/Execution Gate**
- `write_file`, `run_shell`, `claude_code`, `browser`
- **Why:** Can modify founder's machine → explicit approval required

### 3. **Send Operations Gate**
- `send_file`, `send_email`, `linkedin_post`, `schedule_social_post`
- **Why:** Data leaves the system → audit trail required

### 4. **Reads Don't Gate** (unless sensitive)
- `read_emails` → instant (founder's own inbox, read-only)
- **Future:** If we add `read_gmail_archive` (full history), that might gate if the scope is too broad

---

## Implementation (where these gates live)

**All HITL gates use the same pattern:**

```typescript
// In src/agents/agent-tools/*.ts (per-dept)
export async function send_email(payload: {...}) {
  // ... draft email ...
  
  const approval = await hitlGate({
    action: "send_email",
    preview: `To: ${payload.to}\nSubject: ${payload.subject}\n\n${payload.body}`,
    kind: "approval", // Always "approval" for send operations
  });
  
  if (!approval) {
    return { success: false, error: "Email send rejected by founder" };
  }
  
  // Side effect executes ONLY after approval
  await sendEmail(payload); // Call Composio or internal API
  await writeAuditEntry({ action: "email_sent", payload, idempotency_key: ... });
  
  return { success: true, result: "Email sent" };
}
```

**hitlGate function** (src/agents/agent-tools.ts):
```typescript
export async function hitlGate(payload: {
  action: string;
  preview: string;
  kind: "approval" | "info";
}): Promise<string | null> {
  // Writes to hitl_approvals table
  // Calls office.interrupt() with payload
  // Founder taps [Approve] in Telegram
  // Returns the approval, or null if rejected
  
  const approval = await db
    .insert(hitlApprovals)
    .values({ ...payload })
    .returning();
  
  const result = await office.interrupt(payload);
  return result ? approval.id : null;
}
```

---

## Observability: How to Verify Gates Are Working

### 1. Check HITL Approvals Table
```sql
SELECT action, COUNT(*) FROM hitl_approvals 
GROUP BY action 
ORDER BY COUNT(*) DESC;
-- Should show: send_email, linkedin_post, github_write, etc. with approval counts
```

### 2. Check Audit Log (side effects only executed after approval)
```sql
SELECT action, COUNT(*) FROM action_log 
WHERE action LIKE 'email_sent' OR action LIKE 'post_published'
GROUP BY action;
-- Counts should match approved HITL_approvals (no sends without approval)
```

### 3. Monitor Rejections
```sql
SELECT action, COUNT(*) FROM hitl_approvals 
WHERE approved = false
GROUP BY action;
-- If > 0, gates are being exercised (founder rejecting some actions)
```

### 4. Trace a Single Tool Call (via logs)
```bash
grep "send_email\|hitlGate" /tmp/founderos.log | tail -20
# Should see:
# 1. "Tool: send_email invoked..."
# 2. "HITL: approval_card posted"
# 3. "Founder: approved"
# 4. "Action: email_sent (audited)"
```

---

## Decision Tree: Is This Tool HITL-Gated?

```
Does the tool send data outside FounderOS?
├─ YES (send_email, linkedin_post, schedule_social_post, github_write, create_calendar_event, send_file)
│  └─ Full gate? YES
├─ NO, does it execute on the founder's machine?
│  ├─ YES (claude_code, run_shell, browser, write_file)
│  │  └─ Full gate? YES
│  └─ NO, is it a read-only operation?
│     ├─ YES (read_emails)
│     │  └─ Gate? NO (instant execution)
│     └─ NO
```

---

## References

- **How HITL works**: [OPERATIONS.md](OPERATIONS.md) → Halt & Resume section
- **Judge (2-gate system for linkedin_post)**: [JUDGE-AND-CRITIC.md](JUDGE-AND-CRITIC.md)
- **Audit log implementation**: `src/db/schema.ts` (hitl_approvals, action_log tables)
- **Error handling**: When founder rejects, tool returns error with no side effects executed
