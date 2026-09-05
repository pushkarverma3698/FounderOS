# OmniRouter Deep Capability & Hidden Features Audit

**Audit Date:** 2026-08-30
**Database Source:** `~/.omniroute/storage.sqlite`
**Active Endpoint:** `http://127.0.0.1:20128/v1`

---

## 1. Five Hidden Superpowers Discovered

Our deep audit discovered 5 core capabilities built into your OmniRouter instance that were previously undocumented:

### 1. `auto/*` Meta-Routers (36 Virtual Dynamic Models)
Instead of guessing which account or provider to use, you can point your tools to high-level intent aliases:
- `auto/best-coding`: Automatically routes to the highest-ELO active coding model (Sonnet 5 / GPT-5.6 Pro).
- `auto/best-free`: Automatically routes exclusively across free endpoints (Gemini Web, ChatGPT Web Free, DeepSeek Web, OpenRouter Free).
- `auto/best-fast`: Routes to lowest-latency endpoints (`gemini-3.5-flash` or `ddgw/claude-3-5-haiku`).
- `auto/best-reasoning`: Dispatches to full chain-of-thought models (Nemotron 550B, GPT-5.5 Thinking, Gemini 3.1 Pro).

### 2. `no-think/*` Zero-Latency Fast Execution (28 Models)
- Standard Claude and GPT thinking models spend 5–15 seconds generating hidden reasoning tokens before outputting text.
- Calling `no-think/<model_name>` (e.g. `no-think/claude-web/claude-sonnet-5` or `no-think/chatgpt-web/gpt-5.5`) suppresses the thinking delay for autonomous loops, returning answers in **< 1.2 seconds**.

### 3. Built-In Semantic & Prompt Caching (`semantic_cache`)
- OmniRouter has a 30-minute semantic cache enabled (`TTL = 1800000ms`).
- Repeated prompts, test runs, and static system prompt tokens return in **0ms** with **0 tokens consumed**.

### 4. Caveman Prompt Compression Engine (`cavemanConfig`)
- Enabled by default in configuration.
- Compresses large prompt payloads (stripping boilerplate whitespace, redundant formatting, and token bloat) before dispatching to upstream providers, saving **30% to 50% token space**.

### 5. `agent_bridge_mappings` (Zero-Config Harness Bridge)
- Remaps legacy or hardcoded agent model requests (from Cursor, Claude Code, Cline, Aider) directly to your authenticated high-capacity web sessions without modifying client code.

---

## 2. Complete Family Breakdown of All 262 Available Models

| Prefix | Count | Function | Example Model |
| :--- | :--- | :--- | :--- |
| `auto/` | 36 | Task-based smart auto-routing | `auto/best-coding`, `auto/best-free` |
| `no-think/` | 28 | Fast execution (thinking suppressed) | `no-think/claude-web/claude-sonnet-5` |
| `tllm/` | 26 | Universal OpenAI-compatible shims | `tllm/deepseek_v4`, `tllm/sonar-pro` |
| `antigravity/` | 20 | Google Antigravity OAuth models | `antigravity/claude-opus-4-6-thinking` |
| `agy/` | 15 | AGY Direct multi-account cluster | `agy/claude-sonnet-4-6` |
| `deepseek-web/` | 28 | DeepSeek Web free reasoning models | `deepseek-web/deepseek-r1` |
| `openrouter/` | 34 | OpenRouter API + `:free` catalog | `openrouter/nvidia/nemotron-3-ultra:free` |
| `chatgpt-web/` | 13 | ChatGPT Web 3-account cluster | `chatgpt-web/gpt-5.6-pro` |
| `aug/` | 12 | Web-augmented context models | `aug/gemini-3.1-pro`, `aug/kimi-k2.6` |
| `claude/` / `cw/` | 15 | Claude Web + Claude Code sessions | `claude-web/claude-sonnet-5` |
| `gemini-web/` | 13 | Gemini Web 3-account Chromium | `gemini-web/gemini-3.1-pro` |
| `oc/` | 8 | OpenCode community models | `oc/minimax-m3-free`, `oc/qwen3.6-plus-free` |
| `ddgw/` | 6 | DuckDuckGo Web anonymous models | `ddgw/gpt-4o-mini`, `ddgw/claude-3-5-haiku` |
| `veo-free/` | 6 | Free AI video generation | `veo-free/veo`, `veo-free/seedance` |
| `mimocode/` | 2 | MiMo Code specialized API | `mimocode/mimo-v2.5-pro` |
| `pepper/` | 1 | Pepper fast-agent experimental | `pepper/pepper-1` |
