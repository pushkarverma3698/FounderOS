# Ideation — "Why aren't we as easy as Claude's connectors?" (MCP ecosystem)

**Date:** 2026-07-12 · **Status:** Brainstorm / research (not an ADR yet) ·
**Prompted by:** founder — *"we have so many Claude MCP tools and connectors…
thousands of open source… what we are building and complicating is already
solved."*

---

## TL;DR — the one-paragraph answer

We are not missing the "easy connector" system. **We built it and turned it
off.** ADR-041 already shipped a full external-MCP client bridge —
`gateMcpTool` + `MultiServerMCPClient` + a Zod-validated `mcp-bridge.json` +
per-server failure isolation + HITL/idempotency/audit wrapping. It has Blender
and Slack seeded in the manifest. It is gated behind `MCP_BRIDGE_ENABLED=false`
and was never switched on in prod. So the honest split is:

- **The part that feels "already solved" IS already solved — twice.** Once by
  the ecosystem (800+ registry servers, ~256 hosted remote ones), and once by
  us (the bridge). What's *dated* in our copy is three things: it speaks only
  `stdio`, it hand-maintains a `write` allowlist, and it has no discovery.
- **The part that feels like "complication we should delete" is actually our
  moat.** The HITL gate → idempotency key → audit-on-success wrapper in
  `gateMcpTool` is the entire difference between "an autonomous kernel the
  founder trusts to send email" and "a chat loop." The Claude app doesn't need
  it because a human approves every action in-chat; an autonomous kernel does.

**Recommendation:** keep the safety wrapper (the moat), adopt the ecosystem for
everything upstream of it (transport, discovery, classification). Concretely:
flip the flag, add HTTP+OAuth transport, let server annotations classify
reads/writes, and add a `/connect` discovery command. None of this touches the
kernel contracts.

---

## 1. What "the easy system" actually is (and what it isn't)

The Claude app experience the founder is pointing at = **browse a marketplace →
one-click OAuth → tools appear.** Underneath, that is three commodity layers:

| Layer | Claude app | Ecosystem status (2026) |
|---|---|---|
| **Acquisition / discovery** | connector marketplace | official registry `registry.modelcontextprotocol.io` — 800+ servers, ~13k total incl. community |
| **Transport** | remote HTTP, hosted, zero install | streamable-HTTP is now the default; ~256 official *hosted remote* servers (Notion, Linear, Stripe, Slack, GitHub, Sentry, Atlassian…) |
| **Auth** | one-click OAuth | OAuth 2.1 is now standard for hosted servers; static bearer tokens are the legacy path |
| **Read/write safety** | *human approves in-chat* | tool **annotations** (`readOnlyHint`/`destructiveHint`/`idempotentHint`) let the server self-declare risk |

What the Claude app deliberately does **not** have: durable idempotency keys, an
audit ledger, "DB row before `interrupt()`", zero-hallucination receipts, or a
deterministic replay contract. It doesn't need them — the human is the gate.
FounderOS is an *autonomous kernel*; those are exactly the properties that make
it safe to run without a human watching each step. That layer is not
commodity and must not be "simplified away."

**So the frustration is half-right.** The half that's right: we are
hand-rolling native tools per app (35+ files in `src/tools/`) and running a
`stdio`-only manual manifest when the ecosystem hands us hosted OAuth servers
for free. The half that's wrong: the wrapper that makes a bridged tool obey our
safety contract is not the complication — it's the product.

---

## 2. What we already have (inventory of the dormant bridge)

All shipped under **ADR-041**, `MCP_BRIDGE_ENABLED` default **false**:

- `src/mcp/bridge-manifest.ts` — Zod-validated `mcp-bridge.json` loader.
- `src/mcp/client.ts` — `MultiServerMCPClient`, connect-once memoization,
  `onConnectionError:"ignore"` + per-server try/catch (a dead server contributes
  zero tools, never aborts boot).
