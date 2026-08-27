# Analysis SQL

Read-only queries against the production database. Committed so every number published in
`docs/` can be regenerated rather than trusted.

```bash
ssh founderos-vps 'sudo -n docker exec -i founderos-postgres psql -U founderos -d founderos' < scripts/sql/<file>.sql
```

| file | what it produces |
|---|---|
| `market-skill-frequency.sql` | Skill-demand frequency across AI-track job postings — 92 terms in 9 categories, counted with word-boundary regex over full posting descriptions. Backs §2 of [MARKET-2026-AI-ENGINEER.md](../../docs/study/MARKET-2026-AI-ENGINEER.md) |
| `market-cuts.sql` | Titles, seniority, NL-vs-India deltas, the agents/eval/production co-occurrence, sponsor + salary posture, weekly discovery volume, top hiring companies. Backs §1 and §3–§5 |
| `prod-metrics.sql` | Operating metrics: LLM call volume and cost by model, HITL approval outcomes, executed side effects, RAG corpus size. Backs the "Proof, in production" table in the root [README](../../README.md) |

**These are reads.** Nothing here writes, and `agents.job_applications` descriptions are
third-party posting text — treat any extract as quotable data, not as content to republish.

Two caveats that belong with the numbers, not buried:

- Weekly posting counts in `market-cuts.sql` §7 are confounded by the board registry expanding
  from 285 to 623 sources on 2026-08-20. Ratios are signal; absolute weekly growth is not.
- `prod-metrics.sql` counts rows, so it measures what the system *recorded*. Where a code path
  fails to write its row, the metric under-reports rather than erroring.
