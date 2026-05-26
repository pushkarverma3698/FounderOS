# ADR-004: Why Telegram for Human-in-the-Loop Approvals

**Date:** 2025-05  
**Status:** Accepted  
**Context:** FounderOS agents produce outputs (emails, PRs, LinkedIn posts) that require human approval before external actions are taken. We need an approval interface the founder will actually use.

---

## The Problem

HITL is only valuable if the human actually approves/rejects in a reasonable time. An approval interface that requires:
- Opening a browser and logging into a web app → abandoned
- Checking email → slow (30+ min latency on mobile)
- Slack → not always open, notification-heavy work context

We need the founder to see the approval request *immediately*, approve in *2 taps*, on their *phone*, while in a meeting.

---

## Options Considered

### Option A: Custom Web Dashboard
Build a React approval queue at `dashboard.founderos.com`.

**Pros:** Full UI control, rich previews, filtering.  
**Cons:**
- 3–4 weeks to build and deploy
- Founder has to proactively check a URL
- Mobile web is slower than native apps
- Adds a separate authentication system
- Requires a frontend deployment pipeline

**Verdict:** Over-engineered for a two-person founding team. Solve it when the team is > 5 people.

### Option B: Email Approvals
Send approval emails with "Approve" / "Reject" links.

**Pros:** Universal — everyone has email. No new accounts needed.  
**Cons:**
- Email open rates for internal tools are low
- Link-based approvals require a web server to handle the callback
- Mobile email clients are slow and cluttered
- No real-time notification — founder checks email on a schedule

**Verdict:** Too slow for operational decisions. An unread email blocks a task for hours.

### Option C: Slack
Bot in a Slack workspace with Block Kit action buttons.

**Pros:** Team-friendly, good notification system, works on mobile.  
**Cons:**
- Slack's free tier deletes message history after 90 days — approval records lost
- Block Kit API is more complex than Telegram's InlineKeyboardMarkup
- `@slack/bolt` is heavier than grammy
- The founder (Pushkar) is always on Telegram, not always on Slack

**Verdict:** Valid for a larger team, but mismatches the founder's actual communication habits.

### Option D: Telegram with grammy

**Pros:**
- Founder is in Telegram all day — notifications are seen immediately
- **Inline keyboards** — Telegram renders approve/reject buttons natively on mobile
- **Topic groups** — one group with department topics (Sales, Engineering, Marketing, Boardroom) maps perfectly to FounderOS departments
- `grammy` is TypeScript-first with excellent DX
- Telegram bots are free; no infrastructure for the notification delivery
- `callback_query` gives us an acknowledgment when the button is tapped — we know the founder saw it

**Cons:**
- Telegram-specific — if the founder switches platforms, this needs to be rethought
- Group topic IDs must be configured manually in `.env`

---

## Decision: Telegram + grammy

### Why This Is The Right Call For Now

The founder is already in Telegram all day. Adding an approval interface *where the founder already is* means zero behaviour change and near-zero latency:

1. Agent produces email draft → HITL node fires
2. Telegram message appears in the **Sales** topic of the Founders group (30 seconds later)
3. Founder taps **[✅ Approve]** or **[✗ Reject]** on their phone
4. Graph resumes, email is sent

Total elapsed time: 2–5 minutes (including the founder's reaction time). Compare to checking a web dashboard: 30–120 minutes.

### The Durability Problem

The classic challenge with HITL: what if the process restarts while the graph is paused waiting for approval?

LangGraph's `interrupt()` + PostgreSQL checkpointing solves this:

```typescript
// 1. Write to DB FIRST — before calling interrupt()
await createInterrupt({
  interrupt_id: interruptId,
  thread_id: threadId,
  status: "pending",
  expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
});

// 2. Send Telegram message
await bot.api.sendMessage(chatId, message, {
  message_thread_id: topicId,
  reply_markup: keyboard,
});

// 3. Pause execution — graph is checkpointed at this exact point
const decision = interrupt({ interruptId, content: draft });
```

If the process crashes after step 1 but before step 3: on restart, the interrupt_registry row exists, the Telegram message exists, and the human can still tap Approve. The `callback_query` handler resolves the DB row and resumes the graph.

If the process crashes after step 3: the checkpoint has the `interrupt()` call captured. On restart, LangGraph resumes from the interrupt, re-delivers the pending value if already resolved, or waits if still pending.

### Topic Group → Department Mapping

```
Founders Group (Telegram Super Group with Topics)
├── 📋 Boardroom       ← general tasks, CEO routing
├── 💼 Turicks         ← sales + eng + mktg tasks for the agency
├── 🏔 Naggar Retreat  ← farm and retreat tasks
└── 🌐 Think Tank      ← cross-company social / LinkedIn growth
```

Agents know which topic to send to via `getAgentTopicId(agentName)` in `registry.ts`.

### Callback Data Format

Telegram callback buttons carry a short string (max 64 bytes):

```
approve:<interrupt_id>   e.g. approve:550e8400-e29b-41d4-a716-446655440000
reject:<interrupt_id>
edit:<interrupt_id>
```

The grammy handler parses this and calls `resolveHITL(interruptId, "approved")`.

---

## Consequences

- **Topic IDs are environment variables** — must be set in `.env` and never hardcoded. The `registry.ts` loads them via `process.env["TOPIC_*"]`.
- **Only one polling instance at a time** — two processes polling the same bot token will fight. In production, use `webhooks` mode instead of long-polling.
- **24-hour expiry on interrupts** — interrupts that aren't resolved in 24 hours are expired by a cron job (`expireStaleInterrupts()`). The graph receives an "expired" resolution and the task is cancelled.
- **Message thread IDs can be zero** — if topics aren't configured, `message_thread_id: 0` sends to the main group. Works as a safe fallback.
- **Future:** When the team grows beyond 2–3 people, add a web dashboard as an *additional* approval channel (not a replacement). grammy and the web dashboard both resolve the same `interrupt_registry` row.
