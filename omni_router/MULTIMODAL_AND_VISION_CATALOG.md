# OmniRouter Multimodal, Vision & Media Capabilities Catalog

**Audit Date:** 2026-08-30
**Endpoint:** `http://127.0.0.1:20128/v1`

---

## 1. Vision & Multimodal Input Models (Context Lengths & Limits)

These models accept images, screenshots, diagrams, PDFs, and multimodal input alongside text.

| Model ID | Provider | Context Window (Tokens) | Input Modalities | Output |
| :--- | :--- | :--- | :--- | :--- |
| `chatgpt-web/gpt-5.6-pro` | ChatGPT Web | **1,050,000** | Text, Image | Text |
| `chatgpt-web/gpt-5.6-thinking` | ChatGPT Web | **1,050,000** | Text, Image | Text |
| `chatgpt-web/gpt-5.5-pro` | ChatGPT Web | **1,050,000** | Text, Image | Text |
| `chatgpt-web/gpt-5.5-pro-extended`| ChatGPT Web | **1,050,000** | Text, Image | Text |
| `chatgpt-web/gpt-5.5-thinking` | ChatGPT Web | **1,050,000** | Text, Image | Text |
| `chatgpt-web/gpt-5.5` | ChatGPT Web | **1,050,000** | Text, Image | Text, Image |
| `gemini-web/gemini-3.1-pro` | Gemini Web | **1,048,576** | Text, Image, Audio | Text |
| `gemini-web/gemini-3.5-flash` | Gemini Web | **1,048,576** | Text, Image, Audio | Text |
| `gemini-web/gemini-3.1-flash-lite`| Gemini Web | **1,000,000** | Text, Image, Audio | Text |
| `claude-web/claude-sonnet-5` | Claude Web | **1,000,000** | Text, Image | Text |
| `claude-web/claude-sonnet-4-6` | Claude Web | **1,000,000** | Text, Image | Text |
| `claude-web/claude-haiku-4-5` | Claude Web | **200,000** | Text, Image | Text |
| `antigravity/claude-opus-4-6-thinking`| Antigravity | **200,000** | Text, Image | Text |
| `antigravity/claude-sonnet-5` | Antigravity | **200,000** | Text, Image | Text |
| `antigravity/gemini-3.1-pro-high`| Antigravity | **1,048,576** | Text, Image | Text |
| `antigravity/gemini-3.5-flash-high`| Antigravity | **1,048,576** | Text, Image | Text |
| `oc/minimax-m3-free` | OpenCode | **1,048,576** | Text, Image | Text |
| `oc/qwen3.6-plus-free` | OpenCode | **200,000** | Text, Image | Text |
| `openrouter/google/gemma-4-31b-it:free`| OpenRouter Free | **262,144** | Text, Image | Text |
| `openrouter/google/gemma-4-26b-a4b-it:free`| OpenRouter Free | **262,144** | Text, Image | Text |
| `openrouter/nvidia/nemotron-3-nano-omni-30b:free`| OpenRouter Free | **256,000** | Text, Image, Audio | Text |
| `openrouter/minimax/minimax-m3:free`| OpenRouter Free | **1,048,576** | Text, Image | Text |
| `ddgw/gpt-4o-mini` | DuckDuckGo Web | **128,000** | Text, Image | Text |
| `ddgw/claude-3-5-haiku-20241022` | DuckDuckGo Web | **200,000** | Text, Image | Text |

---

## 2. OpenRouter Free Catalog Breakdown (`:free` Models)

OpenRouter does **not** offer free video generation (video models like Kling/Wan are paid per second). However, OpenRouter provides a verified pool of 100% free LLM, coding, reasoning, and vision models.

With our **2 configured OpenRouter accounts**, rate limits are automatically doubled across all `:free` models:

| Free OpenRouter Model | Context Tokens | Primary Specialty |
| :--- | :--- | :--- |
| `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | 128,000 | Massive 550B flagship reasoning & architecture |
| `openrouter/nvidia/nemotron-3-super-120b-a12b:free` | 128,000 | Fast 120B parameter coding model |
| `openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256,000 | Lightweight Multimodal (Text + Image + Audio) |
| `openrouter/nvidia/nemotron-3.5-lightning:free` | 128,000 | Ultra-fast agentic tool execution |
| `openrouter/google/gemma-4-31b-it:free` | 262,144 | Google Vision-Language 31B instruction tuned |
| `openrouter/google/gemma-4-26b-a4b-it:free` | 262,144 | Google Vision-Language 26B model |
| `openrouter/minimax/minimax-m3:free` | 1,048,576 | 1M Context Window Multimodal reasoning |
| `openrouter/minimax/minimax-m2.7:free` | 1,048,576 | 1M Context Window Long document analysis |
| `openrouter/z-ai/glm-5.2:free` | 128,000 | GLM-5.2 conversational & agent reasoning |
| `openrouter/poolside/laguna-s-2.1:free` | 128,000 | Poolside dedicated coding model |
| `openrouter/cohere/north-mini-code:free` | 128,000 | Cohere code parsing & syntax logic |
| `openrouter/openrouter/free` | 200,000 | OpenRouter dynamic load-balanced free router |

