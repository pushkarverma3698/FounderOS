# AG-066: Brain recall check + session brief

**Plan:** [2026-10-27-second-brain-workflow.md](../plans/2026-10-27-second-brain-workflow.md)
**Base branch:** `beta` · **Branch:** `feat/brain-recall-check`
**Depth:** Lite (read-only brain tool, CI job, local hook; no schema change, nothing sent on the founder's behalf)

## Part A: recall check

1. `governance/brain-recall-golden.json`: 20 entries `{ "q": "...", "project": "founderos", "expect": "<substring of the expected source path or title>" }`.
   Start with the 3 probes in the plan; Claude supplies the other 17 in review.
2. `scripts/brain-recall-check.ts`: for each entry, call `searchBrain({ query, topK: 3, filters: { project }, table: "brain_memories" })`.
   A hit counts when any of the top 3 `source` values contains `expect`. Print one line per miss (question + what came back) and `recall@3 = N/20`.
   Exit 1 when N < `--min` (default: the baseline committed in the JSON).
3. Add a step to `.github/workflows/brain-sync.yml` after the sync step that runs it on the VPS.
4. Unit test with a scripted `searchBrain` (`pnpm test` stays $0): one passing set, one with a miss → exit 1 and the miss is printed.

## Part B: session brief

1. `recent_memories` in `src/mcp/brain-tools.ts`: args `project` (required) and `days` (default 7, max 30).
   Returns `memory_type`, date and the first line of each `decision` / `bug` / `note` row from that project, newest first, at most 15.
   Read-only. Excludes SUPERSEDED/ARCHIVED rows and rows with `visibility: founder` (reuse the `rag-search.ts` filters).
2. Unit test for the query builder: project filter, day window, exclusions.
3. `~/Projects/scripts/ai-tools/session-brief` (bash, `chmod +x`, README entry): print `gh pr list --author @me --state open --limit 8`
   for the current repo, then `recent_memories` through the hub HTTP endpoint, then the line
   `search_memory before non-trivial work; save_decision/save_bug after.`
   Total ≤ 30 lines. 3-second timeout per call; on failure print `brain unreachable` and exit 0.

## Done means

- `pnpm gate` green.
- Recall check run once on the VPS, output in the PR body (the baseline number).
- `session-brief` run once from a FounderOS worktree, output in the PR body.

## Checked first

`src/db/rag-search.ts` (status + visibility filters, hybrid RRF), `src/db/rag-recency.ts`, `src/mcp/hub-http.ts` (Streamable HTTP, token auth),
`.github/workflows/brain-sync.yml`. No existing recall check or recent-rows tool.
