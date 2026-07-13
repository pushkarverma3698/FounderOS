# ADR-041 — External MCP Client Bridge (agents consume external MCP servers)

**Status:** Accepted · **Date:** 2026-06-26 · **Phase:** D→E (Revenue / Portfolio)

## Context
FounderOS was an MCP **server** only (`src/mcp/server.ts` — 6 read-only tools exposed to
external clients like Claude Code). Agents had **no** way to *consume* external MCP servers.
Every new external capability meant hand-writing a native tool through the 6-layer wiring map.

Two real pains forced a different path:

1. **Composio is our single biggest fragility.** It is the shared client behind Gmail +
   LinkedIn + Calendar, so one bad `COMPOSIO_API_KEY` takes down **three departments at once**
   (LIMITATIONS §7; the 2026-06-25 audit found email down in prod partly from this). Expanding
   Composio doubles down on the fragile spot and is a weak portfolio signal.
2. **Hand-rolling direct APIs for the long tail is the wrong cost.** Social and tool-style
   integrations are OAuth refresh dances, per-platform rate limits, and API-version churn (we
   already burned time bumping LinkedIn to `202506`). That is plumbing we'd own forever.

Meanwhile the founder's real want — "an agent should be able to drive Blender to make 3D, or
Slack to message, without me writing a tool per app" — is exactly what MCP solves. Mature MCP
servers already exist for Blender, Slack, Notion, Discord, and 20+ more.

This updates ADR-037 §4 ("native tool, not MCP; MCP reserved for Gmail/Drive/GitHub"): MCP is
now **the** mechanism for the external long tail. Native tools remain the right choice for
revenue-critical, daily-dependency, budget-sensitive paths (research/Apify, sends).

## Decision
1. **MCP client bridge** via `@langchain/mcp-adapters` (`MultiServerMCPClient`). One bridge →
   many servers, declared in `mcp-bridge.json` (Zod-validated, `src/mcp/bridge-manifest.ts`).
   Flag-gated by `MCP_BRIDGE_ENABLED` (default **false**) so the default build is byte-identical
   and never even loads the adapter (dynamic import in `applyMcpBridge()`).
