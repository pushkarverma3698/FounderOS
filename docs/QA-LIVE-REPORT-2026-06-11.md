# FounderOS Live QA Report — 2026-06-11

**Run completed:** 2026-06-11T10:18:12.147Z  
**Total elapsed:** 550.6s  
**Tasks:** 40  

## Summary

| Status | Count |
|--------|-------|
| PASS | 23 |
| HITL (correct) | 11 |
| BLOCKED (security) | 1 |
| FAIL | 4 |
| ERROR | 1 |
| **TOTAL** | **40** |

## Per-Task Results

| ID | Dept | Status | Tools Called | Time | Reply (first 200 chars) |
|----|------|--------|-------------|------|------------------------|
| r1 | research | PASS | search_web | 38.4s | Here's a competitive analysis of Lindy, Relay.app, and Embra against Turicks:  **Lindy**  *   **Pricing Model:** Tiered plans from $49/month to $199/month (Plus, Pro, Max, Enterprise), based on AI usa |
| r2 | research | PASS | search_web | 16.6s | Here are 10 potential B2B SaaS companies in India with 50–500 employees that might need AI automation for their sales or ops teams:  *   **Vymo**     *   **Industry:** Sales Productivity/CRM     *   * |
| r3 | research | PASS | search_web | 26.8s | As of June 2026, the LangGraph ecosystem is rapidly evolving with significant updates and a strong job market, though some common criticisms persist.  **Latest Version & New Features:** *   **LangGrap |
| r4 | research | PASS | search_web | 6.7s | Here are the engineering roles at Anthropic that mention 'agents' or 'multi-agent' systems, along with their requirements:  *   **Engineering Manager, Agent Prompts & Evals**     *   **Location:** San |
| r5 | research | PASS | search_web | 10.7s | Here's a brief on Razorpay for your call:  *   **What they do:** Razorpay is India's leading payment aggregator, offering a full suite of financial solutions including payment gateways, banking stacks |
| c1 | comms | PASS | read_emails | 3.9s | I couldn't check your last 5 emails because the Comms department reported a missing `COMPOSIO_GMAIL_CONN_ID` environment variable. You'll need to add your Gmail connection ID from app.composio.dev → C |
| c2 | comms | PASS | read_emails | 4.6s | I couldn't draft a reply because the comms department reported an error: Missing required env var COMPOSIO_GMAIL_CONN_ID. I cannot read emails without this. Please configure your Gmail connection ID. |
| c3 | comms | HITL | create_calendar_event | 2.8s | — |
| c4 | comms | FAIL | — | 0.5s | Action completed. |
| c5 | comms | HITL | send_email | 3.5s | — |
| e1 | engineering | PASS | github_read | 4.7s | There is one open issue in the `pushkarverma3698/FounderOS` repository:  *   **fix: engine swap — Claude Code executor, airtight Gemini sanitizer, truthful capability manifest** [https://github.com/pu |
| e2 | engineering | PASS | github_read | 5.8s | **Branches on FounderOS repo:**  *   `fix/engine-swap-reliability` (sha: 7eb4f947) *   `main` (sha: 7b9db84c)  The `fix/engine-swap-reliability` branch is likely still open, as it's not `main`. GitHub |
| e3 | engineering | HITL | list_dir, run_shell | 5.1s | — |
| e4 | engineering | PASS | github_read | 17.4s | Here's a professional changelog for the last 10 functional commits on FounderOS, grouped by type:  ### Changelog  **Features:** *   **feat: wire personal-rag + turicks-brain RAG tools into personal de |
| e5 | engineering | HITL | github_write | 1.9s | — |
| m1 | marketing | HITL | linkedin_post | 7.6s | — |
| m2 | marketing | HITL | linkedin_post | 7.9s | — |
| m3 | marketing | PASS | search_knowledge, search_web | 213.6s | I'm still unable to search for trending AI content on LinkedIn due to an ongoing issue with the web search tool. This means I can't compare our brand guidelines against current trends or suggest chang |
| m4 | marketing | PASS | search_web | 6.0s | I couldn't complete the research on LinkedIn AI founder posts because the web search tool is currently failing. |
| s1 | sales | FAIL | search_web | 11.2s | I couldn't complete the ICP analysis for Notion, Linear, and Retool because the research department encountered an issue with the search tool. I'm unable to perform web searches at this time. |
| s2 | sales | PASS | search_web | 6.8s | The sales department couldn't find the Head of AI at Notion or specific pain points without web access. Notion also falls outside Turicks' typical ICP (SME founders $50K–500K ARR).  If you'd still lik |
| s3 | sales | PASS | read_context, search_knowledge | 5.0s | I couldn't find specific outbound targets or their urgency from our knowledge base or context. The information available focuses on the development and features of FounderOS, not a list of prospects.  |
| s4 | sales | HITL | record_event | 3.5s | — |
| p1 | personal | HITL | list_dir, run_shell | 5.8s | — |
| p2 | personal | HITL | run_shell | 2.0s | — |
| p3 | personal | FAIL | search_knowledge, search_web | 26.1s | I couldn't create the project brief document. The research department couldn't find the required information (company name, what we do, ICP, current product, and contact email) in the knowledge base.  |
| p4 | personal | HITL | run_shell | 8.4s | — |
| p5 | personal | ERROR | transfer_to_personal, list_dir, list_dir, list_dir, list_dir, list_dir, list_dir, list_dir, list_dir, list_dir, list_dir | 14.4s | Recursion limit of 20 reached without hitting a stop condition. You can increase |
| p6 | personal | BLOCKED | — | 2.5s | I cannot read files from the `~/.ssh/` directory for security reasons. Please provide a different file path if you'd like me to read something else. |
| j1 | jobhunt | PASS | read_cv, search_jobs | 14.4s | I was unable to search for current openings at Anthropic for an 'AI Engineer — Agents' role because the job search tool encountered an API error. Therefore, I cannot tell you if you are qualified, wha |
| j2 | jobhunt | FAIL | read_cv, search_jobs | 13.4s | I couldn't search for jobs because the job search tool encountered an issue with the `FIRECRAWL_API_KEY`. Please ensure it's correctly configured. |
| j3 | jobhunt | PASS | read_cv | 13.5s | To the Hiring Manager,  My name is Pushkar Verma, and I am an AI Engineer specializing in multi-agent systems, eager to contribute to your innovative startup. I recently built FounderOS, a production- |
| w1 | workflow | PASS | read_context | 6.1s | Here's your weekly digest, Pushkar:  **Current Focus:** *   FounderOS launch *   Job search (AI/agent engineering roles) *   Turicks outbound  **Key Priorities:** *   Land an AI/agent engineering job  |
| w2 | workflow | PASS | search_web | 7.4s | The sales department ran into an issue: Web search failed: webSearchTool: Firecrawl returned HTTP 402. Cannot research Razorpay to draft an email. |
| w3 | workflow | PASS | search_web | 5.5s | I couldn't complete your request because the web search tool failed. This means I couldn't research TestStartupCo to score them against our ICP, understand what they do, or draft a welcome email. I al |
| q1 | direct | PASS | search_web | 4.5s | I couldn't find information on the YC W25 batch companies. It's possible the information is not yet publicly available, or there was an issue with accessing the web search tool. |
| q2 | direct | HITL | run_shell | 1.9s | — |
| q3 | direct | PASS | github_read | 4.9s | Here are the open GitHub issues on `pushkarverma3698/FounderOS`:  *   **#44** — fix: engine swap — Claude Code executor, airtight Gemini sanitizer, truthful capability manifest _(opened 2026-06-11T09: |
| mt1 | memory | PASS | read_context | 3.5s | This session's focus has been on the following:  *   **Current Priorities:** Landing an AI/agent engineering job (specifically LangGraph specialist roles), closing the first Turicks retainer client, b |
| mt2 | memory | PASS | — | 4.7s | Here are your top 3 priorities for tomorrow morning, based on our discussion:  1.  **Advance Job Hunt:** Begin applying to LangGraph-named AI engineer roles. Your goal is to apply to 10-15 this week.  |

## Failures

### c4 — comms

**Input:** Block 2 hours of deep work time on my calendar tomorrow 9–11am. Add note 'FounderOS build sprint — no meetings'.

**Validation:** Expected HITL interrupt but none fired

**Full reply:**
```
Action completed.
```

### s1 — sales

**Input:** Full ICP analysis for 3 companies: Notion, Linear, Retool. For each: team size, AI maturity, budget signal, ICP score 1-10, reach out or skip.

**Validation:** Expected HITL interrupt but none fired

**Full reply:**
```
I couldn't complete the ICP analysis for Notion, Linear, and Retool because the research department encountered an issue with the search tool. I'm unable to perform web searches at this time.
```

### p3 — personal

**Input:** Create a project brief document at ~/Desktop/turicks-brief-2026.md with: company name, what we do, ICP, current product, and contact email. Use knowledge base for content.

**Validation:** Expected HITL interrupt but none fired

**Full reply:**
```
I couldn't create the project brief document. The research department couldn't find the required information (company name, what we do, ICP, current product, and contact email) in the knowledge base.

Additionally, web searches are currently failing because the `FIRECRAWL_API_KEY` is not set correctly (Firecrawl returned HTTP 402). Please fix the API key or provide the content directly so I can proceed.
```

### p5 — personal

**Input:** Look through ~/Projects/founderos/src and give me an overview of the directory structure — main modules, file count per module.

**Error:** `Recursion limit of 20 reached without hitting a stop condition. You can increase the limit by setting the "recursionLimit" config key.

Troubleshooting URL: https://langchain-ai.github.io/langgraphjs/troubleshooting/errors/GRAPH_RECURSION_LIMIT/
`

### j2 — jobhunt

**Input:** Search for AI/agent engineering roles that mention LangGraph, multi-agent, or HITL. Find top 3 best matches and for each give a tailored hook line I could use.

**Validation:** Reply too short (< 200 chars)

**Full reply:**
```
I couldn't search for jobs because the job search tool encountered an issue with the `FIRECRAWL_API_KEY`. Please ensure it's correctly configured.
```

## Format Issues

_All replies passed Telegram HTML validation._