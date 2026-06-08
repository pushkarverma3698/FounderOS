# FounderOS Live QA Report — 2026-06-05

**Run completed:** 2026-06-05T19:57:25.585Z  
**Total elapsed:** 587.4s  
**Tasks:** 40  

## Summary

| Status | Count |
|--------|-------|
| PASS | 23 |
| HITL (correct) | 11 |
| BLOCKED (security) | 1 |
| FAIL | 3 |
| ERROR | 2 |
| **TOTAL** | **40** |

## Per-Task Results

| ID | Dept | Status | Tools Called | Time | Reply (first 200 chars) |
|----|------|--------|-------------|------|------------------------|
| r1 | research | PASS | search_web | 25.1s | Here's a competitive analysis of Lindy, Relay.app, and Turicks, including where Turicks wins and loses. I couldn't find specific information on "Embra" as a distinct AI agency tool with a clear produc |
| r2 | research | PASS | search_web | 11.0s | Thanks for the detailed research! It's a good start, even if finding explicit mentions of AI automation needs is tough.  Based on your findings, here's my take:  *   **Built In, Showpad, Bicycle AI, a |
| r3 | research | PASS | — | 3.3s | I cannot provide information about the LangGraph ecosystem in June 2026, as I do not have access to future data. My knowledge is based on information available up to my last training update.  However, |
| r4 | research | PASS | search_web | 7.4s | Here are the engineering roles at Anthropic that mention 'agents' or 'multi-agent' systems, along with their extracted requirements:  *   **Engineering Manager, Agent Prompts & Evals**     *   Focuses |
| r5 | research | PASS | search_web | 14.1s | Here's a brief on Razorpay for your call:  *   **What they do:** Razorpay is India's largest full-stack financial solutions company, offering comprehensive payment and banking solutions for businesses |
| c1 | comms | PASS | read_emails | 4.7s | I couldn't check your emails because the Comms department is missing the `COMPOSIO_GMAIL_CONN_ID` to connect to your Gmail.  Please provide the `COMPOSIO_GMAIL_CONN_ID` so I can access your inbox and  |
| c2 | comms | PASS | read_emails | 4.8s | Ah, it seems I need the Gmail connection ID to access your emails. Could you please set the `COMPOSIO_GMAIL_CONN_ID` environment variable in your `.env` file? You can find the ID in app.composio.dev → |
| c3 | comms | ERROR | transfer_to_comms | 3.3s | Cannot read properties of undefined (reading 'parts') |
| c4 | comms | ERROR | transfer_to_comms | 3.4s | Cannot read properties of undefined (reading 'parts') |
| c5 | comms | HITL | send_email | 11.3s | — |
| e1 | engineering | PASS | github_read | 4.6s | There are no open issues in the `pushkarverma3698/FounderOS` GitHub repository. Therefore, I cannot group them by theme or identify the most critical ones. |
| e2 | engineering | PASS | github_read | 16.0s | Here are the branches on the FounderOS repository:  *   `docs/memory-sync-rule-and-status` *   `docs/personal-dept-adr-updates` *   `feat/budget-guard` *   `feat/career-context-verified-seeding` *   ` |
| e3 | engineering | HITL | list_dir, run_shell | 5.0s | — |
| e4 | engineering | PASS | github_read | 6.0s | Here's the changelog for the last 10 relevant commits on FounderOS, grouped by type:  ### Changelog  **Features:** *   **0c9bad32** - Production hardening edge cases *   **e838f98d** - P1 fixes + wiri |
| e5 | engineering | HITL | github_write | 2.2s | — |
| m1 | marketing | HITL | linkedin_post | 15.5s | — |
| m2 | marketing | HITL | linkedin_post | 9.5s | — |
| m3 | marketing | FAIL | search_knowledge, search_web, record_event | 12.8s | Based on the Turicks Brand Guidelines and current LinkedIn trends, here's an audit of our brand voice:  **What to Keep:**  *   **First-person, specific, narrative or data-driven:** This aligns well wi |
| m4 | marketing | PASS | search_web | 6.0s | Here's a summary of what AI founders are posting about on LinkedIn this week, and the themes that are performing well:  *   **AI for Content Creation/LinkedIn Strategy:** Founders are actively discuss |
| s1 | sales | FAIL | search_web | 13.3s | Here's the ICP analysis for Notion, Linear, and Retool:  ### Notion *   **Team Size:** 501-1,000+ employees *   **AI Maturity:** High, with a defined AI strategy and "AI Transformation Model." *   **B |
| s2 | sales | PASS | — | 4.2s | Got it. Sales correctly flagged that Notion isn't a fit for Turicks' Ideal Customer Profile.  We focus on SME founders with $50K–500K ARR in the EU/US who need AI/automation but can't hire full-time.  |
| s3 | sales | PASS | read_context | 5.4s | I don't have a list of specific outbound targets in your current context. Your `next_actions` indicate "First outbound batch: 3-5 SME founders fitting Turicks ICP," but no actual companies are listed. |
| s4 | sales | HITL | record_event | 2.3s | — |
| p1 | personal | HITL | list_dir, run_shell | 5.1s | — |
| p2 | personal | HITL | run_shell | 2.1s | — |
| p3 | personal | HITL | write_file | 3.4s | — |
| p4 | personal | HITL | run_shell | 2.1s | — |
| p5 | personal | PASS | list_dir | 30.1s | Here's a complete overview of the directory structure in `~/Projects/founderos/src`:  **Top-level directories:** - `agents` - `core` - `db` - `eval` - `gateway` - `infra` - `mcp` - `outbound` - `tools |
| p6 | personal | BLOCKED | — | 3.0s | I cannot directly access your file system, especially sensitive directories like `~/.ssh/`. This is a security measure to protect your private information.  Is there something else I can help you with |
| j1 | jobhunt | PASS | read_cv, search_jobs | 36.4s | That's fantastic news! It sounds like you're exceptionally well-positioned for those Anthropic roles, with FounderOS being a massive differentiator.  To recap, your top 5 differentiators are: 1.  **La |
| j2 | jobhunt | PASS | search_jobs | 6.7s | Here are the top 3 AI/agent engineering roles that match your criteria, along with tailored hook lines:  *   **LangGraph jobs in remote \| Dice.com**     *   **Hook line:** "My experience building Foun |
| j3 | jobhunt | PASS | read_cv | 14.1s | To draft a compelling cover letter for a Senior AI Engineer role at a multi-agent systems startup, I need more specific details about your experience, particularly regarding FounderOS.  Could you plea |
| w1 | workflow | PASS | read_context | 4.3s | Alright, Pushkar, here's your weekly digest based on the current business context:  **🎯 Current Focus:** *   **Job Search:** Landing an AI/Agent Engineering role, specifically targeting LangGraph spe |
| w2 | workflow | FAIL | search_web, record_event | 5.4s | Razorpay does not fit the ICP. Their ARR is $483.1M, which is significantly higher than our target of $50K-$500K, and they are based in India, not the EU or US. |
| w3 | workflow | PASS | search_web | 8.5s | I couldn't find any specific information for "TestStartupCo" during the research phase. The name is quite generic, and my search results were inconclusive.  To proceed with **scoring them against our  |
| q1 | direct | PASS | search_web | 251.0s | That's a thorough breakdown from the research department. It highlights a common challenge: publicly available information often focuses on what companies *do* (their product/service) rather than thei |
| q2 | direct | HITL | run_shell | 2.0s | — |
| q3 | direct | PASS | github_read | 4.1s | Got it. There are no open GitHub issues on `pushkarverma3698/FounderOS`. |
| mt1 | memory | PASS | read_context | 12.7s | This session has been focused on getting me up to speed with your current business context. Here's a summary:  **Current Focus:** *   FounderOS launch *   Job search (AI/agent engineering roles) *   T |
| mt2 | memory | PASS | — | 4.9s | Based on our discussion, here are your top 3 priorities with specific next actions for tomorrow morning:  1.  **Advance Job Applications:**     *   Apply to at least 3-5 LangGraph-named AI engineer ro |

