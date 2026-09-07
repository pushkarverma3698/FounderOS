# 2026-09-06 — the brain MCP repointed, and why sessions keep dying mid-task

Continuation of [2026-09-05-branch-consolidation-audit.md](2026-09-05-branch-consolidation-audit.md).
That session was cut off by a usage limit at **10:34:37 UTC**, mid-sentence, on its
own last line: *"Verifying the replacement server actually works before repointing
anything at it."* The retry session (13:57 UTC) hit the limit again two seconds in
and produced nothing. This session resumed from that exact word.

## What we did

Recovered the stopping point from the raw transcripts
(`~/.claude/projects/<slug>/*.jsonl`) rather than from memory, then confirmed the
consolidation itself had in fact landed:

| check | result |
|---|---|
| prod `git rev-parse HEAD` | `7eb178f` (= #615) |
| `founderos.service` `ActiveEnterTimestamp` | 2026-09-05 10:28:38 UTC |
| prod `brain.brain_memories` | 1,352 rows, **0 with a NULL source** |
| prod HNSW index | `brain_memories_embedding_idx` present |
| remote branches / open PRs | 2 / 0 |

Migration `0038_brain_backfill.sql` reached prod and the backfill is intact. The
30% left over was outstanding item #2: the IDE brain MCP.

## What we fixed

**1. The brain MCP was dead in three IDE configs, not one.**

ADR-038 deleted `~/Projects/turicks-brain-rag`. Every config still spawned its
`.venv/bin/fastmcp`:

- `~/.claude.json` — Claude Code, `ENOENT` at every session start
- `~/.gemini/config/mcp_config.json` — Antigravity
- `~/.gemini/antigravity/mcp_config.json` — Antigravity

All three now point at `~/Projects/scripts/ai-tools/founderos-brain-mcp.sh`, a new
stdio launcher for `src/mcp/turicks-brain.ts`. Cursor was checked and has no brain
MCP at all (only `nano-banana`) — unchanged, but worth knowing.

The wrapper exists because a direct command does not survive an IDE spawn. Two
things break it, and both were verified by running the server under
`env -i PATH=/usr/bin:/bin`:

- nvm's `node` is not on a GUI process's PATH (`pnpm --dir … mcp:brain` fails with
  `env: node: No such file or directory`), and
- `--import tsx/esm` resolves from the working directory, which the editor owns.

**2. The MCP wrote its startup log to stdout.** First run of the wrapper returned
clean JSON-RPC followed by four lines of pino output *on stdout* — the JSON-RPC
transport. `src/infra/logger.ts:46` documents this exact hazard and `package.json`
guards it with `LOG_STDERR=1`; a launcher that forgets the variable silently
corrupts the stream. The wrapper now exports it, verified: stdout is two JSON-RPC
lines and nothing else.

**3. A Stop hook pointed at a deleted script.** `~/.claude/settings.json` ran
`~/Projects/turicks-brain-rag/scripts/stop-hook.sh` at the end of every turn. The
file has not existed since ADR-038. Removed — see Outstanding #1 for what should
replace it.

**4. `searchBrain` blamed the wrong component, in blank text.** Driving the
repointed MCP for real (local Postgres container down) returned:

```
Search failed at stage embed:
```

Two defects in one line, in ADR-038's "one retrieval implementation":

- **Wrong stage.** `searchBrain` wrapped `embedText` *and* `searchRagTable` in one
  `try` and tagged both `embed`. Ollama was up the whole time — `nomic-embed-text`
  answered on 11434. The database was the failure. The stage is what tells the
  reader which daemon to start, so it pointed the fix at the wrong subsystem.
- **Blank message.** Node reports a refused connect as an `AggregateError` over the
  IPv6 and IPv4 attempts, and that wrapper's own `.message` is `""`. `errText`
  returned it verbatim.

Fixed in `src/db/rag-hybrid.ts` (`errText` exported, recurses into
`AggregateError.errors`, falls back to `.name`) and `src/db/rag-search.ts`
(separate catches → `embed` vs `query`). Live path, same conditions:

```
Search failed at stage query: connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432
```

## Why

A brain outage that reads as blank is the 2026-08-07 shadow-table failure wearing
a different mask: retrieval that is dead but looks merely unhelpful. That one cost
weeks. The whole point of the FailureReport contract is that a failure names its
real component, and the single entry point every IDE now depends on was the one
place not doing it.

Both handoffs on the brain branch had reported "100% VERIFIED & GREEN", and the
gate genuinely was green through all of it — 3,742 tests. No mocked suite can see
that a wrapper forgot an env var, that a config points at a deleted binary, or
that a `try` block spans two stages. Only running the thing showed it.

## The session-loss audit

The founder's question — *why does our chat get lost every time?* — has a measured
answer, and it is not context overflow. Nothing was ever compacted or truncated.

**1. The killer is the 5-hour usage window.** Both transcripts end on the literal
string `You've hit your session limit · resets 8:20pm (Asia/Calcutta)`.

**2. On 2026-09-05, 90% of that window went to a different project.** Billable
input (cache-creation) tokens for the day, from the transcript `usage` records:

| project | sessions | cache-write tokens | share |
|---|---|---|---|
| linkedin-growth-engine | 4 | **7,971,577** | **90.1%** |
| founderos | 2 | 872,062 | 9.9% |

Cache reads tell the same story (249.0M vs 74.2M). One linkedin session
(`2d8abf96`) wrote 4.8M tokens on its own — more than five times the entire
FounderOS day. The consolidation session did not run out of room; it ran out of
budget that had already been spent elsewhere, and the two were running
concurrently.

**3. Every session costs 67k–99k tokens to say hello.** First-API-call prompt size:

| session | tokens before the first word |
|---|---|
| `7f57dde8` | 99,224 |
| `82d6ad24` (the one that died) | 80,424 |
| `41b638b0` | 67,417 |

Roughly 24.5k of that is always-loaded markdown, measured:

| source | bytes | ~tokens |
|---|---|---|
| `~/.claude/rules/ecc/**` (24 files) | 30,534 | 7,633 |
| global `~/.claude/CLAUDE.md` | 24,986 | 6,246 |
| project `CLAUDE.md` | 21,090 | 5,272 |
| auto-memory `MEMORY.md` | 16,181 | 4,045 |
| SessionStart hook (`using-superpowers`) | 5,421 | 1,355 |

The remaining ~55k is the tool and skill surface: **19 MCP servers** configured
across `~/.claude.json` (9) and `~/.claude/settings.json` (10), and **111 skills**
advertised. At `effort: xhigh` on Opus 5 this is re-read on every turn.

**4. Ten of those 19 MCP servers fail to connect** — all five `composio-*`, plus
`founderos`, `turicks-brain` (until today), and `plugin:data:definite`. They cost
startup latency and log noise and return no capability.

**5. Nothing persisted the session.** The Stop hook meant to write conversations
into the brain had pointed at a deleted script since ADR-038.
`scripts/ingest-claude-sessions.ts` reads `~/.claude/projects/<slug>/*.jsonl`
correctly and is wired to `pnpm ingest:claude` — and to no schedule. When a session
dies, hand-reading the JSONL is the only recovery, which is exactly what this
session had to do.

## Metrics

| | |
|---|---|
| `pnpm gate` | **exit 0** — 342 files · **3,747 tests** |
| Baseline (#615 head) | exit 0 — 341 files · 3,742 tests |
| Tests added | 5 (3 stage attribution, 2 AggregateError legibility) |
| RED verified before fix | 4 failures |
| IDE configs repointed | 3 (1 Claude Code, 2 Antigravity) |
| Dead hooks removed | 1 |
| Scripts added | `~/Projects/scripts/ai-tools/founderos-brain-mcp.sh` |
| Session-limit kills reconstructed | 2 (10:34:37 and 13:57:55 UTC, 2026-09-05) |

## Outstanding

1. **Session persistence is unscheduled.** `pnpm ingest:claude` is the correct
   replacement for the removed Stop hook, but running a full embed pass at every
   turn's end is the wrong shape for it. It wants a cron/launchd entry, not a hook.
   Founder decision — it writes to the brain.
2. **`scripts/sync-conversation-session.ts` documents a path it never reads.** Its
   header claims it ingests "Claude Code logs (`~/.claude/logs`)". That directory
   does not exist and the code never references it — the script is
   Antigravity-only. The Claude half is `ingest-claude-sessions.ts`.
3. **The main checkout is parked on a merged, deleted branch.**
   `/Users/pushkarverma/Projects/founderos` sits on `cursor/feat-unified-postgres-brain`
   at `b396416`. Antigravity was live in that tree during this session
   (`agy-guard` exit 1), so it was left alone. The brain MCP runs from this path,
   so until it returns to `main` the IDE brain runs pre-review code.
4. **The local Postgres container is down**, so on this laptop the repointed MCP is
   verified only as far as a correct, legible connection error — end-to-end
   retrieval is **NOT VERIFIED here**. It *is* verified on prod, where Postgres and
   Ollama are both up: after the deploy of `525db32`, `search_memory` over
   `brain.brain_memories` returned a real scored hit —

   ```
   --- Result 1 (Score: 0.711) ---
   Type: session | Source: docs/sessions/2026-09-05-branch-naming-and-instruction-audit.md
   ```

   which exercises the whole chain at once: Ollama embed → HNSW index → the
   unified table #615 repointed → the backfill's coalesced metadata (`entry_type`
   and `source_path` both populated) → the MCP tool. The laptop needs only Docker.
5. Items 1, 3, 4 and 5 of the 2026-09-05 outstanding list (`opencode.ts` fork,
   `eval-brain.ts` measures no recall, `opencode-ai` installed on the VPS,
   `omni_router/` outside `docs/`) are untouched and still open.
