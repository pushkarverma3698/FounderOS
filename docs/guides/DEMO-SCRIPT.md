# FounderOS — Demo Script

> **Status:** Production-verified 2026-06-08. Each query below is pinned as a golden eval task (`src/eval/golden-tasks.ts`).

---

## Setup Checklist

Before the demo:

```bash
# 1. Ensure the bot is running (single-instance, 0× 409)
pnpm start  # or: nohup node --env-file=.env --import tsx/esm src/index.ts > /tmp/founderos.log 2>&1 &

# 2. Verify it's up
grep "Office compiled" /tmp/founderos.log | tail -1

# 3. Confirm 0× 400 errors from prior session
grep "400 Bad Request" /tmp/founderos.log | wc -l  # expect: 0

# 4. Open Telegram chat — confirm /start responds
```

---

## Demo Queries (5 × Verified, Reliable)

### 1. Research — Web Search (`~5 sec`, no approval needed)

```
What's the latest news about AI coding tools this week?
```

- Routes to: **research** department
- Tool: `search_web` → formatted results with titles + links
- No approval required — shows instant, read-only capability

---

### 2. Personal — File Listing (`~2 sec`, no approval needed)

```
List the files in my Projects folder
```

- Routes to: **personal** department  
- Tool: `list_dir` (read-only, ungated)
- Shows real laptop file listing instantly — no approval card

---

### 3. Engineering — Inline Code (`~3 sec`, no tool call)

```
Write a TypeScript function to parse an ISO date string and return a formatted date
```

- Routes to: **engineering** department
- No tool call — code returned inline in the reply
- Shows code generation without any external API dependency (most reliable demo)

---

### 4. Comms — HITL Approval Flow (`~5 sec`, approval card shown)

```
Draft an email to hello@acme.com introducing Turicks services and asking for a discovery call
```

- Routes to: **comms** department
- Tool: `send_email`
- **Triggers HITL approval card** — shows the human-in-the-loop UI
- Bot pauses, shows preview card with ✅/❌ buttons
- Approve to send, reject to cancel — demonstrates the full safety gate

> **Demo tip:** This is the best demo moment — show the HITL card, then approve to send a real email (or reject to cancel safely).

---

### 5. Personal — Browser Automation (`~3 sec`, approval card shown)

```
Open https://anthropic.com in my Safari browser
```

- Routes to: **personal** department
- Tool: `browser` (AppleScript via osascript)
- **Triggers HITL approval card** — shows browser automation with safety gate
- On approval: opens URL in Safari on the live laptop

---

## Workflow Demo (bonus — requires running bot)

```
/run weekly_digest
```

- Executes the 3-step weekly digest workflow (memory review → open items → Monday plan)
- Each step runs sequentially through the office; HITL fires if needed
- Good for showing multi-step orchestration

---

## Common Questions + Answers

| Question | Answer |
|----------|--------|
| "Does it actually send?" | Yes — `send_email` routes through Composio (Gmail). The HITL card is required before every send. |
| "Can it run arbitrary code?" | `run_shell` and `project_workflow run_command` are HITL-gated + path-guarded to `~/Projects`. |
| "What if it loops?" | Recursion limit of 40 steps; `GraphRecursionError` returns a helpful message with next steps. |
| "Can you show personalisation?" | Try `Score [Company] as a Turicks prospect` — ICP scoring via research dept. |
| "How does it know Turicks?" | `search_knowledge` queries `turicks-brain` Postgres vector store. Run `pnpm brain:sync` to update. |

---

## If Something Goes Wrong

```bash
# Check for errors
grep -E "ERROR|400 Bad Request|503" /tmp/founderos.log | tail -20

# Restart cleanly (single-instance lock handles the handoff)
pkill -f "src/index.ts"; sleep 1
nohup node --env-file=.env --import tsx/esm src/index.ts > /tmp/founderos.log 2>&1 &

# Confirm 1 instance, 0× 409
ps aux | grep "src/index.ts" | grep -v grep | wc -l  # expect: 1
grep "409 Conflict" /tmp/founderos.log | wc -l  # expect: 0
```
