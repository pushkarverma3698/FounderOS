# SCALE Gate — Deferred FounderOS Builds

> **Type:** strategy · **Status:** Deferred until $5K+ banked OR first paying client  
> **ADR:** [032-ai-native-studio-repositioning.md](../decisions/032-ai-native-studio-repositioning.md)

Captured build list — **do not implement until SCALE gate triggers.**

---

## Trigger

- $5K+ banked from Cinematic Launch Experience / retainer, **OR**
- First paying client closed at ≥$8K

---

## 5a. `gen_asset` Tool

**Purpose:** Text→image (and optional 3D) for design pipeline — showcase + client work.

**Wiring (when built):**
- `src/tools/gen-asset.ts` → test → `agent-tools/marketing.ts` wrapper
- Add to `marketing` + `engineering` in `capabilities.ts`
- HITL-gate if external API cost > threshold

**Triple-filter:** Outcome (faster showcases) · Hiring signal (multimodal tools) · Reuse (existing tool pattern)

---

## 5b. MCP Client → `cinematic-web` Repo

**Purpose:** Template picker + one-click deploy from FounderOS ([STRATEGIC-VISION](../study/archive/STRATEGIC-VISION.md)).

**Routing:**
```
Client request
  ├── Template preference → cinematic-web MCP → preset picker → deploy
  └── Custom design → engineering claude_code + design MCP
```

**Wiring (when built):**
- MCP client in `src/infra/mcp-client.ts` or extend `src/mcp/`
- Engineering prompt: route template builds to MCP tool
- Env: `CINEMATIC_WEB_MCP_URL`

---

## 5c. Optional `studio` Department

**Trigger (ADR-025):** ≥2 coordinating agents in design domain + MTProto verification of nested HITL.

**Wiring:** [PROGRAMMING-RULES Wiring Map 2](../rules/PROGRAMMING-RULES.md) — 10 files.

**Tools (draft):** `gen_asset`, cinematic MCP, `publish_signal`, `search_turicks_brain`

---

## 5d. Phase D Optional Departments

| Dept | Purpose | Key integration |
|------|---------|-----------------|
| `outreach` | LinkedIn DM scheduling (HITL) | Composio; ADR-009 compliance |
| `payments` | Gumroad/Stripe webhooks | `gumroad_sale` signal, thank-you email |

---

## 5e. Proof Drop Engine (`scout` Workflow)

**Purpose:** Automate target scoring + artifact brief generation.

**Reuse:** `search_web`, sales ICP scorer, `claude_code`, `github`, `workflows/registry.ts`

---

## Verification Before Promoting Any SCALE Build

1. Paying client need documented (not speculative)
2. Triple-filter pass (ADR-014)
3. `pnpm test` + eval routing green
4. MTProto verification for any new HITL path (rule #19)
5. ADR written + `pnpm brain:sync`
