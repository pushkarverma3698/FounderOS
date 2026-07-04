# ADR-045 — Browser Use (autonomous browser agent) via the MCP bridge

**Status:** Accepted · **Date:** 2026-07-02 · **Phase:** D (Revenue / Portfolio)

## Context
The `personal` department already had a **browser primitive** — the HITL-gated `browser` tool
(`src/tools/personal.ts` + `src/tools/browser-playwright.ts`) with three deterministic low-level
actions: `open_url`, `get_page_text`, `run_js` (headless Chromium via Playwright on the VPS, Safari
via AppleScript on macOS). What it did **not** have is an *autonomous* browser agent: give it a
natural-language goal ("log in and download the invoice", "find the cheapest flight and fill the
form") and let it plan and execute the multi-step browse loop itself.

"Browser Use v4" was the founder's ask. Research finding: there is no literal v4. The landscape is
(a) the official **Cloud SDK** `browser-use-sdk` (npm, **v3.x** — "always use v3") which runs the
browser in Browser Use's cloud behind a paid `bu_` key; (b) the self-hosted open-source **`browser-use`**
(Python, 0.13.x) which ships an **official local MCP server** — free, uses our own LLM key, drives a
real local browser; and (c) a community TS port `browser-use-node` that is explicitly *not
production-ready* (rejected per rules #16/#17).

## Decision
1. **Adopt the self-hosted browser-use MCP server through the existing ADR-041 bridge** — reuse over
   build (rule #17). It is added declaratively to `mcp-bridge.json` as the `browser-use` server:
   `uvx --from "browser-use[cli]" browser-use --mcp` (stdio), owned by the **personal** department
   (ADR-013 least-privilege). This is the exact `uvx` pattern the existing `blender` server already
   uses — a proven mold, not a new subsystem. No new TS code path: the bridge's `gateMcpTool`,
   department merge, HITL gating, and capability advertisement all apply unchanged.
2. **Cloud SDK rejected as the default.** It runs a fresh cloud browser (≠ the founder's logged-in
   local sessions), needs a paid key, and adds an external dependency — a poor fit for the "personal
   laptop operator" semantics and the zero-cost-dev rule (#23). The self-hosted path keeps runs local
   and free-at-the-provider-level (we bring our own LLM key).
3. **Keep both tools.** The deterministic `browser` primitive stays for precise scripted single
   actions; `retry_with_browser_use_agent` is for autonomous multi-step goals. Prompt guidance
   (`prompts/personal.ts`, `prompts/supervisor.ts`) routes single scripted action → `browser`,
   multi-step goal → the agent. As part of "keep both", the previously **untested** Playwright backend
   gained `tests/unit/tools/browser-playwright.test.ts`, and `closeBrowser()` is now wired into the
   graceful-shutdown path in `src/index.ts` (the singleton Chromium was leaked before).
4. **HITL classification stays explicit data, never a heuristic (rule #13/#16).** All page-acting
   tools are listed in the server's `write` allowlist — `retry_with_browser_use_agent`,
   `browser_navigate/click/type/scroll/go_back/switch_tab/close_tab/close_session/close_all`. The
   read-only state tools (`browser_get_state`, `browser_extract_content`, `browser_list_tabs`,
   `browser_list_sessions`) pass through read-only. `gateUnlisted` is left `false` so the reads are
   not needlessly gated; the shipped classification is pinned by a test on the real `mcp-bridge.json`.
5. **LLM key forwarded by name only.** browser-use's own agent LLM uses `OPENAI_API_KEY` or
   `ANTHROPIC_API_KEY`; the manifest forwards those *names* (values stay in `process.env`, never in the
   manifest). We reuse the `ANTHROPIC_API_KEY` already present for the ADR-023 judge — no new secret.

## Consequences
- Integration was config + prompt notes + provisioning + tests, not a new tool subsystem.
- **Provisioning is part of "done" (rule #22 §5).** The host (dev + VPS) needs `uv`/`uvx` and
  browser-use's own Chromium (`uvx --from "browser-use[cli]" playwright install chromium`) — separate
  from the Node Playwright install used by the primitive tool. Documented in `.env.example` and the
  deploy runbook. If the binary/key is absent the bridge degrades to "those tools absent" (never blocks
  boot), same failure-isolation as any bridged server.
- **Cost (rule #23):** browser-use has no free-tier provider — autonomous runs cost real LLM tokens.
  Dev stays $0 (unit tests mock the boundary); only the single sanctioned live E2E run spends, on a
  cheap model against a safe public site.
- Portfolio signal: "FounderOS composes an autonomous browser agent through its typed MCP client
  bridge with HITL preserved end-to-end — no bespoke integration."

## Verification
Unit ($0, mocked): `tests/unit/tools/browser-playwright.test.ts` (8 — dispatch, singleton reuse,
100k cap, soft-fail envelope, `closeBrowser` teardown) and the shipped-manifest classification tests
in `tests/unit/mcp/bridge-manifest.test.ts` (browser-use writes gated, reads read-through, key
forwarded by name). `pnpm test` + `pnpm lint` green. Bridge connect: `scripts/probe-browser-use.ts`
with `MCP_BRIDGE_ENABLED=true` confirms the server connects and enumerates its tools with correct
WRITE/read classification. One live run drives `retry_with_browser_use_agent` against a safe public
site (evidence = the real extracted page data). Real gateway E2E via `scripts/e2e-telegram-qa.ts`
(MTProto): an autonomous browse task → HITL card → approve → exact bot reply + matching `action_log`
row.