2. **HITL classification = explicit per-server `write` allowlist, never a heuristic** (rule
   #13/#16). A tool is a write *only* if its bare name appears in that server's `write` array
   (`isWriteTool`, `src/mcp/bridge-classify.ts`). Inferring "writes" from names like
   `post`/`send`/`create` was rejected: one missed classification = an ungated external send.
3. **Same safety contract as native write tools.** `gateMcpTool`
   (`src/agents/agent-tools/external-mcp.ts`) wraps each loaded tool: reads pass straight
   through inside a stage-tagged error boundary; writes run `idemKey` → `hasBeenAudited` →
   `hitlGate()` → side effect → `writeAuditEntry()`, with the pure idempotency work BEFORE the
   gate so it replays cleanly on `interrupt()` resume (rule #6/#7).
4. **Collision-free naming.** Bridged tools are renamed `mcp__<server>__<bareName>` so they can
   never clash with a native tool, while the manifest allowlist keeps matching on the friendly
   bare name. The adapter's own prefixing is disabled so we own naming.
5. **Failure isolation** (rule #12, mirrors `getGraph()` connect-once). One client with
   `onConnectionError:"ignore"` plus a per-server try/catch around tool loading: a dead external
   server contributes **zero** tools and logs a warning — it never aborts boot or another server.
   This is strictly better blast-radius than Composio's one-key-three-departments cascade.
6. **Composio: keep as-is, migrate later.** No expansion, no migration in this change. Gmail/
   LinkedIn/Calendar keep running on Composio; social moves to MCP opportunistically.

## Consequences
- Adding an external capability goes from "write a native tool (6 layers)" to "add a server to
  `mcp-bridge.json` + set env + restart". See the wiring map in PROGRAMMING-RULES.
- Writes from external servers are gated and audited identically to native sends — HITL safety
  is preserved end-to-end, which is why the bridge is more than "wrap and done".
- Seed servers: **Blender** (`execute_blender_code`, `render_image` gated → personal) and
  **Slack** (`slack_post_message`, `slack_reply_to_thread` gated → comms). Notion was dropped —
  Apify (ADR-037) already lands research in the DB, so a Notion research store is redundant.
- Portfolio signal: "FounderOS speaks MCP natively — agents compose Blender, Slack, and 20+
  external servers through one typed client bridge with HITL preserved."

## Verification
Unit ($0, mocked): manifest validation, read/write classification, write-gating + rejection +
idempotency, per-server failure isolation, flag-off no-op (`tests/unit/mcp/*`). Flag-off keeps
`DEPARTMENT_TOOLS` unchanged (existing `capabilities.test.ts` stays green). Local probe: point
the manifest at `@modelcontextprotocol/server-everything`, flip the flag, confirm reads load and
a "write" tool triggers an interrupt — no API keys needed. MTProto QA once: Blender read passes
through; `execute_blender_code` fires the approval card → approve → `action_log` row written.

## Amendment — 2026-07-13 (Tier 0 + Tier 1: enable + hosted-remote transport)
Follow-up from `docs/research/MCP-CONNECTOR-ECOSYSTEM.md`. The bridge shipped
`stdio`-only, which excluded the entire hosted-remote ecosystem (the ~256
OAuth/HTTP servers — Notion, Linear, Stripe, DeepWiki…) that make external
capabilities zero-install. Two changes, no kernel impact:

- **Tier 0 (enable).** `MCP_BRIDGE_ENABLED` is now documented in `.env.example`
  and flipped on per deployment — no code change, the bridge was already built.
- **Tier 1 (transport).** `mcpServerSchema` becomes a discriminated union on
  `transport`: the existing `stdio` member is unchanged (entries that omit
  `transport` still default to stdio — backward-compatible), plus a new `http`
  member `{ url, headers, headerEnv }` for streamable-HTTP servers via
  `@langchain/mcp-adapters` (already a dependency). Secrets stay out of the
  manifest exactly as stdio does it: `headerEnv` maps a header name → an env-var
  NAME, resolved from `process.env` at connect time (`toConnection`,
  `src/mcp/client.ts`). Everything downstream — `gateMcpTool`, the `write`
  allowlist, `mcp__server__tool` naming, failure isolation — is transport-
  agnostic and unchanged, so an HTTP server's write tool is HITL-gated identically
  to a stdio one.

Seed: `deepwiki` (HTTP, authless, read-only) added to `mcp-bridge.json` under
`research` as the zero-setup "flip and it works" example.

**Evidence (2026-07-13, real path, not mocked).** `pnpm mcp:probe mcp-bridge.json
--invoke` against the live code path: DeepWiki connected over HTTP and loaded 3
read tools (`read_wiki_structure`, `read_wiki_contents`, `ask_question`), all
classified read/pass-through; a live `read_wiki_structure` call returned 2,435
chars of real content. Blender (`uvx`) and Slack (`npx`) failed to connect in the
sandbox (proxy blocks pypi/npm TLS) and were isolated to zero tools — the others
loaded regardless, confirming the failure-isolation contract. A probe manifest
marking `ask_question` as `write` flipped it to WRITE (HITL-gated), confirming
gating is transport-agnostic. New unit tests cover http schema parsing,
backward-compat stdio default, url-required rejection, unknown-transport
rejection, and `toConnection` header/env resolution (`tests/unit/mcp/*`, $0).

## Amendment — 2026-07-13 (Tier 2: annotation-driven classification)
The write allowlist was the last hand-maintained chore: every mutating tool on
every server had to be typed into `mcp-bridge.json` by hand, and a forgotten
name meant an ungated external write. MCP tool annotations (spec 2025-06-18 —
`readOnlyHint`/`destructiveHint`) let a server declare a tool's risk itself, so
a well-annotated server needs no `write` list at all.

- **A second classification source, trusted only to tighten.** `isWriteTool`
  gains an optional `annotations` argument; `annotationsOf` reads them off the
  loaded tool (the adapter surfaces them at `metadata.annotations`). Precedence,
  each step only ever ADDS a gate: (1) manifest `write` list → gate; (2)
  `gateUnlisted` → gate; (3) `destructiveHint:true` or `readOnlyHint:false` →
  gate; (4) else read-through. The MCP spec is explicit that a server's
  annotations are hints, not guarantees, so we never let a `readOnlyHint:true`
  REMOVE a gate the founder set — the manifest and `gateUnlisted` always win, and
  a missing hint preserves the existing read-through default (no over-gating of
  un-annotated servers like DeepWiki).
- **Truthful capability manifest, no dead gates.** `buildBridgedTools` now
  returns `{ byDept, gatedNames }` where `gatedNames` is derived from the LOADED
  tools (write list OR annotation) rather than from the manifest alone. So
  annotation-gated tools render with `*` in the capability text, and a tool from
  a server that failed to connect can never leak in as a dead gate. The actual
  pause is unchanged — it fires inside `gateMcpTool` via `hitlGate()`/`interrupt()`,
  independent of this display set.

**Evidence (2026-07-13, real MCP server, not mocked).** A local stdio MCP server
annotating four tools, connected through the real `@langchain/mcp-adapters` with
an EMPTY manifest `write` list, classified via `pnpm mcp:probe`:
`look` (`readOnlyHint:true`) → read; `mutate` (`readOnlyHint:false`) → WRITE
(HITL-gated); `destroy` (`destructiveHint:true`) → WRITE (HITL-gated);
`plain` (no annotation) → read. Gating came 100% from server annotations. Against
live DeepWiki (HTTP, no annotations) all three read tools stay read-through,
confirming un-annotated servers keep the default. New unit tests cover
`annotationsOf`, the full precedence table (hint tightens, never loosens;
manifest/`gateUnlisted` win), and `gatedNames` excluding failed-server tools
(`tests/unit/mcp/*`, $0). Full `pnpm gate` green (1477 tests).

Consolidation: the earlier standalone `scripts/probe-mcp-bridge.ts` (stdio-only,
hard-coded reference server) was merged into `scripts/mcp-bridge-probe.ts`
(`pnpm mcp:probe`, any manifest, HTTP + `--invoke`) — one probe, not two.
