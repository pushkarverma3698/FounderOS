# 01 — System Architecture (v3)

The moving parts and how they connect. Everything below the gateway runs in one
Node.js process; Postgres and the injected model provider are the only
out-of-process dependencies on the hot path. The **kernel is a pure library** —
it never constructs a provider client or reads env, which is exactly what lets
the whole graph run offline in CI at $0.

```mermaid
graph TB
  founder([Founder]):::ext

  subgraph gw["Gateway · src/gateway"]
    tg["telegram.ts<br/>grammY bot (long-poll)"]
    run["kernel-run.ts<br/>lock → gates → invoke → HITL card / reply"]
    boot["kernel-boot.ts<br/>⚙️ THE ONLY composition root"]
  end

  subgraph kernel["Kernel · src/kernel (pure, injected, $0-testable)"]
    graph["graph.ts · StateGraph"]
    plan["plan (LLM #1)"]
    disp["dispatch (pure code)"]
    agent["agent (LLM #2) ⇄ tools"]
    coll["collect (pure)"]
    synth["synthesize (LLM #3)"]
    contracts["contracts.ts<br/>TaskEnvelope · Plan · StepResult<br/>ToolReceipt · FailureReport"]
  end

  subgraph tools["Tools · src/tools + src/agents/agent-tools"]
    t1["research · comms · engineering"]
    t2["marketing · sales · personal · jobhunt · admin"]
  end

  subgraph infra["Infra · src/infra"]
    hitl["hitl.ts (approval rows)"]
    ckpt["checkpointer (PostgresSaver)"]
    budget["budget · daily-budget"]
  end

  db[("Postgres<br/>agents schema + brain schema")]:::ext
  mcp["src/mcp<br/>read-only MCP server"]

  provider["Model provider<br/>Gemini Flash (temp 0)"]:::ext
  ext2["Composio · Gmail · LinkedIn<br/>GitHub · Firecrawl · VPS"]:::ext

  founder <--> tg
  tg <--> run
  boot -. injects models+tools+checkpointer .-> graph
  run --> graph
  graph --> plan --> disp --> agent --> coll --> disp
  disp --> synth
  agent <--> tools
  plan & agent & synth -. inference .-> provider
  agent <--> hitl
  tools <--> ext2
  graph <--> ckpt --> db
  hitl --> db
  mcp -. read-only .-> db
  founder -. read-only .-> mcp

  classDef ext fill:#eee,stroke:#999,color:#333;
```

## How to read it

- **The gateway is transport + policy, not orchestration.** `kernel-run.ts` takes a per-chat lock, runs pre-flight gates (halt, budget), invokes the kernel, and turns a paused graph into a Telegram approval card. It contains no routing logic.
- **`kernel-boot.ts` is the only place providers are wired.** Swap the model, the checkpointer, or the tool set here and nowhere else. Tests inject scripted models through the same seam.
- **The kernel imports only kernel/core/db/infra/tools** — never the gateway. CI enforces this import direction (`gateway-imports`, `kernel-purity` both at `0`).
- **The MCP server is a read-only window.** External agents can read state; there is no write path through it.

See [02 — Orchestration path](02-orchestration-path.md) for what happens inside the kernel box.
