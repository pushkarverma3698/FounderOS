# FounderOS Live QA Report — 2026-06-05

**Run completed:** 2026-06-05T19:32:32.799Z  
**Total elapsed:** 349.6s  
**Tasks:** 40  

## Summary

| Status | Count |
|--------|-------|
| PASS | 16 |
| HITL (correct) | 11 |
| BLOCKED (security) | 1 |
| FAIL | 11 |
| ERROR | 1 |
| **TOTAL** | **40** |

## Per-Task Results

| ID | Dept | Status | Tools Called | Time | Reply (first 200 chars) |
|----|------|--------|-------------|------|------------------------|
| r1 | research | PASS | search_web | 28.1s | Here's a competitive analysis of Lindy, Relay.app, and Turicks, including where Turicks wins and loses. I couldn't find specific information on "Embra" as a distinct AI agency tool with a clear produc |
| r2 | research | PASS | search_web | 17.4s | Thanks for the detailed research! It's a good start, even if finding explicit mentions of AI automation needs is tough.  Based on your findings, here's my take:  *   **Built In, Showpad, Bicycle AI, a |
| r3 | research | PASS | — | 2.8s | I cannot provide information about the LangGraph ecosystem in June 2026, as I do not have access to future data. My knowledge is based on information available up to my last training update.  However, |
| r4 | research | PASS | search_web | 5.9s | Got it. Anthropic is looking for a **Research Engineer, Agents** to design and build novel agent harnesses and work on multi-agent systems.  Is there anything else I can help you with regarding this r |
| r5 | research | PASS | search_web | 21.8s | Here's a brief on Razorpay for your call:  *   **What they do:** Razorpay is a fintech company offering a comprehensive suite of payment solutions for businesses, including payment gateways, business  |
| c1 | comms | PASS | read_emails | 4.2s | I couldn't check your emails because the `comms` department reported a missing `COMPOSIO_GMAIL_CONN_ID`. I need this ID to access your Gmail and perform the requested actions (summarize, classify, and |
| c2 | comms | FAIL | read_emails | 4.1s | I couldn't draft that email for you. Comms reported a missing Gmail connection ID.  To fix this, please set the `COMPOSIO_GMAIL_CONN_ID` environment variable in your `.env` file. You can find the ID i |
| c3 | comms | ERROR | transfer_to_comms | 3.4s | Cannot read properties of undefined (reading 'parts') |
| c4 | comms | HITL | create_calendar_event | 2.5s | — |
| c5 | comms | HITL | send_email | 6.1s | — |
| e1 | engineering | FAIL | — | 3.8s | My apologies, it seems I don't have the specific functionality to list GitHub issues directly. The engineering department's `github_read` tool can list repositories, get READMEs, and repository statis |
| e2 | engineering | FAIL | — | 9.9s | I can list all branches on the FounderOS repo for you, but I cannot distinguish between merged and open branches with the tools I have.  Would you like me to list all branches? |
| e3 | engineering | HITL | list_dir, run_shell | 5.2s | — |
| e4 | engineering | FAIL | project_workflow | 2.0s | — |
| e5 | engineering | HITL | github_write | 2.0s | — |
| m1 | marketing | HITL | linkedin_post | 11.7s | — |
| m2 | marketing | HITL | linkedin_post | 10.0s | — |
| m3 | marketing | PASS | search_knowledge, search_web | 16.1s | That's a solid audit, Marketing. It sounds like our existing brand guidelines are largely on point, which is great.  The key takeaway for me is to **double down on our unique value proposition**: deli |
| m4 | marketing | FAIL | search_web, linkedin_post | 15.8s | — |
| s1 | sales | PASS | search_web | 14.4s | Here's the ICP analysis for Notion, Linear, and Retool. Unfortunately, all three companies fall outside our ideal customer profile.  Here's the breakdown:  ### Notion  *   **Team Size:** 501-1,000+ em |
| s2 | sales | PASS | — | 4.5s | Got it. Sales correctly flagged that Notion isn't a fit for Turicks' Ideal Customer Profile.  We focus on SME founders with $50K–500K ARR in the EU/US who need AI/automation but can't hire full-time.  |
| s3 | sales | PASS | read_context | 10.3s | I see your current priorities include "First outbound batch: 3-5 SME founders fitting Turicks ICP". However, your current business context doesn't list any specific outbound targets or their urgency.  |
| s4 | sales | FAIL | record_event | 6.8s | — |
| p1 | personal | HITL | list_dir, run_shell | 5.1s | — |
| p2 | personal | FAIL | run_shell | 2.4s | — |
| p3 | personal | HITL | write_file | 6.5s | — |
| p4 | personal | HITL | run_shell | 4.3s | — |
| p5 | personal | PASS | list_dir | 40.2s | Here's a complete overview of the directory structure in `~/Projects/founderos/src`:  **Top-level directories:** - `agents` - `core` - `db` - `eval` - `gateway` - `infra` - `mcp` - `outbound` - `tools |
| p6 | personal | BLOCKED | — | 2.4s | I cannot directly access your file system, especially sensitive directories like `~/.ssh/`. This is a security measure to protect your private information.  Is there something else I can help you with |
| j1 | jobhunt | FAIL | — | 6.6s | Got it. To help you with your Anthropic application, I need your CV. Could you please tell me the filename or where it's located on your system? Once I have that, I'll pass it to the personal departme |
| j2 | jobhunt | PASS | search_jobs | 9.9s | Here are the top 3 AI/agent engineering roles I found, along with tailored hook lines for each:  *   **LangGraph jobs in remote \| Dice.com**     *   **Hook line:** "My experience building FounderOS, a |
| j3 | jobhunt | FAIL | read_cv | 7.4s | That's a strong draft, Pushkar! It's concise, highlights your direct experience with multi-agent systems and LangGraph, and includes a clear call to action with your GitHub link and salary expectation |
| w1 | workflow | PASS | read_context | 4.5s | Alright, Pushkar, here's your weekly digest, straight from FounderOS.  **Current Focus:** Your plate is full with a triple threat: *   **FounderOS Launch:** The v2 rebuild is public and looking sharp. |
| w2 | workflow | HITL | search_web, record_event | 6.5s | Razorpay does not fit the ICP. Their ARR is $483.1M, which is much higher than our target of $50K–500K ARR. They are also based in Bengaluru, India, not the EU or US. |
| w3 | workflow | FAIL | — | 1.8s | Alright, onboarding TestStartupCo! What kind of event is this (e.g., `client_onboarded`, `project_started`) and can you give me a brief summary of what's happening? |
| q1 | direct | PASS | search_web | 23.1s | Here are 10 Y Combinator W25 companies that could benefit from AI automation, based on the research:  *   **Abundant:** Building software for farmers. AI can automate monitoring, optimize resources, p |
| q2 | direct | HITL | run_shell | 4.4s | — |
| q3 | direct | FAIL | project_workflow | 7.1s | — |
| mt1 | memory | PASS | read_context | 2.7s | This session has been focused on understanding your current business context and priorities. Here's a summary:  **Current Focus:** *   FounderOS launch *   Job search (AI/agent engineering roles) *    |
| mt2 | memory | PASS | — | 5.7s | Alright, Pushkar, based on our discussion and your current context, here are your top 3 priorities with specific next actions for tomorrow morning:  1.  **Advance Job Applications:**     *   **Action: |

