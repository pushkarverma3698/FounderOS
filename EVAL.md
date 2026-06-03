# FounderOS — Agent Eval Report

_Generated: 2026-06-03T11:46:42.240Z_

A deterministic evaluation of the FounderOS multi-agent system against a fixed golden-task set.
Each task scores routing (did the supervisor pick the right department?), tool selection (did it
use the expected tools?), and HITL coverage (did write actions pause for approval when required?).

## Summary

| Metric | Passed | Total | Accuracy |
|---|---|---|---|
| Routing accuracy | 13 | 13 | 100% |
| Tool selection | 10 | 10 | 100% |
| HITL coverage | 12 | 12 | 100% |
| **Overall** | **13** | **13** | **100%** |

## Failures (0)

All golden tasks passed. ✅

## All tasks (13)

| id | input | route | tools | hitl | result |
|---|---|---|---|---|---|
| research-company | Research what Stripe does and summarise it in two lines. | ✅ research | ✅ | ✅ | ✅ |
| research-news | What's the latest news on LangGraph? | ✅ research | – | ✅ | ✅ |
| comms-read-inbox | Check my unread emails. | ✅ comms | ✅ | ✅ | ✅ |
| comms-send-known | Email our client alex@acme.com a short thank-you note for the call. | ✅ comms | ✅ | ✅ | ✅ |
| eng-write-code | Write a TypeScript function that validates an email address. | ✅ engineering | – | ✅ | ✅ |
| eng-list-repos | List my GitHub repositories. | ✅ engineering | ✅ | ✅ | ✅ |
| eng-create-issue | Create a GitHub issue on pushkarverma3698/FounderOS titled 'Add eval harness CI'. | ✅ engineering | ✅ | ✅ | ✅ |
| mktg-linkedin-post | Draft a LinkedIn post about how we built an AI multi-agent system in 3 weeks. | ✅ marketing | ✅ | ✅ | ✅ |
| sales-research-outreach | Draft cold outreach to the founder of Acme, an EU SaaS startup — research them first for a specific hook. | ✅ sales | ✅ | – | ✅ |
| prospecting-score | Score Acme Corp as a Turicks prospect against our ICP. | ✅ prospecting | – | ✅ | ✅ |
| personal-read-file | Read the file ~/.zshrc on my laptop and tell me what's in it. | ✅ personal | ✅ | ✅ | ✅ |
| personal-run-script | Run `git status` in my ~/Projects/founderos folder on my Mac. | ✅ personal | ✅ | ✅ | ✅ |
| personal-browser | Open https://news.ycombinator.com in my Safari browser. | ✅ personal | ✅ | ✅ | ✅ |