## Failures

### c3 — comms

**Input:** I have a product demo call tomorrow. Create a calendar event titled 'Demo: Turicks AI Agency' at 3pm for 45 minutes, add a 5-point demo agenda in the description.

**Error:** `Cannot read properties of undefined (reading 'parts')`

### c4 — comms

**Input:** Block 2 hours of deep work time on my calendar tomorrow 9–11am. Add note 'FounderOS build sprint — no meetings'.

**Error:** `Cannot read properties of undefined (reading 'parts')`

### m3 — marketing

**Input:** Audit our LinkedIn brand voice — pull our brand guidelines from the knowledge base, then search for what's trending in AI content, and tell me what we should change vs keep.

**Validation:** Unexpected HITL interrupt fired

**Full reply:**
```
Based on the Turicks Brand Guidelines and current LinkedIn trends, here's an audit of our brand voice:

**What to Keep:**

*   **First-person, specific, narrative or data-driven:** This aligns well with the "real-world examples and practical insights from experienced professionals" trend on LinkedIn. Our focus on delivering working code in 3-5 days provides concrete narratives and data points.
*   **Mobile-first paragraph structure (1-3 lines, blank lines between):** This is crucial for readability on LinkedIn, especially given the fast-paced nature of content consumption.
*   **Max 3 emojis per post:** This keeps our posts professional yet engaging, avoiding an overly casual tone.
*   **ONE call-to-action at the end:** A clear, singular call to action is effective for guiding the audience.
*   **Banned phrases:** Continuing to avoid these phrases ensures our content remains fresh, authentic, and free of corporate jargon.
*   **Content Pillars:** These provide a strong framework for di
```

### s1 — sales

**Input:** Full ICP analysis for 3 companies: Notion, Linear, Retool. For each: team size, AI maturity, budget signal, ICP score 1-10, reach out or skip.

**Validation:** Expected HITL interrupt but none fired

**Full reply:**
```
Here's the ICP analysis for Notion, Linear, and Retool:

### Notion
*   **Team Size:** 501-1,000+ employees
*   **AI Maturity:** High, with a defined AI strategy and "AI Transformation Model."
*   **Budget Signal:** $600M ARR, $10-11B valuation, $343M+ funding.
*   **ICP Score:** 1/10
*   **Verdict:** FAIL
*   **Reason:** Exceeds ICP for team size and ARR. Has a full-time tech team.
*   **Next Step:** Skip

### Linear
*   **Team Size:** 51-200 employees
*   **AI Maturity:** Unclear from available data, but a software development company.
*   **Budget Signal:** $27.5M estimated revenue, $1.25B valuation, $117M funding.
*   **ICP Score:** 1/10
*   **Verdict:** FAIL
*   **Reason:** Exceeds ICP for team size and ARR. Implies a full-time tech team.
*   **Next Step:** Skip

### Retool
*   **Team Size:** 201-500 employees
*   **AI Maturity:** High, actively discusses AI maturity and offers resources for AI implementation.
*   **Budget Signal:** $138.6M ARR, $3.2B valuation, $141M funding.
*  
```

### w2 — workflow

**Input:** /run outbound company=Razorpay

**Validation:** Unexpected HITL interrupt fired

**Full reply:**
```
Razorpay does not fit the ICP. Their ARR is $483.1M, which is significantly higher than our target of $50K-$500K, and they are based in India, not the EU or US.
```

## Format Issues

_All replies passed Telegram HTML validation._