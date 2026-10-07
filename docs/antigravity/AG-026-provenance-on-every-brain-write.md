# AG-026 — Every brain write records who wrote it, from where, when, and who may read it

**Source:** [docs/plans/2026-10-06-one-brain-context-audit.md](../plans/2026-10-06-one-brain-context-audit.md), H3 (write side), F2, F3.
**Branch:** `task/issue-<N>-brain-write-provenance`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full. It changes a cross-machine contract (the MCP hub) used by every agent.
**Moves:** B. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

Every row in `brain.brain_memories` can answer: which agent wrote this, on which machine, when did it happen, and may
a group chat see it. Recency ranking works for agent-written rows too.

## Problem / observed behavior

- `src/mcp/brain-write-args.ts:11`: every MCP write sets `source: "ide_mcp"`. Claude Code, Codex, Gemini, Cursor and
  Antigravity are indistinguishable (`src/mcp/hub-server.ts:4-7`). Metadata keys in prod: `tags`, `company`, `scope`, `role` only.
- `src/db/rag-recency.ts:26-29`: `docDateMs` reads a date only from a `YYYY-MM-DD` file-name prefix. Agent rows have none, so
  they get weight 1 forever and never age.
- 21 of 166 agent rows have `project = null`, which hides them from every project-scoped search (`src/db/rag-search.ts:116`).
- `src/db/brain-ingest.ts:74`: if Ollama is down the embed throws and the write fails. The agent gets an error, which is
  correct. Keep it loud.

## Expected behavior

1. A typed `BrainProvenance` (Zod, in `src/db/brain-ingest.ts` or a sibling file):
   `{ origin: "mac-claude"|"mac-agy"|"vps-claude"|"vps-agy"|"vps-daemon"|"telegram"|"docs"|"agent", client?: string,
   machine?: string, session_id?: string, repo?: string, occurred_at: ISO string, visibility: "founder"|"all" }`.
   `brainIngest` merges it into `metadata`.
2. The hub reads `BRAIN_CLIENT` and `BRAIN_MACHINE` from its environment. The SSH wrapper sets them; see the
   founder-side step below. Missing → `origin: "agent"`, `client: "unknown"`. MCP write tools accept optional
   `session_id` and `repo` arguments.
3. `occurred_at` defaults to now. `visibility` defaults to `all` for decisions and bugs and `founder` for `remember` notes.
4. A write without `project` still saves. The tool reply says: `Saved without a project tag: project-scoped searches
   will not find it. Pass project (founderos, oplify, …).`
5. `docDateMs` falls back to `metadata.occurred_at` when the file name has no date.
6. Existing rows are not rewritten. The AG-025 renderers already fall back for rows without `origin`.

## Evidence

Read 2026-10-06 on `origin/main` at `f74e3262`. Metadata keys measured in prod the same day.

## Files or subsystem in scope

`src/db/brain-ingest.ts`, `src/mcp/brain-write-args.ts`, `src/mcp/brain-tools.ts` (write cases only),
`src/mcp/hub-server.ts` (env read only), `src/db/rag-recency.ts`, tests under `tests/unit/db/` and `tests/unit/mcp/`.

## Constraints

- No schema migration: provenance lives in `metadata` (jsonb). A column is a later decision, once queries need an index.
- The Antigravity VPS bundle `/opt/agent-rules/brain-mcp.mjs` is built from this code. Note in the PR body that it must be
  rebuilt after deploy, and with which command (find it; don't guess).
- Write tools stay idempotent on `source_id` (sha256 of content, `src/db/brain-ingest.ts:32`).

## Explicitly forbidden

- Rejecting writes without a project. A lost memory is worse than an untagged one.
- Backfilling or editing existing prod rows in this PR.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/db tests/unit/mcp
```

## Acceptance criteria

- Unit test: a write with `BRAIN_CLIENT=claude-code BRAIN_MACHINE=mac` stores
  `metadata.origin = "agent"`, `client = "claude-code"`, `machine = "mac"` and an `occurred_at`.
- Unit test: `docDateMs({ occurred_at: "2026-09-01T10:00:00Z" })` returns that date.
- Founder-side step, written in the PR body. Done by Mac Claude after merge, not by the PR: each MCP client config passes its
  own `BRAIN_CLIENT` through `~/Projects/scripts/ai-tools/founderos-brain-mcp.sh`.
- Live path: one `save_decision` from Mac Claude after deploy. The row's metadata shows the client. If not run: NOT VERIFIED.