- `src/agents/agent-tools/external-mcp.ts` — `gateMcpTool`: reads pass through
  inside a stage-tagged error boundary; writes run `idemKey` → `hasBeenAudited`
  → `hitlGate()` → side effect → `writeAuditEntry()`, pure work before the gate
  so it replays cleanly on `interrupt()`.
- `src/mcp/bridge-classify.ts` — `isWriteTool` (explicit allowlist) +
  `mcp__<server>__<tool>` collision-free naming.
- `src/agents/capabilities.ts` — `applyMcpBridge()` merges bridged tools into
  `DEPARTMENT_TOOLS` and the HITL set; dynamic import so flag-off builds never
  even load the adapter.
- `mcp-bridge.json` — **already populated** with `blender` (personal) and
  `slack` (comms), write allowlists set.
- `@langchain/mcp-adapters@^1.1.3` and `@modelcontextprotocol/sdk@^1.29.0`
  already in `package.json`.

**Nothing here needs to be invented. It needs to be switched on and modernized.**

### The three things that are dated

1. **`stdio`-only.** `mcpServerSchema.transport = z.literal("stdio")`. Every
   server is a local child process (`npx -y …`, `uvx …`). That excludes the
   entire hosted-remote ecosystem — the exact set that makes the Claude app
   feel effortless (no install, no local process, OAuth handled).
2. **Hand-maintained `write` allowlist.** Every server's risky tools are typed
   by hand into the manifest. This is precisely the "complication" the founder
   named — and the ecosystem now solves it with annotations.
3. **No discovery.** Adding a server = hand-edit JSON + set env + restart. The
   Claude app's "browse and click" has no analog here.

---

## 3. What we can achieve — five tiers, smallest first

Each tier is independently shippable and each one keeps `gateMcpTool` as the
single safety seam, so HITL/audit/determinism survive untouched.

### Tier 0 — Flip the switch (hours, zero new code)
Set `MCP_BRIDGE_ENABLED=true` in prod. Blender (personal) and Slack (comms) go
live *today*, both write paths already HITL-gated and audited. This is the
cheapest possible proof that "the easy system" already runs inside FounderOS.
Gate: `pnpm gate` stays green (flag-off tests unaffected); one MTProto QA run to
watch a Slack `post_message` fire the approval card → approve → `action_log`
row.

### Tier 1 — Remote HTTP + OAuth transport (small; highest leverage)
Extend `mcpServerSchema` from `stdio`-only to a discriminated union:
`{transport:"http", url, headers?, oauth?}`. `@langchain/mcp-adapters` already
supports streamable-HTTP with `Authorization`/custom headers, so `toConnection`
grows a branch and nothing downstream changes. **This one change unlocks the
~256 hosted remote servers** — Notion, Linear, Stripe, GitHub, Sentry — with no
local process to manage. Secrets stay as forwarded env-var *names* (OAuth token
in env, or a short-lived token minted at boot); the manifest never holds a
secret. This is the single change that closes most of the gap to the Claude-app
experience.

### Tier 2 — Annotation-driven auto-classification (medium)
Teach `isWriteTool` to read the loaded tool's `annotations.readOnlyHint` /
`destructiveHint`. Rule: **a tool is a write unless it self-declares
read-only** (fail-safe — the opposite of trusting a name like `get_`). The
manifest `write` list and `gateUnlisted` flag stay as an *override* for servers
we don't trust to annotate honestly (the spec itself warns annotations from
untrusted servers are hints, not guarantees — so we keep the override, we don't
blindly obey). This deletes the hand-maintained allowlist for well-behaved
servers — the exact complication the founder called out — without weakening the
gate.

