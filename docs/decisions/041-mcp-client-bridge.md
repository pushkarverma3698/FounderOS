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
