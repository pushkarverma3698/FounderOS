# FounderOS — Agent Eval Report

_Generated: 2026-06-03T10:35:50.792Z_

A deterministic evaluation of the FounderOS multi-agent system against a fixed golden-task set.
Each task scores routing (did the supervisor pick the right department?), tool selection (did it
use the expected tools?), and HITL coverage (did write actions pause for approval when required?).

## Summary

| Metric | Passed | Total | Accuracy |
|---|---|---|---|
| Routing accuracy | 10 | 10 | 100% |
| Tool selection | 7 | 7 | 100% |
| HITL coverage | 9 | 9 | 100% |
| **Overall** | **10** | **10** | **100%** |

## Failures (0)

All golden tasks passed. ✅

## All tasks (10)

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
