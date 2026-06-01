# FounderOS — Daily Operations Guide

*How to actually use FounderOS every day. Treat this as your manual.*

---

## Starting the Bot

```bash
cd ~/Projects/founderos
pnpm dev
```

The bot starts, connects to Postgres, compiles the office (takes ~3 seconds), and begins polling Telegram. You'll see:

```
Office compiled: supervisor + [research, comms, engineering]
Telegram bot starting (long polling)…
FounderOS running 🚀
Health server listening on /health and /metrics
```

**Stop:** `Ctrl+C` — cleans up gracefully.

**Restart after a crash:**
```bash
pkill -f "src/index.ts"; pnpm dev
```

**Background (leave running while you work):**
```bash
nohup node --env-file=.env --import tsx/esm src/index.ts > /tmp/founderos.log 2>&1 &
echo $! > /tmp/founderos.pid
# stop later: kill $(cat /tmp/founderos.pid)
```

---

## Talking to the Bot

Open Telegram and message **@Raggae3698_bot** (your bot).

### Research
```
"What is Linear app and what problems does it solve?"
"Research the latest trends in AI agents for enterprise in 2025"
"Find information about [company name] — what do they do and who are their customers?"
```
→ Bot searches the web and returns a cited summary. No approval needed.

### Email (via Composio Gmail)
```
"Email pushkarai3698@gmail.com with subject 'Test' and body 'Just testing FounderOS'"
"Draft and send an intro email to alex@acme.com about Turicks"
"Reply to the last email from [name] saying we're interested"
```
→ Bot drafts the email → shows you an Approve/Reject card with the full content → you tap Approve → email lands in the inbox.

### LinkedIn (via Composio)
```
"Write and post a LinkedIn post about how I used AI to save 10 hours this week"
"Draft a LinkedIn post about the FounderOS architecture"
```
→ Bot writes the post in your voice → shows Approve/Reject → you tap Approve → published.

### Engineering / GitHub
```
"List all my GitHub repositories"
"What's in the README of my founderos repo?"
"Open a GitHub issue on pushkarverma/founderos titled 'Add sales department' with a description"
"Write a TypeScript function that validates email addresses with regex"
```
→ Read actions (list, get README) happen immediately.
→ Write actions (create issue, create repo, update README) show an Approve/Reject card first.

### General Questions
```
"What can you do?"
"How does LangGraph interrupt work?"
"What's the difference between a ReAct agent and a supervisor?"
```
→ Supervisor answers directly without routing to a department.

---

## The Approval Flow

When you request a write action, you'll see a card like:

```
📧 Send email to alex@acme.com?
Subject: Turicks × Linear — AI workflow automation

Hi Alex,

I noticed Linear recently added AI-powered triage...
[rest of email]

✅ Approve    ❌ Reject
```

- **Approve** → email sends immediately, you get a ✅ confirmation
- **Reject** → nothing happens, bot tells you it was rejected

**Important:** Only one approval can be pending at a time per chat. Approve or reject before sending another message.

**If the bot seems stuck:** check if there's a pending approval card you haven't tapped yet. Scroll up in the chat.

---

## What Each Department Does

### Research
**Trigger words:** research, find, search, look up, what is, what does, latest, news, who is

Uses Firecrawl to search the web. Returns title + URL + summary for each result. **Requires `FIRECRAWL_API_KEY`.**

### Comms
**Trigger words:** email, send, message, post, LinkedIn, publish, write and send

- **Email:** Composio Gmail. Checks suppression list before sending. Idempotent — same email won't send twice. **Requires `COMPOSIO_API_KEY` + Gmail connection in Composio.**
- **LinkedIn:** Composio LinkedIn post. **Requires `COMPOSIO_API_KEY` + LinkedIn connection in Composio.**

### Engineering
**Trigger words:** code, build, write a function, GitHub, create issue, create repo, list repos, README

- **GitHub reads** (list repos, get README, get stats): instant, no approval.
- **GitHub writes** (create issue, update README, create repo): approval required. **Requires `GITHUB_TOKEN`.**
- **Code generation:** writes TypeScript (or requested language) directly in the reply. No external service needed.

---

## Setup Checklist (Do These Once)

