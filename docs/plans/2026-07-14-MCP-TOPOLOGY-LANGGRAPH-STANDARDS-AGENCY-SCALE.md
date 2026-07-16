# Multi-Agent OS Architecture Pass — MCP Topology, LangGraph Standards, Agency Scale

**Date:** 2026-07-14 · **Status:** Proposed (specification — no code changes in this PR)
**Scope:** (1) RAG audit + Mac↔VPS MCP network topology, (2) LangGraph.js layer standards and
design rules, (3) agency automation and agent-workspace architecture.

---

## 0. Reality reconciliation — what this spec is grounded in

The brief described "a hierarchical supervisor design with 7 ReAct departments" on a MERN
stack. That is the **v2** mental model, and it no longer exists: v2 (LLM supervisor + regex
pre-router + regex execution guards + domain subgraphs) was audited and killed on 2026-07-08
(`ZERO-BASE-AUDIT.md`), and `scripts/verify-architecture.ts` R6 **tombstones** make re-creating
`office.ts`, `engineering-domain.ts`, `revenue-domain.ts`, and the handoff modules a hard CI
failure. The live system is the **v3 contract-first kernel**: one flat orchestration path
(`plan → dispatch → agent ⇄ tools → collect → … → synthesize`) over **eight** workers
(`admin, research, comms, engineering, marketing, sales, personal, jobhunt` —
`src/kernel/contracts.ts` `WORKERS`), each isolated to an envelope-only context with a capped
tool set from `src/agents/capabilities.ts`.

