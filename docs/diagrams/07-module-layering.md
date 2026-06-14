# 07 — Module Layering

What can import what. FounderOS enforces a strict one-directional dependency rule
(CLAUDE.md "Module & Import Rules"). Arrows point in the **only** allowed direction;
anything against an arrow is a circular import and is banned.

```mermaid
graph TD
  gateway["gateway/<br/>telegram · commands · office-run · format"]
  agents["agents/<br/>office · capabilities · prompts · agent-tools · state · model"]
  tools["tools/<br/>search_web · email · github · context · knowledge · …"]
  infra["infra/<br/>checkpointer · scheduler · health · trace · budget · halt · wedge"]
  db["db/<br/>schema · queries"]
  core["core/<br/>registry · config"]
  workflows["workflows/<br/>registry · runner"]

  gateway --> agents
  gateway --> infra
  agents --> tools
  agents --> infra
  workflows --> agents
  tools --> infra
  infra --> db
  db --> core
  agents --> core
  infra --> core
  tools --> core

  classDef top fill:#3b82f6,stroke:#1e40af,color:#fff
  classDef mid fill:#10b981,stroke:#065f46,color:#fff
  classDef bot fill:#f59e0b,stroke:#b45309,color:#fff
  class gateway top
  class agents,tools,workflows mid
  class infra,db,core bot
```

**The rule, stated plainly:** `core → db → infra → agents → gateway`. Lower layers
never import upward.

**Two patterns that exist to *preserve* this rule**
- **`agent-tools.ts` is a barrel.** The real tool wrappers live in per-department
  modules under `agent-tools/` (hitl, research, comms, engineering, personal,
  jobhunt, memory); the barrel just re-exports them so `office.ts` and
  `capabilities.ts` have one import surface.
- **`infra/telegram-send.ts` is api-only.** Agents sometimes need to push a file to
  Telegram, but agents can't import the gateway (wrong direction) — and a second
  long-poll client would cause a 409. So the *infra* layer holds a send-only grammy
  client (no polling), which agents are allowed to import.

**Why this matters for new developers:** if your import triggers a circular-dependency
error, you're pointing an arrow the wrong way. Move the shared thing **down** a layer
(usually into `infra/` or `core/`), don't import sideways.
