# Second brain for the coding agents (2026-10-27)

**Status:** Proposed. Needs a founder yes before step 3.
**Brief:** [AG-066](../antigravity/AG-066-brain-recall-check-and-session-brief.md)

## Outcome

Every agent session (Mac, VPS, Antigravity, any repo) starts knowing where the work stands and gets
the current rule when it asks, not a stale one. Measured by one number: recall@3 on a fixed set of
questions with known answers.

## What exists (audited 2026-10-27)

| Piece | State | Evidence |
|---|---|---|
| File memory (`~/.claude/projects/-…-founderos/memory/`) | 211 files, 696 KB; 180 are `project` status snapshots; **94 are not linked from `MEMORY.md`**, so nothing ever reads them | `ls`, `grep` against the index |
| `MEMORY.md` index | 16.5 KB (~4K tokens) loaded into **every** session; the "In flight" block has 34 entries going back to 10-04 | `wc -c` |
| Postgres brain (`brain.brain_memories`) | Hybrid search (pgvector + keyword, RRF), recency weighting, SUPERSEDED/ARCHIVED filter, project tags | `src/db/rag-search.ts`, `rag-hybrid.ts`, `rag-recency.ts` |
| Brain writes | Working: ~14 sessions logged decisions and bugs with project tags since 10-01 | transcript search for `Decision saved (ID` / `Bug logged (ID` |
| Brain reads | Happen when a brief or routine file says "search_memory once"; nothing triggers them in interactive sessions | transcript search |
| Nightly `brain-sync` | Green 8/8 runs, 16–43 s | `gh run list --workflow=brain-sync.yml` |

### Three probes

| Question | Expected | Got |
|---|---|---|
| How is a beta→main promotion merged? | `--merge`, built as `origin/main` + `merge origin/beta`; Claude may merge on green | ADR-045 "founder merges in the GitHub UI" (stale) ranked first; the current rule is not in the top 3 |
| Do Recruitee forms have hCaptcha? | Yes, all of them (finding from 10-20) | Not found: the finding lives only in file memory |
| Pipe to tail hides the exit code? | `cmd > log 2>&1; echo $?` | Correct, top hit |

## Diagnosis

The search engine is fine. The problems are where facts are stored and whether they're fresh:

1. **Two stores with no bridge.** Lessons and findings written to Mac file memory never reach the brain,
   so VPS sessions, Antigravity and other repos can't see them.
2. **Stale content outranks current content.** Old ADRs and plans aren't marked superseded, so search returns them.
3. **"Where we are" is stored as memory, and it rots.** The "In flight" snapshots repeat what PRs and issues
   already say, go stale within days, and cost ~4K tokens per session.
4. **Nothing measures recall**, so none of this was visible (CLAUDE.md #27).

## Plan: one home per kind of fact

| Kind of fact | Home | Why |
|---|---|---|
| How to work (rules, feedback) | `~/.agents/AGENTS.md` + repo CLAUDE.md; file memory only for Claude-specific feedback | Already loaded by every agent |
| Decisions, bugs, findings | Postgres brain | The only store every agent can reach |
| Where we are right now | Computed at session start from GitHub + the brain's last 7 days | Fresh by construction, never written by hand |

### Steps

1. **Prune file memory** (local, reversible, ~30 min). Move the 94 orphans and every `project` snapshot older
   than 14 days to `memory/archive/`. Push still-true findings to the brain with `remember` first. Cut the index
   to feedback + user entries + at most 8 in-flight lines (target ≤ 60 lines, under 1.5K tokens).
2. **Mark stale docs superseded** (docs PR, ~1 h). Run the 20 probe questions (step 3). Every stale doc that
   outranks the current rule gets a `**Status:** Superseded by …` line. Start with
   [ADR-045](../decisions/045-retire-stable-tier.md): its "founder merges" step predates the current promotion rules. Trigger
   `brain-sync` after merge.
3. **Recall check** (AG-066 part A, ~2 h). `scripts/brain-recall-check.ts` plus
   `governance/brain-recall-golden.json`: 20 questions, each with the expected source. Runs after every
   nightly `brain-sync`; the workflow fails if recall@3 drops below the baseline. Costs $0 (local Ollama embeddings).
4. **Session brief** (AG-066 part B, ~2 h). New brain tool `recent_memories(project, days)`, plus a SessionStart
   hook (`~/Projects/scripts/ai-tools/session-brief`). The hook prints ≤ 30 lines: open PRs in the repo, the
   project's decisions and bugs from the last 7 days, and one line saying "search_memory before non-trivial
   work". This replaces the "In flight" block.
5. **One routing rule** in AGENTS.md: `project` facts go to the brain (`remember` / `save_decision` / `save_bug`),
   never to file memory. File memory keeps `user` and `feedback` only.

### Not doing (and why)

- **Nightly chat-transcript ingestion** (BRAIN-2.0 move 2): high volume, personal data, needs its own privacy
  review. Revisit only if recall@3 shows misses that transcripts would fix.
- **LLM context blurbs per chunk and a reranker** (BRAIN-2.0 move 1): hybrid search already works. Add them
  only if the recall check shows ranking misses after step 2.
- **A new memory product or vector DB**: none of the failures above is a storage problem.

## Strongest argument against

A SessionStart hook adds a network call (the hub on the VPS) to every session start. If the hub is down,
sessions start slower or without the brief. Mitigation: 3-second timeout; on failure, print one line
("brain unreachable") and continue.

## How we'll know it worked

- recall@3 on the 20 questions: baseline measured in step 3, target ≥ 18/20 after step 2.
- `MEMORY.md` ≤ 60 lines; 0 orphan files outside `archive/`.
- The three probes above all return the current answer in the top 3.