### Tier 3 — Registry discovery + `/connect` command (bigger; the "marketplace")
A Telegram command backed by `registry.modelcontextprotocol.io`:
`/connect notion` → searches the registry → shows candidates → founder picks →
the entry is written to `mcp-bridge.json` and the bridge reconnects live. This
is the Claude-app "browse and click" experience *inside FounderOS* — and every
tool it adds still flows through `gateMcpTool`, so a marketplace install can
never bypass HITL. Needs: a registry client, a confirm card, and a
hot-reload path for the bridge (today it's connect-once at boot).

### Tier 4 — Collapse Composio onto MCP (strategic; retires our biggest fragility)
ADR-041 §6 already flagged this as "migrate later." Composio is the shared
client behind Gmail + LinkedIn + Calendar — **one bad key takes down three
departments** (LIMITATIONS §7; the 2026-06-25 prod email outage). Gmail,
Calendar, and Slack now all have official hosted remote MCP servers. Moving
them onto the bridge (Tier 1 transport) swaps a one-key-three-departments
cascade for per-server failure isolation, and lets us retire custom provider
adapters in `src/infra/providers/` for the long tail. Keep native tools only
for the revenue-critical, budget-sensitive, daily-dependency paths (Apify
research, the sends we bill proof on). This is a phased ADR, not a big-bang.

---

## 4. The bridge that isn't a gap — elicitation ↔ HITL

Worth noting for later: the MCP spec now has server-initiated **elicitation**
(a server asks the user for more info mid-tool, with accept/decline/cancel).
That is *structurally identical* to our `interrupt()` HITL card. When we do
Tier 3+, elicitation requests from a bridged server should render as a
FounderOS approval/data card rather than being dropped — it unifies "the server
needs input" with "the founder must approve" on one primitive we already own.

---

## 5. The honest tension, stated plainly

> "What we are building and complicating is already solved."

**True for:** per-app native tool wiring, `stdio`-only manifests, hand-typed
write allowlists, and lack of discovery. All commodity. Adopt the ecosystem;
stop hand-rolling.

**Not true for:** the HITL gate, idempotency keys, the audit ledger, and
zero-hallucination receipts. That is not accidental complexity — it is the
reason FounderOS is a kernel and not a chat loop, and it is what lets an
*autonomous* agent send an email the founder never watched it draft. The Claude
app can skip it because a human is the gate on every call; we cannot.

The move is not "throw out our tools and use connectors." It is: **buy the
commodity (acquisition + transport + classification), keep the moat (the gate).**
`gateMcpTool` already sits at exactly that seam. We built the hard part. We just
stopped one flag short of using it.

---

## 6. Suggested sequencing

1. **Tier 0 now** — flip `MCP_BRIDGE_ENABLED`, QA Blender+Slack live. Proves the thesis at zero cost.
2. **Tier 1 next** — HTTP+OAuth transport. One schema change, unlocks hundreds of hosted servers. Draft as an ADR-041 amendment.
3. **Tier 2** — annotation classification. Deletes the allowlist chore, keeps the override.
4. **Tier 3** — `/connect` discovery + live reload. The marketplace experience.
5. **Tier 4** — Composio → MCP migration as its own ADR, one department at a time, Gmail-read first (lowest risk), rollback flags retained.

Every tier is `pnpm gate`-green on its own and preserves the contract. No tier
requires touching `src/kernel/`.

---

### Sources
- Official MCP Registry — <https://registry.modelcontextprotocol.io/> ; ecosystem scale — <https://www.qcode.cc/mcp-servers-ecosystem-2026>
- Remote/hosted OAuth servers — <https://mcpservers.org/remote-mcp-servers> ; Notion remote MCP — <https://github.com/makenotion/notion-mcp-server>
- `@langchain/mcp-adapters` HTTP+OAuth — <https://github.com/langchain-ai/langchain-mcp-adapters> ; <https://docs.langchain.com/oss/python/langchain/mcp>
- Tool annotations (readOnly/destructive/idempotent hints) — <https://modelcontextprotocol.io/specification/2025-06-18/schema> ; <https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/>
- Internal: `docs/decisions/041-mcp-client-bridge.md`, `src/mcp/`, `src/agents/agent-tools/external-mcp.ts`, `mcp-bridge.json`
