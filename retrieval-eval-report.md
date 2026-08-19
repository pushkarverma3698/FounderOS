# FounderOS — Retrieval Eval (recall@k + MRR)

_Generated: 2026-08-19T15:13:51.767Z_

**Trustworthy run.** recall@5 = 100.0%, MRR = 0.843 over 25 golden queries.

## Metrics

| Metric | Value | Computed over |
|---|---|---|
| recall@5 | 100.0% | 25 scored queries |
| MRR (top-5) | 0.843 | 25 scored queries |

## What was measured

- Corpus (`brain.turicks_brain`): 478 chunks across 113 distinct documents
- Golden cases run: 25 (25 scored, 0 errored)
- Cutoff: top-5 chunks, projected to the distinct documents the agent would see
- Retrieval mode per query: 25 hybrid

## Misses (0)

Every expected document was retrieved within top-k.

## All cases (25)

| case | recall@5 | rank of first expected doc | retrieval mode |
|---|---|---|---|
| adr-langgraph | 100.0% | 1 | hybrid |
| adr-drizzle | 100.0% | 1 | hybrid |
| adr-telegram-hitl | 100.0% | 1 | hybrid |
| adr-redis-cache | 100.0% | 2 | hybrid |
| adr-linkedin-ban-risk | 100.0% | 1 | hybrid |
| adr-bounded-history | 100.0% | 1 | hybrid |
| adr-personal-rag-readonly | 100.0% | 1 | hybrid |
| adr-job-application-submit | 100.0% | 1 | hybrid |
| adr-kill-switch | 100.0% | 1 | hybrid |
| adr-claude-judge | 100.0% | 2 | hybrid |
| adr-daily-budget | 100.0% | 1 | hybrid |
| adr-account-registry | 100.0% | 1 | hybrid |
| adr-apify-research | 100.0% | 1 | hybrid |
| adr-mcp-bridge | 100.0% | 1 | hybrid |
| adr-checkpoint-ttl | 100.0% | 1 | hybrid |
| adr-retire-stable-tier | 100.0% | 1 | hybrid |
| adr-operating-model-freeze | 100.0% | 2 | hybrid |
| strategy-pricing-floor | 100.0% | 1 | hybrid |
| strategy-gtm-channels | 100.0% | 4 | hybrid |
| strategy-nl-target-companies | 100.0% | 2 | hybrid |
| rules-tool-standards | 100.0% | 3 | hybrid |
| rules-test-pyramid | 100.0% | 2 | hybrid |
| postmortem-eval-outputmode | 100.0% | 1 | hybrid |
| rca-prod-hardcore-qa | 100.0% | 1 | hybrid |
| recovery-failure-ledger | 100.0% | 1 | hybrid |
