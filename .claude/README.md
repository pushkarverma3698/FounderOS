# `.claude/` — Agent Governance Map

This folder is the machine-context layer. **It does not restate rules** — it points to the
single authoritative source for each concern. If two places seem to disagree, the source in
the **Authoritative** column wins; the other is stale and should be fixed.

## Authoritative sources (the constitution)

| Concern | Authoritative source | Notes |
|---|---|---|
| Non-negotiable rules | [`/CLAUDE.md`](../CLAUDE.md) | Precise directives, each linking its ADR. Loaded every session. |
| Wiring maps (tool/dept/workflow/command) | [`docs/rules/PROGRAMMING-RULES.md`](../docs/rules/PROGRAMMING-RULES.md) | Exact file-touch sequence + forget→error tables. |
| Tool / test / review bars | [`docs/rules/`](../docs/rules) | `TOOL-STANDARDS`, `TESTING-RULES`, `CODE-REVIEW-CHECKLIST`. |
| Architectural decisions (the "why") | [`docs/decisions/`](../docs/decisions) | 40 ADRs. A decision here cannot be silently re-decided. |
| Doc index | [`docs/README.md`](../docs/README.md) | Master map of all docs. |
| Session status / changelog | `MEMORY.md` (auto-memory) | **Not** `CLAUDE.md`. See Memory below. |
| Brand voice | [`brand/TURICKS.md`](brand/TURICKS.md) | Applied to all outbound copy. |

## What lives in this folder

| Path | Purpose |
|---|---|
| `README.md` | This map. |
| `graph.json` | Knowledge graph: departments→agents→tools. **Query before grepping** (~70× fewer reads). |
| `graph-mermaid.md` | Human-readable graph render. |
| `GRAPHIFY-INTEGRATION.md` | How the graph is generated/used. Regenerate: `pnpm graph:gen`. |
| `graphify-hook.ts` | `preToolUse` hook (wired in `settings.json`) that enriches Read/Grep/Glob/Explore with graph context. |
| `settings.json` | Committed hook + env config. |
| `settings.local.json` | Local-only overrides (not the source of truth for shared rules). |
| `brand/` | Brand guidelines (`TURICKS.md`). |
| `skills/` | Project-scoped skills (Apify Actor toolkit). |
| `memory/MEMORY.md` | **Archived v1-era session log.** Stale — see Memory below. |
| `launch.json`, `worktrees/` | Local tooling scaffolding. |

## Memory — which `MEMORY.md` is canonical

There are two files named `MEMORY.md`. They are **not** interchangeable:

- ✅ **Canonical (live):** the auto-memory at
  `~/.claude/projects/-Users-pushkarverma-Projects-founderos/memory/MEMORY.md`.
  Loaded into context each session; this is the current status / gotchas / file-location index.
- 🗄️ **Archived:** `.claude/memory/MEMORY.md` is a committed snapshot from the **v1 era (2026-05-28)**.
  It predates the v2 ReAct rebuild and references superseded concepts (pods, registry critic).
  Kept for history only — **do not treat it as current state.**

When you update memory at end of a session, update the **canonical** auto-memory (rule #25 in `CLAUDE.md`).
