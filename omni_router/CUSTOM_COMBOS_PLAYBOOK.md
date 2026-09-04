# OmniRouter Custom Combos & Fallback Chains Playbook

> **How to create personalized multi-model waterfall chains with custom aliases**

---

## 1. Concept: What is a Combo?

In OmniRouter, a **Combo** is a virtual model alias mapped to a prioritized sequence of backend models. Instead of hardcoding a single model into your agent or IDE, you call your custom alias (e.g., `pushkar/hero-coder`). 

When a request arrives:
1. OmniRouter tries **Tier 1**.
2. If Tier 1 hits a rate limit (429), server error (503/500), timeout, or message cooldown, it **instantly cascades to Tier 2**.
3. It steps down to **Tier 3** and **Tier 4** if needed.
4. Your client receives the completed response without experiencing errors or interruptions.

```
                           ┌───────────────────────────┐
                           │ User Request:             │
                           │ "pushkar/architect"       │
                           └─────────────┬─────────────┘
                                         │
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │ Tier 1: claude-web/claude-sonnet-5            │
                 │ Status: [429 Cooldown / Rate Limit] ──► (Skip)│
                 └───────────────────────┬───────────────────────┘
                                         │ (Instant Fallback)
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │ Tier 2: chatgpt-web/gpt-5.5                   │
                 │ Status: [200 OK - Streaming Token Stream]     │
                 └───────────────────────────────────────────────┘
```

---

## 2. Recommended Custom Fallback Blueprints

### Blueprint A: `pushkar/hero-coder` (Autonomous Coding & Architecture)
*Designed for deep diffs, multi-file refactoring, and code review.*

1. **Tier 1 (Primary):** `claude-web/claude-sonnet-5` (Deepest syntactic precision and AST understanding)
2. **Tier 2 (Fallback 1):** `chatgpt-web/gpt-5.5` (Fastest flagship fallback across 3 rotating accounts)
3. **Tier 3 (Fallback 2):** `deepseek-web/DeepSeek-R1` (High-reasoning open logic fallback)
4. **Tier 4 (Safety Net):** `gemini-web/gemini-3.1-pro` (1M context safety net across 3 Google accounts)

---

### Blueprint B: `pushkar/deep-thinker` (Complex Math, Planning & Logic)
*Designed for architecture design, PR review gate checks, and benchmark planning.*

1. **Tier 1 (Primary):** `deepseek-web/DeepSeek-R1` (Dedicated chain-of-thought reasoner)
2. **Tier 2 (Fallback 1):** `chatgpt-web/o3` (OpenAI o3 deep reasoning engine)
3. **Tier 3 (Fallback 2):** `chatgpt-web/gpt-5.6-thinking` (Advanced logic synthesis)
4. **Tier 4 (Safety Net):** `antigravity/claude-opus-4-6-thinking` (Claude Opus Thinking)

---

### Blueprint C: `pushkar/speed-agent` (High-Frequency RAG, Summarization & Git)
*Designed for zero-latency background cron jobs, PR summaries, and file reading.*

1. **Tier 1 (Primary):** `gemini-web/gemini-3.5-flash` (Sub-second response time)
2. **Tier 2 (Fallback 1):** `claude-web/claude-haiku-4-5` (Lightweight token classifier)
3. **Tier 3 (Fallback 2):** `gemini-web/gemini-3.1-flash-lite` (Ultra-low latency turn)
4. **Tier 4 (Safety Net):** `ddgw/gpt-5-mini` (DuckDuckGo anonymous proxy)

---

## 3. Step-by-Step Setup in OmniRouter Dashboard

1. **Open Web Dashboard:** Go to `http://localhost:20128/dashboard`.
2. **Navigate to Combos:** Click on **"Combos"** in the sidebar.
3. **Create New Combo:**
   - **Combo Name:** `pushkar/hero-coder`
   - **Strategy:** Select `Priority Waterfall` (or `Round-Robin Load Balance`).
4. **Add Model Sequence:**
   - Add `claude-web/claude-sonnet-5` (Priority: 100)
   - Add `chatgpt-web/gpt-5.5` (Priority: 90)
   - Add `deepseek-web/DeepSeek-R1` (Priority: 80)
   - Add `gemini-web/gemini-3.1-pro` (Priority: 70)
5. **Set Triggers:** Enable fallback on `429 Too Many Requests`, `5xx Errors`, and `Timeout > 15s`.
6. **Save.**

---

## 4. How to Call Your Custom Combo in Any Client

### Cursor / VS Code / Roo Code:
* **Base URL:** `http://127.0.0.1:20128/v1`
* **API Key:** `OmniRouter_Key` (or any string)
* **Model:** `pushkar/hero-coder`

### Python (`openai` SDK):
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:20128/v1",
    api_key="OmniRouter_Key"
)

response = client.chat.completions.create(
    model="pushkar/hero-coder",
    messages=[{"role": "user", "content": "Refactor src/agents/model.ts cleanly"}],
    temperature=0.2
)
print(response.choices[0].message.content)
```

### Node.js / TypeScript (`openai` SDK):
```typescript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://127.0.0.1:20128/v1",
  apiKey: "OmniRouter_Key",
});

const completion = await openai.chat.completions.create({
  model: "pushkar/hero-coder",
  messages: [{ role: "user", content: "Audit all active model endpoints." }],
});

console.log(completion.choices[0].message.content);
```
