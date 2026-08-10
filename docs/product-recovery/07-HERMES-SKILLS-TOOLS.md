# Hermes, Skills, Tools, Capabilities

**Read this before planning any work involving Hermes.** The strategy documents describe a Hermes
that does not exist in this repository.

---

## 1. What Hermes actually is here

`grep -rni hermes` over `src/`, `docs/`, root `*.md` → **6 hits, two subsystems, neither is an
agent or a browser.**

### 1a. `src/kernel/lessons.ts` — "the Hermes learning seam"

Failure-lesson memory. When a retryable step fails, the message is normalised to a stable
signature; a `(worker, signature)` lesson is looked up in an injected `LessonStore` and appended
to the retry envelope as evidence. On success, the resolving tools are recorded.

- **Wired:** yes — `makeLessonDispatch(config.lessons)` is the `dispatch` node in `graph.ts`
- **Backend:** Postgres `agents.failure_lessons`, built in `kernel-boot.ts`
- **Prod state:** **2 rows**
- **Fail-open by design:** a store outage degrades to "no lesson", never breaks a turn

**Assessment: correct, wired, and starved.** 2 lessons in months because few failures reach the
retry seam with a stable signature. Not broken — under-fed. Phase 10 feeds it.

### 1b. `src/tools/skill-synthesizer.ts` — "Hermes Autonomous Skill Synthesizer"

Exposed as tool `synthesize_skill` on **admin, engineering, and admin's `memory_context`
cluster**. It writes TypeScript to `./src/tools/custom` and tests to
`./tests/unit/tools/custom`, then compiles them.

**On prod this writes executable code into the running application's source tree.** It is not in
`HITL_GATED_TOOLS`.

→ **`12-FAILURE-LEDGER.md` F-07.** Not fixed this session; flagged as the highest-severity
finding that is not a product-outcome bug.

### 1c. What Hermes is NOT

Not a browser agent. Not a skill-execution layer. Not a competing orchestrator. Not something the
planner chooses between.

**Delete from the roadmap:** any phase of the form *"make Hermes the canonical browser executor"*
or *"put Hermes behind a capability."* There is nothing to put there.

---

## 2. Skills

`skills-lock.json` = **5 skills, all `apify/agent-skills`**: `apify-actor-development`,
`apify-actorization`, `apify-generate-output-schema`, `apify-sdk-integration`,
`apify-ultimate-scraper`.

There is **no `SKILL.md` anywhere in the repo** outside `node_modules`. There is no skill
selection, loading, or execution layer in the FounderOS runtime.

**Source of the confusion:** the founder's *Claude Code* session exposes ~90 skills
(`superpowers:*`, `sales:*`, `anthropic-skills:*`, …). Those belong to the **development
environment**, not the product. The thesis's "skills vs. tools vs. Hermes" ambiguity is an
artefact of that conflation.

**Implication:** the "SKILL / PLAN" box in the target architecture has no implementation and needs
none. In FounderOS a *skill* is a **worker prompt + its bound tool set**. That abstraction already
exists and works.

---

## 3. The vocabulary, fixed

Use these definitions in all phase work:

| Term | Definition in FounderOS | Where it lives |
|---|---|---|
| **Tool** | one primitive operation with a typed envelope | `src/tools/*.ts` |
| **Agent tool** | a LangChain-wrapped tool, optionally HITL-gated | `src/agents/agent-tools/*.ts` |
| **Worker** | prompt + bound tools + output contract | `buildWorkerSpecs()` |
| **Capability** | *(does not exist as a named construct)* | — |
| **Executor** | the code behind a tool that causes the side effect | `src/tools/**` impl |
| **Skill** | *(not a runtime construct — a worker prompt IS the skill)* | `src/agents/prompts/` |
| **Hermes** | failure-lesson memory + the code synthesizer | `kernel/lessons.ts`, `tools/skill-synthesizer.ts` |

### Should we add a Capability layer?

**No — with one narrow exception.**

The target architecture's `CAPABILITY` box maps cleanly onto **worker + tool** as it already
exists. Introducing a third named layer would be the abstraction this program exists to prevent.

The one place the *pattern* is genuinely missing is **Tier-0 structured state** (`06-…`), and the
right shape there is a small set of ordinary read-only tools — not a registry, not a router, not a
capability class.

**Verdict: no capability layer. Two new read-only tools in Phase 2, and the interface collapses
in Phase 7.**

---

## 4. External MCP

`src/mcp/` provides both directions:

- **Inbound:** FounderOS runs a read-only MCP server (`pnpm mcp`) exposing `search_web`,
  `read_context`, `search_knowledge`, `search_memory`, `read_cv`, `github_read`
- **Outbound:** `MCP_BRIDGE_ENABLED` merges external MCP tools into `DEPARTMENT_TOOLS` at boot
  via `applyMcpBridge()`, with write tools auto-added to the HITL set

Correctly built, idempotent, flag-gated. **Note the risk:** the bridge merges arbitrary external
tools into the same registry the planner enumerates. Every enabled MCP server directly enlarges
the 79-slot catalog. Keep it off until Phase 7 lands the collapse.