---

## 3. Image Generation Models (Text-to-Image Output)

These models synthesize raster images based on textual prompts.

| Model ID | Provider | Engine / Resolution | Capabilities |
| :--- | :--- | :--- | :--- |
| `openrouter/black-forest-labs/flux.2-max` | OpenRouter | Flux.2 Max Engine | Highest quality photorealism |
| `openrouter/black-forest-labs/flux.2-pro` | OpenRouter | Flux.2 Pro Engine | Production asset generation |
| `openrouter/black-forest-labs/flux.2-flex`| OpenRouter | Flux.2 Flex Engine | High speed generation |
| `openrouter/openai/gpt-5.4-image-2` | OpenRouter | OpenAI Image Gen 2 | Text typography + graphic layout |
| `openrouter/openai/gpt-5-image-mini` | OpenRouter | OpenAI Image Mini | Fast UI mockup generation |
| `openrouter/google/gemini-3.1-flash-image-preview`| OpenRouter | Imagen 3 / Gemini | Stylized art & diagram rendering |
| `openrouter/google/gemini-3-pro-image-preview` | OpenRouter | Imagen 3 Pro | High-fidelity asset pipeline |
| `antigravity/gemini-3.1-flash-image` | Antigravity | Google Imagen Direct | Vector/raster asset drafts |
| `chatgpt-web/gpt-5.5` | ChatGPT Web | Native Image Output | Web session image creation |

---

## 4. Video Generation Models & Daily Capacity Limits

### Why Video is Free on OmniRouter vs Paid on OpenRouter:
* **OpenRouter Video Models (Paid):** Models such as Kling, Wan 2.1, and MiniMax Video on OpenRouter require account billing and are priced per second of footage ($0.05 – $0.20 / sec).
* **OmniRouter Video Endpoints (Free):** Our local endpoints bypass API billing by reverse-engineering automated web worker sessions.

| Model ID | Provider | Clip Duration | Output Format | Daily Capacity Estimate |
| :--- | :--- | :--- | :--- | :--- |
| `veo-free/veo` *(or `veoaifree-web/veo`)* | Veo AI Free | 4 – 6 seconds | MP4 (1080p/720p) | ~15 – 30 clips / day |
| `veo-free/seedance` *(or `veoaifree-web/seedance`)*| Veo AI Free | 4 – 6 seconds | MP4 (Motion sync) | ~15 – 30 clips / day |
| **Combined Video Output** | — | — | — | **~20 – 50 clips / day (~2 to 5 mins footage)** |

*Operational Note:* Video generation takes 45–90 seconds per clip. Set client HTTP timeouts to at least `120s`.

---

## 5. Audio & Semantic Embeddings Catalog

| Model ID | Provider | Type / Dimensions | Context Window |
| :--- | :--- | :--- | :--- |
| `openrouter/google/lyria-3-pro-preview` | OpenRouter | Audio / Music Gen | 1,048,576 tokens |
| `openrouter/google/lyria-3-clip-preview` | OpenRouter | Short Audio Clips | 1,048,576 tokens |
| `openrouter/cohere/rerank-4-pro` | OpenRouter | Semantic Reranker | 200,000 tokens |
| `openrouter/cohere/rerank-4-fast` | OpenRouter | Fast Reranker | 200,000 tokens |
| `openrouter/cohere/rerank-v3.5` | OpenRouter | Cohere V3.5 Reranker | 128,000 tokens |
| `openrouter/openai/text-embedding-3-large` | OpenRouter | 3,072 dimensions | 8,191 tokens |
| `openrouter/openai/text-embedding-3-small` | OpenRouter | 1,536 dimensions | 8,191 tokens |
| `gemini/gemini-embedding-2` | Google API | 1,536 / 3,072 dims | 32,768 tokens |
| `gemini/gemini-embedding-001` | Google API | 768 dimensions | 2,048 tokens |