### 1. Composio Gmail
1. Go to [composio.dev](https://composio.dev) → My Apps → Connect Gmail
2. Connect with your Google account
3. Set the entity ID to `turicks` (this is your `FOUNDER_TENANT` value)
4. Test: `Email myself@gmail.com subject 'test' body 'hi'` → Approve → check inbox

### 2. Composio LinkedIn
1. Composio → My Apps → Connect LinkedIn
2. Make sure `w_member_social` permission is granted (for posting)
3. Entity ID: `turicks`
4. Test: `Write a LinkedIn post saying "Testing my AI system"` → Approve → check LinkedIn

### 3. GitHub Token
1. GitHub → Settings → Developer settings → Personal access tokens → Classic
2. Scopes: `repo` (full) + `read:user`
3. Add to `.env`: `GITHUB_TOKEN=ghp_...`
4. Restart bot
5. Test: `List my GitHub repos`

### 4. Firecrawl
1. Sign up at [firecrawl.dev](https://firecrawl.dev)
2. Copy API key
3. Add to `.env`: `FIRECRAWL_API_KEY=fc-...`
4. Restart bot
5. Test: `Research what Stripe does`

---

## Error Messages Explained

| You see | What it means | Fix |
|---------|--------------|-----|
| `⚠️ Tool issue: FIRECRAWL_API_KEY not set` | Missing env var | Add `FIRECRAWL_API_KEY` to `.env`, restart |
| `⚠️ Tool issue: COMPOSIO_API_KEY not configured` | Missing env var | Add `COMPOSIO_API_KEY` to `.env`, restart |
| `⚠️ Tool issue: BLOCKED: on do-not-contact list` | Recipient is suppressed | Remove from `do_not_contact` table in DB or use a different email |
| `⚠️ Tool issue: Email send failed` | Composio error | Check Composio dashboard, verify Gmail connection for entity `turicks` |
| `❌ Error [stack trace]` | Unexpected crash | Check `/tmp/founderos.log` for details |
| `✅ Done.` with no content | Reply extraction issue | The agent replied with tool calls only — check logs |

---

## Checking What Happened

### Live logs
```bash
tail -f /tmp/founderos.log
```

### What emails were actually sent
```bash
docker exec -it turicks-postgres psql -U turicks -d turicks -c \
  "SELECT action, payload->>'to' as to, payload->>'subject' as subject, created_at FROM action_log WHERE action = 'send_email' ORDER BY created_at DESC LIMIT 10;"
```

### All recent actions
```bash
docker exec -it turicks-postgres psql -U turicks -d turicks -c \
  "SELECT action, idempotency_key, created_at FROM action_log ORDER BY created_at DESC LIMIT 20;"
```

### Conversation history for your chat
```bash
docker exec -it turicks-postgres psql -U turicks -d turicks -c \
  "SELECT thread_id, checkpoint_id, type, created_at FROM checkpoints ORDER BY created_at DESC LIMIT 10;"
```

---

## Tuning the Bot

### Change how the supervisor routes tasks
Edit `SUPERVISOR_PROMPT` in `src/agents/system-prompts.ts`. Describe the departments more precisely or add examples of what belongs where. Restart the bot.

### Change how an agent behaves
Edit the relevant prompt (`RESEARCH_PROMPT`, `COMMS_PROMPT`, `ENGINEERING_PROMPT`) in `src/agents/system-prompts.ts`. No code changes needed — the LLM reads the prompt.

### Change the model
In `.env`: `AGENT_MODEL=gemini-2.5-pro` for higher quality, or `AGENT_MODEL=claude-sonnet-4-5` when you have a valid Anthropic key. Restart the bot.

### Add a domain to the do-not-contact list
```bash
docker exec -it turicks-postgres psql -U turicks -d turicks -c \
  "INSERT INTO do_not_contact (tenant_id, email_or_domain, reason) VALUES ('turicks', '@competitor.com', 'competitor');"
```

---

## Weekly Habits

| When | What to do |
|------|------------|
| Monday | Ask: "What should I focus on this week for Turicks?" (research recent news in your niche) |
| Daily | Use research before any client call: "Research [company] quickly" |
| When writing content | Ask: "Draft a LinkedIn post about [what you did this week]" → Approve if good |
| When prospecting | "Research [company] and tell me if they're a good Turicks prospect" |
| When closing a deal | "Draft an intro email to [name] at [company] about [specific pain point]" |

---

## Troubleshooting

**Bot doesn't respond:**
```bash
ps aux | grep "src/index.ts" | grep -v grep  # is it running?
cat /tmp/founderos.log | tail -20            # any errors?
```

**Bot responds but slowly (>30 seconds):**
- Gemini Flash rate limits occasionally → bot retries automatically
- Check LangSmith dashboard if `LANGCHAIN_TRACING_V2=true` is set

**"Routing to office" logged but no reply:**
- There may be a pending approval you haven't tapped yet
- Or the model returned an empty response — check logs for Gemini errors

**Approval card sent but resume doesn't work:**
- The thread state is in Postgres — as long as the bot is running and `DATABASE_URL` is correct, it will resume
- Restart the bot with the same `.env` — the pending approval will still be there

**Email says "BLOCKED: on do-not-contact list":**
- Check the `do_not_contact` table and remove the entry if it was added by mistake

**`Cannot find package '@composio-core/js'`:**
- This was a bug in v1. v2 uses `composio-core`. Run `pnpm install` and restart.
