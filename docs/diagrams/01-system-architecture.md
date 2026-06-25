# 01 — System Architecture

The moving parts and how they connect. Everything below the gateway runs
in-process in a single Node.js service; Postgres and the Claude Code executor
are the only out-of-process dependencies on the hot path.

```mermaid
graph TB
  founder([Founder]):::ext

  subgraph gw["Gateway · src/gateway"]
    tg["telegram.ts<br/>grammy bot (long-poll)"]
    cmd["commands.ts<br/>/run /q /reset /halt …"]
    run["office-run.ts<br/>run-loop + thread guards"]
    fmt["format.ts<br/>markdown → Telegram HTML"]
  end

  subgraph office["Office · src/agents"]
    sup["Supervisor<br/>(Chief of Staff)<br/>outputMode: last_message<br/>No business tools (ADR-028)"]
    admin["admin"]:::dept
    research["research"]:::dept
    comms["comms"]:::dept
    eng["engineering"]:::dept
    mktg["marketing"]:::dept
    sales["sales"]:::dept
    personal["personal"]:::dept
    jobhunt["jobhunt"]:::dept
  end

  subgraph infra["Infra · src/infra"]
    cp["checkpointer.ts<br/>Postgres saver"]
    sched["scheduler.ts<br/>Monday brief · HITL sweep"]
    health["health.ts<br/>/health /metrics"]
    lock["single-instance.ts<br/>PID lock"]
  end

  pg[("PostgreSQL<br/>state + audit + memory")]:::svc
  cc["Claude Code<br/>executor (isolated workspace)"]:::svc
  ext3p["3rd-party APIs<br/>Gemini · Composio · GitHub · Firecrawl"]:::svc

  founder <-->|messages / approval taps| tg
  tg --> cmd
  tg --> run
  run --> sup
  run --> fmt --> tg
  sup --> admin & research & comms & eng & mktg & sales & personal & jobhunt
  admin & research & comms & eng & mktg & sales & personal & jobhunt -->|tool calls| ext3p
  eng -->|claude_code| cc
  sup -->|interrupt / resume / state| cp --> pg
  sched --> sup
  health -.liveness.-> pg

  classDef dept fill:#3b82f6,stroke:#1e40af,color:#fff
  classDef svc fill:#f59e0b,stroke:#b45309,color:#fff
  classDef ext fill:#6b7280,stroke:#374151,color:#fff
```

**Key facts**
- The office graph is compiled **once** (`getOffice()` singleton) with the Postgres
  checkpointer — never per request.
- 8 departments: admin · research · comms · engineering · marketing · sales · personal · jobhunt.
- Supervisor has **no tools** (ADR-028). Business context and memory live in the `admin` dept.
- `outputMode: "last_message"` is pinned + asserted at boot (ADR-021 context isolation).
- One model for the whole office: `gemini-2.5-flash` via OpenRouter (temp 0), 503 fallback chain.
- The gateway is the only layer that talks to Telegram; agents that need to push a
  file use the api-only `infra/telegram-send.ts` client (no second long-poll → no 409).
- FounderOS also **exposes** an MCP server on `localhost:3100` (search_web, read_context,
  search_knowledge, search_memory, read_cv, github_read) for external MCP clients.
