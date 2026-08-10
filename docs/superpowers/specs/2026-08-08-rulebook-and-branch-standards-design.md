# Spec B2 — One rulebook, split by enforcement; branch standard; RAG for recall (2026-08-08)

## Problem

Four instruction files (`CLAUDE.md` 294 lines, `AGENTS.md` 195, `GEMINI.md`
66, `.cursorrules` 19 — 574 total) are hand-maintained in parallel and already
disagree on branch policy (`CONTRIBUTING.md:69` says cut from `beta`;
`CLAUDE.md` says Claude merges to `main` directly). Every agent loads all of
this on every task regardless of relevance.

Separately, `agents.agent_results` — the table built specifically to let one
agent see what another did — has `writeTaskOutcome()` to write it and
`getRecentOutcomes()` to read it, both fully implemented, **zero callers,
zero rows**. The coordination layer the founder is asking for already exists
and is wired to nothing.

And branch naming is currently agent-namespaced (`cursor/`, `gemini/`,
`claude/`, `integration/` — 8 of 28 branches), which encodes *who typed the
command* instead of *what the change is*. That's the clutter, not the tool
count.

## Goal

A rulebook where the machine-enforced 10% is small and always-loaded, the
advisory 90% is retrievable on demand through the RAG surface that already
ships, and agent coordination happens through GitHub (who's doing what, live)
plus the database (what got done, historical) — no new infrastructure.

## Where RAG helps vs. where it must not

RAG is the right tool exactly where the retrieval key is unknown in advance:

| Question | Tool | Why |
|---|---|---|
| "Has this already been built?" | RAG (`search_knowledge`) | Grep only finds it if you guess the name. Failed twice on record: `nextRecurrence` rebuilt from scratch (2026-07-29 incident in CLAUDE.md), `agent_results` sat unused. |
| "Which rule applies to this task?" | RAG (`search_memory`) | 574 lines preloaded, ~90% irrelevant per task. Retrieve the 5 that matter instead. |
| "What broke last time someone did this?" | RAG (`failure_lessons`, already exists) | Similarity search over past failures is exactly what embeddings are for. |
| "Is this branch name legal?" | Deterministic code (`verify-architecture.ts`) | A similarity score cannot gate a merge — needs a hard yes/no. |
| "Who is working on what right now?" | Git (branches, open PRs) | Exact and already visible to every agent with repo access; no retrieval needed. |
| "What's the precedence between two rules?" | Static file (Tier 1) | Precedence is a total order, not a ranked-by-similarity list. |

Rule: **binding rules are exact and tiny; advisory context is semantic and
large.** This kernel's core invariant is determinism (temp 0, pure routing
functions) — fuzzy *enforcement* would break that. Fuzzy *recall* costs
nothing and closes the exact gap that has already caused rework twice.

## Changes

### B2.1 — Tier 1 / Tier 2 split
- New `docs/RULES.md`, target ~40 lines: only rules that
  `scripts/verify-architecture.ts` (or another CI check) actually enforces —
  tombstones, the architecture-debt ratchet, import direction, the 400-line
  file budget, the `// allow-failopen:` tag requirement, HITL ordering,
  temp-0 determinism, and the new branch-naming rule below. Each line names
  its enforcing mechanism, per the founder's existing rule #27 ("a rule with
  no mechanism decays").
- `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules` are cut to ~15 lines
  each: point at `docs/RULES.md` for Tier 1, state "for anything else, query
  the brain via `search_memory`" for Tier 2. Content that is genuinely
  agent-specific (e.g. GEMINI.md's Antigravity delegation notes) stays in
  that file; duplicated general content is deleted, not copied.
- `docs/RULES.md` and `docs/antigravity/STANDARDS.md` are added to
  `scripts/sync-turicks-brain.ts`'s ingest list (it already walks
  `docs/decisions`, `docs/strategy`, `docs/phases`, `docs/architecture` —
  this is the same pattern, ~10 lines).

### B2.2 — Branch naming standard
- Format: `<type>/<kebab-description>`. Types: `feat fix chore docs test ci
  refactor`. No agent-namespaced prefixes (`cursor/`, `gemini/`, `claude/`,
  `integration/` are retired as prefixes — the git author/committer field
  already records who made the commit; the branch name doesn't need to).
- Enforced by a new check inside `scripts/verify-architecture.ts` (extends
  the existing ratchet mechanism rather than adding a parallel checker):
  runs against `github.head_ref` in CI, exempts `main`/`beta`, fails the PR
  with the expected pattern in the error message.
- Documented once, in `docs/RULES.md` Tier 1 — this is a CI-enforced rule by
  definition, so it belongs there and nowhere else.

### B2.3 — Wire the existing coordination table
- `writeTaskOutcome()` gets a real caller: after each subagent-driven-development
  task completes (or, at minimum, after each CI-verified merge to `main`),
  write one row — `agent_id` (`claude` | `antigravity` | `cursor`), task
  summary, outcome, evidence link (commit SHA / PR URL).
- `getRecentOutcomes()` gets a real caller: surfaced through the MCP
  `search_memory` tool (already exists in `src/mcp/server.ts`) so any agent
  — not just the one that wrote it — can ask "what did someone else just do
  here" before starting work. No new table, no new server.
- This directly implements the founder's answer: GitHub (branches/PRs) shows
  *who's doing what now*; the database shows *what was done*, queryable by
  every agent through the MCP surface that already exists.

## Non-goals

- Not building a new memory store, message bus, or lock/claim system.
  `agent_results` + git branches already cover "what happened" and "who's
  active" — building more on top before the existing pieces are even wired
  would be exactly the kind of unrequested infrastructure CLAUDE.md's
  "No Over-Ambition" rule prohibits.
- Not rewriting `docs/antigravity/STANDARDS.md` itself — only adding it to
  the ingest list. Its content is out of scope here.
- Not touching the `beta` promotion workflow in this spec (flagged in Spec A
  as an open question; resolving `CONTRIBUTING.md` vs `CLAUDE.md` is a
  founder decision, not implied by "simplify CI/CD").

## Testing

- `verify-architecture.ts` unit tests cover: legal branch name passes,
  illegal name fails with the expected message, `main`/`beta` exempted.
- `sync-turicks-brain.ts`: dry-run confirms `docs/RULES.md` and
  `docs/antigravity/STANDARDS.md` appear in the ingested doc list.
- Manual: `search_memory("branch naming")` returns `docs/RULES.md` content
  post-ingest (live-checked once, not per-CI-run — ingestion is a `brain:sync`
  operation, not a test-suite concern).
- `writeTaskOutcome` / `getRecentOutcomes`: unit test with a fake DB row —
  write then read back, confirms the wiring, not the DB itself.

## Open questions

None blocking — this spec is intentionally the minimal wiring of what
already exists plus one small enforcement addition.