## Failures

### c2 — comms

**Input:** Draft a reply to my latest email saying I'll get back to them by Friday.

**Validation:** Expected HITL interrupt but none fired

**Full reply:**
```
I couldn't draft that email for you. Comms reported a missing Gmail connection ID.

To fix this, please set the `COMPOSIO_GMAIL_CONN_ID` environment variable in your `.env` file. You can find the ID in `app.composio.dev` → **Connections** → **Gmail**.

Once that's done, I can help you draft the reply.
```

### c3 — comms

**Input:** I have a product demo call tomorrow. Create a calendar event titled 'Demo: Turicks AI Agency' at 3pm for 45 minutes, add a 5-point demo agenda in the description.

**Error:** `Cannot read properties of undefined (reading 'parts')`

### e1 — engineering

**Input:** Go to the pushkarverma3698/FounderOS GitHub repo. List all open issues, group them by theme, and tell me which 3 are most critical.

**Validation:** Expected github_read to be called

**Full reply:**
```
My apologies, it seems I don't have the specific functionality to list GitHub issues directly. The engineering department's `github_read` tool can list repositories, get READMEs, and repository statistics, but not issues.

Is there something else I can help you with regarding the `pushkarverma3698/FounderOS` repo, or perhaps another task?
```

### e2 — engineering

**Input:** What branches exist on the FounderOS repo? Which ones have been merged vs are still open?

**Validation:** Expected github_read to be called

**Full reply:**
```
I can list all branches on the FounderOS repo for you, but I cannot distinguish between merged and open branches with the tools I have.

Would you like me to list all branches?
```

### e4 — engineering

**Input:** Check the git log for the last 10 commits on FounderOS and give me a professional changelog grouped by: features, bugs, tests, docs.

**Validation:** Unexpected HITL interrupt fired

### m4 — marketing

**Input:** Research what AI founders are posting about on LinkedIn this week. What themes are performing well?

**Validation:** Unexpected HITL interrupt fired

### s4 — sales

**Input:** Record this sales call debrief: called Head of Product at Razorpay, discussed automating their sales outreach, interested in HITL feature, budget ~$2k/mo. Update my deal context.

**Validation:** Reply too short (< 50 chars)

### p2 — personal

**Input:** Read the last 50 lines of /tmp/founderos.log and tell me if there are any errors.

**Validation:** Reply too short (< 50 chars) — likely did not read the log

### j1 — jobhunt

**Input:** I want to apply to Anthropic. Go through my CV and identify my 5 strongest differentiators for an 'AI Engineer — Agents' role. Then search for their current openings and tell me: am I qualified, what gaps, what to emphasize.

**Validation:** Expected read_cv to be called

**Full reply:**
```
Got it. To help you with your Anthropic application, I need your CV. Could you please tell me the filename or where it's located on your system? Once I have that, I'll pass it to the personal department to retrieve it.
```

### j3 — jobhunt

**Input:** Draft a complete cover letter for a Senior AI Engineer role at a multi-agent systems startup. Base it on my actual CV. Max 250 words, no generic phrases, punchy opening.

**Validation:** Reply too short (< 300 chars) — likely no real CV content

**Full reply:**
```
That's a strong draft, Pushkar! It's concise, highlights your direct experience with multi-agent systems and LangGraph, and includes a clear call to action with your GitHub link and salary expectations.

Do you want me to record this cover letter draft in your memory, or do you have any revisions?
```

### w3 — workflow

**Input:** /run onboarding company=TestStartupCo

**Validation:** Expected HITL interrupt but none fired

**Full reply:**
```
Alright, onboarding TestStartupCo! What kind of event is this (e.g., `client_onboarded`, `project_started`) and can you give me a brief summary of what's happening?
```

### q3 — direct

**Input:** /q engineering Show me all open GitHub issues on pushkarverma3698/FounderOS sorted by recency

**Validation:** Unexpected HITL interrupt fired

## Format Issues

_All replies passed Telegram HTML validation._