Likewise the stack is not MERN: it is Node 22 + TypeScript strict + LangGraph.js `StateGraph`
+ grammy + drizzle/**Postgres** (with pgvector), Redis for caching, S3-compatible object
storage, and Ollama for local embeddings/small-model work. `apps/`, `client/`, and `Github/`
are frozen trees excluded from all architecture rules.

Everything below therefore **strengthens v3 rather than resurrecting v2**. Where the brief
asked for "department sub-graphs," this spec answers with the v3 equivalent that achieves the
same isolation goal without violating the tombstones: workers as data (`WorkerSpec`), not as
graph topology.

---

## 1. Knowledge / RAG audit and the Mac↔VPS MCP topology

### 1.1 RAG architecture — current state (audited)

The retrieval surface today is broader than it looks from the outside:

| Layer | Implementation | Notes |
|---|---|---|
| Vector search | pgvector via `src/tools/rag.ts` + `src/db/rag-search.ts` | 3 stores: `personal`, `turicks`, `research` (`src/infra/rag-orchestrator.ts`) |
| Embeddings | Ollama `nomic-embed-text` (`src/lib/ollama.ts`, `src/lib/embed.ts`) | 8 s timeout, **returns `null` on any failure** |
| Keyword search | `src/db/keyword-search.ts` | separate path from vector search |
| Memory tiers | `episodic_memory`, `conversations`, `knowledge_entries` (`search_memory`, ADR-016) | unified query tool |
| External RAG | `src/infra/ragflow.ts`, personal-rag REST API (`localhost:8765`, wiki.md fallback) | CV/career answers |
| Semantic memory | `src/infra/mem0.ts`, `research-memory.ts` | research dedup/cache |

**Findings:**

- **F1 — silent degradation to nothing.** `ollamaEmbed` returns `null` on failure and callers
  fall through. A dead Ollama daemon degrades every vector search to zero results with no
  `FailureReport`, which violates the spirit of "failures name the real component." Fix: when
  the embed call fails, the RAG tool must return `ToolResult.success=false` with
  `component: "ollama-embed"` so the founder sees *why* recall dropped, and the keyword path
  must run as the explicit fallback (labelled as such in the tool output).
- **F2 — keyword and vector retrieval never cooperate.** They are separate tools chosen by the
  worker LLM. Replace the choice with **hybrid retrieval inside one tool**: run pgvector
  similarity and Postgres full-text search in parallel and merge with Reciprocal Rank Fusion
  (RRF, `k=60`). RRF is pure arithmetic — unit-testable at $0, deterministic, and removes an
  LLM routing decision, which is exactly the v3 doctrine (routing is code, not prompts).
- **F3 — no embedding cache.** Repeated founder queries ("what's our ICP?") re-embed the same
  strings. Redis is already in the stack (`src/infra/redis.ts`): cache
  `sha256(model + text) → vector` with a 30-day TTL. This is the cheapest latency win available.
- **F4 — retrieval results are unvalidated prose.** Every other boundary in v3 is
  Zod-validated; RAG returns strings. Add a `RetrievalResultSchema`
  (`{ source, doc_type, score, chunk, citation }[]`) to `src/kernel/contracts.ts`'s pattern
  (defined next to the tool, validated in the tool adapter) so the synthesizer can render
  citations mechanically and hallucinated "sources" become a typed validation failure.
- **F5 — no reranking stage.** With hybrid retrieval in place, add an optional local rerank:
  top-20 fused results → `qwen2.5:7b` scoring via `ollamaGenerate("classify", …)` → top-5.
  Because Ollama failure returns `null`, the reranker must be **fail-open with the tag**
  (`// allow-failopen: rerank is an accelerant; fused order is already correct`) — degraded
  order, never degraded recall.

The order of implementation is F1 → F3 → F2 → F4 → F5; F1 is a correctness bug, the rest are
speed/quality ratchets. Each lands with a failing test first per the PR rules.

### 1.2 MCP topology — Mac as Host/Client, VPS as Server

> **Update (2026-07-16) — shipped simpler than proposed.** For the actual need
> (a founder + colleagues connecting *on demand*, reusing SSH keys they already
> hold), the always-on HTTP topology below was over-engineered. What shipped
> instead: the MCP client launches the existing **stdio** server on the VPS
> **over SSH** (`ssh founderos-vps 'node … src/mcp/index.ts'`) — the SSH key is
> the auth, no HTTP listener, no bearer token, no tunnel daemon, no systemd unit.
> See `docs/VPS-MCP-SETUP.md`. The HTTP/loopback/bearer design below (items 6–7)
> was built and then removed (git `f54e5a8`); restore it from history only if an
> always-on, multi-client, or non-SSH-client deployment is ever required.

**Current state:** FounderOS already has both halves of the protocol, but the server half is
mis-documented. `src/mcp/server.ts` claims "Transport: Streamable HTTP" and
`capabilities.ts` tells the planner "FounderOS also RUNS an MCP server on localhost:3100" —
but `src/mcp/index.ts` connects a **stdio** transport only. There is no HTTP listener. The
client half (`src/mcp/client.ts` + `bridge-manifest.ts`, ADR-041) already supports
`transport: "http"` with `headerEnv` secret injection, so the Mac side needs **zero new code**
to consume a remote server. Closing the server-side gap is the whole project.

**Target topology:**

```
┌────────────────────────────── Apple Silicon Mac (source of truth) ─────────────────────────────┐
│                                                                                                 │
│  MCP HOSTS/CLIENTS                          LOCAL INFERENCE                                     │
│  ├─ Claude Code / Claude Desktop            ├─ Ollama (embeddings, rerank, classify)            │
│  ├─ FounderOS gateway (grammy + kernel)     └─ MLX (optional; expose via OLLAMA_URL-compatible  │
│  └─ FounderOS MCP bridge (mcp-bridge.json)       shim only — callers never know the backend)    │
│                                                                                                 │
│  outbound only ──► ssh -N -L 3100:127.0.0.1:3100 founderos-vps   (autossh under launchd)        │
└───────────────┬─────────────────────────────────────────────────────────────────────────────────┘
                │  SSH (key: ~/.ssh/founderos_deploy) — the ONLY ingress; port 3100 never public
┌───────────────▼───────────────────────── VPS 95.217.162.12 ─────────────────────────────────────┐
│  founderos-mcp.service (systemd)                                                                │
│  └─ FounderOS MCP server — Streamable HTTP bound to 127.0.0.1:3100                              │
│       tools: search_web, github_read, read_context, search_memory, search_knowledge, read_cv   │
│       auth:  Authorization: Bearer $FOUNDEROS_MCP_TOKEN (rejected before any tool dispatch)     │
│  └─ Postgres (pgvector: personal / turicks / research stores) · Redis · production pipelines    │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Design decisions, in order of load-bearing-ness:**

1. **SSH local-forward is the transport; the HTTP port never leaves loopback.** Bind the VPS
   MCP server to `127.0.0.1:3100` and reach it from the Mac through
   `ssh -N -L 3100:127.0.0.1:3100`. This reuses the existing `founderos_deploy` key and the
   VPS's existing hardening; there is no new attack surface, no TLS certificate to manage, and
   no reverse proxy. (If the Mac ever roams across NATs enough that autossh churn becomes
   annoying, Tailscale between the two machines is the drop-in upgrade — same loopback bind,
   tailnet address instead of tunnel. That is a swap, not a redesign.)
2. **Bearer token as defense-in-depth, resolved via `headerEnv`.** Even inside the tunnel, the
   HTTP transport requires `Authorization: Bearer $FOUNDEROS_MCP_TOKEN` and rejects before any
   tool dispatch. The bridge manifest already supports exactly this without ever writing the
   secret to disk in the repo:

   ```jsonc
   // mcp-bridge.json (Mac side) — token value lives only in the Mac keychain/env
   {
     "servers": {
       "founderos-vps": {
         "transport": "http",
         "url": "http://127.0.0.1:3100/mcp",
         "headerEnv": { "Authorization": "FOUNDEROS_MCP_TOKEN" },
         "department": ["research", "personal"],
         "write": [],
         "gateUnlisted": true
       }
     }
   }
   ```

   `gateUnlisted: true` means that if the VPS server ever grows a write tool, it is
   HITL-gated by default on the Mac side instead of read-through — "unknown ⇒ approval."
3. **The read-only contract survives the network hop unchanged.** The VPS server exposes only
   the six no-approval tools (ADR-013/ADR-004 reasoning in `server.ts` lines 8–13). Write
   actions still exist solely behind the Telegram HITL flow. The topology adds reach, not
   privilege.
4. **Server-side change is one new entry point, not a rewrite.** Add
   `src/mcp/http.ts`: build the same `buildMcpServer()` instance, connect
   `StreamableHTTPServerTransport`, wrap it in a ~30-line Node `http` server that (a) checks
   the bearer token, (b) binds `127.0.0.1` only, (c) reads `FOUNDEROS_MCP_PORT` (default
   3100). `pnpm mcp` keeps stdio for local Claude Code; `pnpm mcp:http` starts the network
   entry point. This also retroactively makes the `server.ts` header comment and the
   capability manifest line true — today both are drift.
5. **Process management:** VPS gets `founderos-mcp.service` (systemd,
   `Restart=always`, `EnvironmentFile=/root/.founderos/vps-env.sh` pattern from
   `docs/VPS-MCP-SETUP.md`). The Mac gets a launchd plist running
   `autossh -M 0 -N -L 3100:127.0.0.1:3100 -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes founderos-vps`
   with the host alias pinned in `~/.ssh/config` to `IdentityFile ~/.ssh/founderos_deploy`.
6. **Local inference never crosses the wire.** Embeddings, rerank, and classification stay on
   the Mac's Ollama/MLX; only *retrieval requests and results* traverse the tunnel. The Mac
   remains the single source of truth for reasoning; the VPS remains the single source of
   truth for production data. If MLX serving is adopted, it must sit behind an
   OLLAMA_URL-compatible endpoint so `src/lib/ollama.ts` callers never learn the backend
   changed.

**Security invariants (CI-checkable where possible):** the MCP HTTP server must refuse to
start when bound to a non-loopback address unless `FOUNDEROS_MCP_ALLOW_PUBLIC=1` is explicitly
set; the token check happens before JSON-RPC parsing; the token never appears in
`mcp-bridge.json`, logs, or receipts (it is an env-var *name* everywhere in the repo); and
`docs/VPS-MCP-SETUP.md` gets a follow-up edit replacing its "paste real API keys into
`vps-env.sh`" step with 600-permission notes it already has plus the new
`FOUNDEROS_MCP_TOKEN` generation step (`openssl rand -hex 32`).

---

## 2. LangGraph.js layer standards — the codified v3 discipline

### 2.1 The layer map

v3 already has the isolated layers the brief asks for; the gap is that they are enforced by
six fitness functions and tribal knowledge rather than by a written standard. This section is
that standard. The directory structure below is the **existing** structure, annotated with
its layer role — new code slots into a layer or it does not merge:

```
src/
├── kernel/                    # LAYER 1–4: the orchestration core (pure where possible)
│   ├── contracts.ts           #  L1 Contracts — Zod schemas: TaskEnvelope, Plan, StepResult,
│   ├── signals.ts             #     FailureReport, ToolReceipt, OUTPUT_CONTRACTS
│   ├── envelope-repair.ts     #     (deterministic coercions live WITH the schemas)
│   ├── state.ts               #  L2 State — the ONE Annotation.Root; channels + reducers only
│   ├── planner.ts             #  L3 Nodes (LLM): plan
│   ├── worker.ts              #  L3 Nodes: agent (LLM), tools, collect (pure)
│   ├── synthesizer.ts         #  L3 Nodes (LLM): synthesize
│   ├── supervisor.ts          #  L4 Edges — routeAfterPlan / routeAfterDispatch: PURE functions
│   ├── lessons.ts             #  L3 Nodes: dispatch (pure + injected LessonStore)
│   ├── tool-adapter.ts        #  L5 Tool boundary — receipts, HITL ordering, idempotency
│   └── graph.ts               #  L6 Assembly — buildKernel(config): nodes + edges, nothing else
├── agents/
│   ├── capabilities.ts        #  L5 Tool Registry — DEPARTMENT_TOOLS + HITL_GATED_TOOLS:
│   │                          #     the single source of truth for who carries what
│   ├── agent-tools/           #  L5 LangChain wrappers per domain (comms, research, …)
│   └── prompts/               #  L3 adjunct — worker persona text, one file per worker
├── tools/                     #  L5 UnifiedTool implementations (ToolResult envelope)
├── gateway/
│   ├── kernel-boot.ts         #  L7 Composition Root — the ONLY place models, tools,
│   │                          #     checkpointer, and lesson store are constructed
│   ├── kernel-run.ts          #  L7 Run loop — lock → gates → invoke → HITL card/reply
│   └── telegram.ts            #  L8 Transport (grammy)
├── infra/                     #  cross-cutting: hitl, checkpointer, budget, trace, redis…
└── db/                        #  drizzle schema + queries (18 tables)
```

Import direction is already CI-law (R1/R2): `contracts ← kernel ← gateway`; the kernel may
import only `kernel/core/db/infra/tools`. The standards below make the remaining conventions
equally explicit.

### 2.2 The design rules (imperative, enforceable)

Every rule is phrased as what to **do**, and each names its enforcement point. A future agent
that follows only this list will produce mergeable code.

**Contracts & state**

1. **Define every cross-node payload as a Zod schema in `src/kernel/contracts.ts` before
   writing the node.** Parse at the boundary with `safeParse`; on failure emit a
   `FailureReport` with the real `component` — never coerce inline in a node. (Enforced by:
   review + the kernel-e2e test exercising the failure path.)
2. **Validate state transitions before edge decisions.** Routing functions
   (`routeAfterPlan`, `routeAfterDispatch`, `routeAfterAgent`) read only already-validated
   channels; they return string literals from a closed set that matches the
   `addConditionalEdges` map exactly. Add a routing target and TypeScript must fail until the
   map is updated. (Enforced by: `satisfies` on the route map — add where missing.)
3. **Grow state only by adding a channel with an explicit reducer to `KernelState`.** Reuse of
   an existing channel for a second meaning is forbidden; a channel name states its single
   meaning. Workers never receive the `history` channel — envelope-only context is the
   isolation mechanism (graph.ts header pins this).

**Nodes & edges**

4. **Keep LLM calls inside exactly three node families: plan, agent, synthesize.** dispatch,
   collect, and every routing function stay pure — testable with plain assertions, no model
   fakes. If a new behavior needs "a little LLM judgment" inside a pure node, that is a design
   error: move the judgment into the planner's Plan or the worker's envelope.
5. **Route with data, not regex, not prompts.** Any control-flow decision must be a pure
   function over typed state (R5 already bans exported control-flow regexes outside the
   kernel). Where classification is genuinely needed, classify once in the planner and carry
   the result as a typed field.
6. **Make every edge target explicit in `graph.ts`.** No node may `Command`-jump to an
   arbitrary target; topology lives in one file so the diagram in the header comment is always
   the truth.

**Workers ("departments") — the anti-cross-contamination rules**

7. **Add capability by adding a `WorkerSpec` (data), never a subgraph (topology).** A new
   department = one entry in `WORKERS`, one prompt file in `agents/prompts/`, one tool array in
   `DEPARTMENT_TOOLS`, one `OUTPUT_CONTRACTS` entry. The graph shape does not change. (This is
   how the brief's "zero cross-contamination between departments" is actually achieved: workers
   cannot contaminate each other because they never share context — only the planner sees the
   conversation, only the synthesizer sees validated `StepResult`s.)
8. **Declare every tool a worker carries in `capabilities.ts` and nowhere else.** Prompts must
   not name tools prose-style; the capability manifest is generated from the arrays
   (`buildCapabilityManifest`). A tool used by two workers is imported into both arrays — never
   reached via a cross-worker call.
9. **Cap tool counts per worker (ADR-027) and justify additions in the PR.** More tools =
   worse tool selection at temp 0. When a worker's array exceeds ~12 entries, split the domain
   or consolidate tools behind one façade tool with an `action` enum (the `github_read`
   pattern).
10. **Pass data between steps only through validated `StepResult`s in mission state.** Step N+1
    receives prior results inside its `TaskEnvelope` because the *planner* put them there —
    never because a worker wrote to a shared scratch channel.

**Tools & side effects**

11. **Ship every tool as a `UnifiedTool` returning the `ToolResult` envelope, wrapped once in
    `agent-tools/`.** Side-effecting tools follow the pinned ordering in `tool-adapter.ts`:
    DB row **before** `interrupt()`, idempotency-key check **before** every external send,
    audit row **only** on real success. New gated tools are added to `HITL_GATED_TOOLS` in the
    same commit that creates them.
12. **Record a `ToolReceipt` in code for every execution** (already mechanical via the
    adapter); any reply claiming an action must be backed by a successful receipt —
    `validateStepResult` is the gate, so never route a new tool around the adapter.

**Composition & testing**

13. **Construct providers only in `src/gateway/kernel-boot.ts`.** The kernel never reads env
    or news up a client (R2 protects this). Tests inject scripted models; `pnpm eval` is the
    only paid path.
14. **Prove determinism, don't assert it.** CI runs the golden set twice and diffs plans; any
    new planner behavior extends `src/eval/golden-tasks.ts` in the same PR. Bug fixes start
    with the failing test.
15. **Stay under the 400-line budget by splitting along layer seams, not by creating
    `utils.ts`.** A file that outgrows its budget splits into schema/logic or node/prompt —
    named for what it is.

### 2.3 Ratchet additions (new fitness functions to implement)

Three cheap rules extend `verify-architecture.ts` to enforce the above mechanically:

- **R7 worker-isolation:** no file in `src/agents/prompts/` may contain the literal name of
  another worker's prompt export, and no `agent-tools/<domain>.ts` may import from a sibling
  domain file. Cross-domain reuse goes through `src/tools/`.
- **R8 registry-drift:** every tool name in `HITL_GATED_TOOLS` must resolve to a tool present
  in some `DEPARTMENT_TOOLS` array or the bridge manifest (dead gates are latent security
  holes in reverse — they imply a tool that no longer exists).
- **R9 contract-coverage:** every `WorkerId` in `WORKERS` has an `OUTPUT_CONTRACTS` entry and a
  prompt file; a worker without a contract is unmergeable.

---

## 3. Agency scale — automation strategy and agent workspaces

### 3.1 The automation position: one funnel, all pieces already in the repo

The solo-agency automation problem is not a tooling gap; it is a wiring gap. The repo already
contains every stage of a B2B LinkedIn funnel — they need to be run as one loop:

1. **Prospect** — `src/tools/apify.ts` (ADR-037 research engine) + `gap-scanner` (AI-visibility
   scans) produce scored leads. The gap-scan doubles as the **lead magnet**: "here is your
   company's AI-visibility gap report" is an outreach artifact generated at ~$0 marginal cost.
2. **Qualify** — research worker enriches against `turicks` brain (ICP, positioning docs in
   `docs/strategy/`) via the hybrid retrieval from §1.1.
3. **Draft** — `src/outreach/` is the crown jewel here: a self-correcting reflection loop with
   a **pure validator** (`validator.ts`), char limits, retry caps, and daily-limit tracking
   already contract-typed. Promote its queue from `createInMemoryOutreachQueue` to a
   Postgres-backed table (one drizzle migration + the same `OutreachQueue` interface) so drafts
   survive restarts — this is the single highest-leverage small change in the outreach path.
4. **Approve** — every send stays behind the Telegram HITL card. At solo scale the founder
   approving 10–20 drafts per morning *is* the compliance strategy (ADR-009 ban-risk:
   human-approved, rate-capped, no connection-request automation).
5. **Follow up** — `scheduled-task.ts` + the scheduler run cadence checks; `linkedin-engagement`
   and analytics tools close the loop back into `docs/PROOF.md`, which is itself the marketing
   asset (proof-drop pipeline, ADR-034).

The aggressive part is not adding tools — it is scheduling stages 1–3 to run **unattended
overnight** so the founder's day starts at stage 4 with a full approval queue. Everything
before the HITL gate is read-only by construction, so unattended operation adds no risk class.

### 3.2 Agent workspace architecture — the evaluation

The brief asks: isolated S3 buckets vs. temporary Docker sandboxes vs. other environments.
The audit says the answer is **stratified, and two of three strata already exist**:

| Stratum | Need | Verdict |
|---|---|---|
| **Agent state** | survive restarts, resume missions, HITL pauses | **Already solved — do not move it to files.** PostgresSaver checkpointer + 18-table schema is the state store. S3/Docker are the wrong tools for state. |
| **Artifacts & handoffs** | files an agent produces for another agent or the founder | **S3 run-prefixes, not per-agent buckets.** `s3-client.ts` already keys `{prefix}/{run_id}/{uuid}_{name}` with presigned URLs and works against AWS/R2/MinIO. Per-agent *buckets* would multiply IAM surface and config for zero isolation gain — prefix-scoped keys under one bucket give the same boundary with one credential. If hard isolation is ever needed, issue prefix-scoped IAM policies, still within one bucket. |
| **Execution sandbox** | scratch space where an agent edits/builds/runs code | **Split by machine.** On the Mac, `claude-code.ts` already confines to `~/Projects/agent-workspace` and hard-blocks the live repo (a real-incident rule from 2026-06-09) — keep it. On the **VPS**, add the missing piece: ephemeral Docker sandboxes — `docker run --rm --network=none --memory=2g --cpus=2 -v /srv/agent-runs/{run_id}:/work` — because the VPS runs production pipelines and a cwd convention is not a boundary there. Container-per-run, S3 upload of `/work` outputs on exit, directory deleted after upload. |

The connective tissue to build is a **`WorkspaceHandle` contract** so files flow through the
same typed discipline as everything else:

```ts
// src/kernel/contracts.ts — addition
export const WorkspaceHandleSchema = z.object({
  run_id: z.string().min(1),
  kind: z.enum(["mac-projects", "vps-docker"]),
  local_dir: z.string().min(1),          // absolute path inside the sandbox
  s3_prefix: z.string().min(1),          // durable home: agent-runs/{run_id}/
  expires_at: z.string().datetime(),     // sandbox TTL; S3 objects outlive it
});
export type WorkspaceHandle = z.infer<typeof WorkspaceHandleSchema>;
```

A `TaskEnvelope` may carry a `WorkspaceHandle`; a `StepResult` that produced files lists their
S3 keys; the next step's envelope receives those keys. Handoff is therefore always
*by-reference through S3*, never by shared mutable directory — the file-system analogue of
rule 10 (§2.2).

### 3.3 The high-conviction recommendation: what to integrate next

**Build the VPS containerized job runner with S3 handoff — one tool, `vps_run`, gated by
HITL, implementing the third stratum above.** Reasoning: it is the only missing layer (state
and artifacts are done); it unlocks overnight unattended stages 1–3 of the funnel on the
machine that is always on (the Mac sleeps; the VPS doesn't); it reuses three existing assets
(S3 client, tool-adapter receipts, systemd ops) so it is days not weeks; and it is the
prerequisite for every future scale move (client-facing report generation, scheduled
gap-scans, media rendering) without ever letting an agent touch the production process's own
filesystem. Concretely: `src/tools/vps-run.ts` (UnifiedTool: brief + WorkspaceHandle in,
receipts + S3 keys out), executed over the same SSH channel as §1.2, container profile pinned
in one config file, tombstone-style rule that the container never mounts `/root/founderos`.

Second priority (independent, ~1 day): the Postgres-backed outreach queue from §3.1 step 3.
Third (already specified): the MCP HTTP entry point from §1.2, which turns the VPS's data
plane into a first-class knowledge source for every MCP client the Mac runs.

---

## 4. Follow-up index

| # | Item | Section | Size |
|---|---|---|---|
| 1 | Embed-failure surfacing (`component: "ollama-embed"`) + labelled keyword fallback | §1.1 F1 | S |
| 2 | Redis embedding cache | §1.1 F3 | S |
| 3 | Hybrid retrieval with RRF in one tool | §1.1 F2 | M |
| 4 | `RetrievalResultSchema` + citations | §1.1 F4 | M |
| 5 | Local rerank stage (fail-open, tagged) | §1.1 F5 | S |
| 6 | `src/mcp/http.ts` Streamable HTTP entry + bearer auth + loopback guard | §1.2 | M |
| 7 | VPS `founderos-mcp.service` + Mac autossh launchd plist + `mcp-bridge.json` entry | §1.2 | S (ops) |
| 8 | Fitness functions R7–R9 | §2.3 | S |
| 9 | Postgres-backed outreach queue | §3.1 | S |
| 10 | `WorkspaceHandle` contract | §3.2 | S |
| 11 | **`vps_run` containerized job runner (recommended next)** | §3.3 | M |

Each item lands as its own PR with a failing test first, fresh `pnpm gate` output, and
live-path proof per the evidence rule. This document itself changes no behavior:
**NOT VERIFIED at runtime — specification only; verification obligations attach to the
follow-up items above.**
