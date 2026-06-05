# FounderOS — User Testing Guide

Hey! You've been given access to test FounderOS — Pushkar's AI chief of staff running on Telegram.

---

## What Is This?

FounderOS is an AI system that routes your requests to specialised agents across 7 departments — Research, Comms, Engineering, Marketing, Sales, Personal (laptop), and Job-Hunt. It runs entirely through Telegram. For anything that has side effects (sending an email, writing a file, posting to LinkedIn), it pauses and shows you an Approve/Reject card before doing anything.

---

## Getting Started

1. Find the bot on Telegram — Pushkar will send you the bot link directly.
2. Just send a message — write it like you'd text an assistant. No special syntax needed.
3. For writes (emails, calendar events, files, GitHub issues): you'll see an Approve/Reject card before the action runs. Nothing fires until you tap Approve.

---

## Quick Commands

```
/help          — not a command; use /commands for the full list
/commands      — all available commands
/departments   — what each department can do
/status        — uptime, pending approvals, emails sent today
/context       — view or update your stored business context
/reset         — clear conversation history and start fresh
/ping          — not wired; use /status to check if the bot is alive
```

---

## 10 Tasks to Try

One per department — mix and match. These are representative prompts, not scripts you have to follow exactly.

**Research**
> "Find me 3 competitors to Anthropic and compare their pricing"

**Comms — email triage (read, no approval needed)**
> "Check my last 3 emails and triage them"

**Comms — calendar (approval required)**
> "Book a call with me tomorrow at 3pm titled 'Weekly sync'"

**Engineering — read (no approval needed)**
> "What are my GitHub repos?"

**Marketing — LinkedIn post (approval required)**
> "Draft a LinkedIn post about AI automation trends in 2026"

**Sales — prospect research (read, no approval needed)**
> "Research Notion and score them as a potential client for Turicks"

**Personal — laptop files (read, no approval needed)**
> "List files on my Desktop"

**Job-Hunt — job search (read, no approval needed)**
> "Find AI engineer jobs that mention LangGraph"

**Workflow — multi-step SOP**
> `/run weekly_digest`

**Direct routing — power user**
> `/q research What's happening in AI this week?`

---

## How Approvals Work

When the bot wants to do something with a side effect (send an email, write a file, post to LinkedIn, create a GitHub issue, run a shell command):

1. It pauses and shows you a card describing exactly what it's about to do
2. Tap **Approve** to let it proceed
3. Tap **Reject** to cancel

Nothing happens until you tap Approve. If you send a new message while an approval card is pending, the pending action is automatically cancelled and your new request runs cleanly.

---

## Understanding Departments

| Department | What it does | Approval required? |
|---|---|---|
| Research | Web search, knowledge base lookup, email inbox read | No |
| Comms | Send email, read email, LinkedIn post | Yes for sends/posts |
| Engineering | Read GitHub repos, create/update issues, push code | Yes for writes |
| Marketing | Draft + publish LinkedIn content in brand voice | Yes |
| Sales | Prospect research, cold outreach drafts | Yes for sends |
| Personal | Read/write laptop files, run scripts, open browser | Yes for writes/shell/browser |
| Job-Hunt | Search jobs, read your CV, draft applications | Yes for sends |

---

## Workflows (/run)

Workflows are multi-step SOPs that chain department tasks together automatically.

```
/workflows                          — list all available workflows
/run onboarding company=Acme Corp   — score → research → email → repo
/run outbound company=Stripe        — score → find hook → cold email
/run weekly_digest                  — memory review → open items → Monday plan
```

Each step runs through the office. HITL cards appear inline if a step requires approval.

---

## Direct Routing (/q)

Skip the supervisor and send a task straight to a named department:

```
/q research What are the top AI tools in 2026?
/q engineering Write a TypeScript debounce function
/q personal List files on my Desktop
/q sales Draft cold outreach to an early-stage SaaS founder in London
```

Valid departments: `research` · `comms` · `engineering` · `marketing` · `sales` · `personal` · `jobhunt`

---

## Known Limitations

- **Browser control = macOS only.** Safari AppleScript automation requires the bot to be running on a Mac with Automation permissions granted. "Open X in my browser" may not work remotely.
- **PDF / image files:** use "send me [filename]" to receive the file as a Telegram attachment, or "read [filename]" to get the text content.
- **LinkedIn media:** text posts only. Image attachments via the bot are not supported.
- **Google Calendar:** requires a Google Calendar connection set up via Composio (Pushkar configures this). If not connected, calendar events will fail with a clear error.
- **Job-Hunt CV features:** require the personal-rag service to be running locally. If it's down, CV reading falls back to a summary wiki.
- **File size limit:** files over 50 MB cannot be sent via the "send me" command.
- **Secrets are always blocked:** the bot will refuse to read files like `~/.ssh/id_rsa`, `.env`, AWS credentials, or keychains — by design.

---

## Reporting Feedback

Reply to any bot message with: **[FEEDBACK]** followed by your comment.

Example:
> [FEEDBACK] The research reply was too long and didn't give me a bottom-line answer

Or message Pushkar directly.

Please include:
- What you asked
- What you expected
- What you got
