# OmniRouter Architecture, Setup & Operations Runbook

> **Single Source of Truth for Local AI Gateway & Multi-Account Reverse Routing**
> **Gateway Endpoint:** `http://127.0.0.1:20128/v1` (OpenAI Compatible)
> **Web Dashboard:** `http://127.0.0.1:20128/dashboard`
> **Local Database:** `~/.omniroute/storage.sqlite`

---

## 1. System Overview

OmniRouter is our local, high-throughput unified AI gateway. It consolidates **262 active models** across **16 backend provider families**, multiplexing requests across free web reverse-engineered sessions (Playwright Chromium & token pools), direct OAuth CLI accounts, and multi-key API providers.

```
                                    ┌───────────────────────────────────┐
                                    │    Developer / Agent Clients      │
                                    │   (Cursor / Antigravity / CLI)    │
                                    └─────────────────┬─────────────────┘
                                                      │ (OpenAI-compatible)
                                                      ▼
                                    ┌───────────────────────────────────┐
                                    │     OmniRouter Local Gateway      │
                                    │      http://127.0.0.1:20128       │
                                    │  [Semantic Cache | Caveman Comp]  │
                                    └─────────────────┬─────────────────┘
                                                      │
         ┌──────────────────┬─────────────────────────┼────────────────────────┬───────────────────┐
         ▼                  ▼                         ▼                        ▼                   ▼
  ┌──────────────┐   ┌──────────────┐          ┌──────────────┐         ┌──────────────┐    ┌──────────────┐
  │ ChatGPT Web  │   │  Gemini Web  │          │  Claude Web  │         │ DeepSeek Web │    │  OpenRouter  │
  │ (3 Accounts) │   │ (3 Accounts) │          │ (3 Accounts) │         │ (1 Account)  │    │ (2 Accounts) │
  │ NextAuth JWT │   │ Chromium GUI │          │ Session JWT  │         │ Bearer Token │    │ Rotated Keys │
  └──────────────┘   └──────────────┘          └──────────────┘         └──────────────┘    └──────────────┘
```

---

## 2. Directory Index & Documentation Suite

* **[`DEEP_CAPABILITY_AUDIT.md`](./DEEP_CAPABILITY_AUDIT.md)** — **(NEW)** Deep audit of all 5 hidden superpowers: `auto/*` (36 meta-models), `no-think/*` (28 speed models), semantic cache, caveman compressor, and agent bridge mappings.
* **[`ACCOUNTS_AND_CAPACITY.md`](./ACCOUNTS_AND_CAPACITY.md)** — Verified audit of all 18 connected accounts across services with empirical token throughput measurements (~13.3M–23.2M tokens/day).
* **[`MULTIMODAL_AND_VISION_CATALOG.md`](./MULTIMODAL_AND_VISION_CATALOG.md)** — Exact token context lengths, vision input resolutions, image/video generation models (`veo-free/veo`), and audio embeddings.
* **[`CUSTOM_COMBOS_PLAYBOOK.md`](./CUSTOM_COMBOS_PLAYBOOK.md)** — Blueprint for designing 4-tier waterfall fallback chains and custom alias naming.

---

## 3. Quick Runbook: Keeping OmniRouter Operational

### A. Process Verification
OmniRouter runs as a native Node.js process listening on port `20128`.
```bash
lsof -i :20128
```

### B. Health Probe & Discovery
To test that the models gateway is live:
```bash
curl -s http://127.0.0.1:20128/v1/models | jq '.data | length'
```

### C. Live Ping Tests

1. **Auto-Routing Free Tier Test:**
```bash
curl -s -X POST http://127.0.0.1:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto/best-free","messages":[{"role":"user","content":"ping"}]}'
```

2. **Ultra-Fast No-Thinking Tool Test:**
```bash
curl -s -X POST http://127.0.0.1:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"no-think/chatgpt-web/gpt-5.5","messages":[{"role":"user","content":"ping"}]}'
```

### D. Playwright Browser Cache (Required for Gemini Web)
Gemini Web relies on Playwright Chromium installed at:
`~/Library/Caches/ms-playwright/chromium-1228/`
If 503 errors occur after a system update, run:
```bash
npx playwright install chromium
```
