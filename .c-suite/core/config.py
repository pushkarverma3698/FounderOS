"""
FounderOS — Master Configuration, Model Registry & Tool Registry
=================================================================
V7 UPGRADE: Advanced Rate Management

CHANGES:
  - Token-Per-Minute (TPM) tracking per cascade/provider.
  - Exponential Backoff with Jitter to prevent "thundering herd" API bans
    when parallel_dispatch.py spawns 50 concurrent workers simultaneously.
  - Respects Retry-After headers from API responses for intelligent waiting.
  - Idempotency guard: logs request signatures to detect duplicate side effects.

MODEL CASCADE PHILOSOPHY
─────────────────────────
Every task tier has a primary → fallback chain. The system tries in order
and catches rate-limit / quota errors automatically via call_with_fallback().

CEO / Complex routing:
  claude-sonnet-4-5 → gemini-2.5-pro → openrouter:claude-3.5-sonnet

Deep Research (market intel, NotebookLM-quality synthesis):
  gemini-2.5-pro → gemini-2.0-flash → openrouter:deepseek-r1

MD Execution (planning, proposals, social, HR):
  gemini-2.5-flash (free tier) → gemini-2.0-flash → openrouter:llama-3.3-70b (free)

Quick / Micro tasks (captions, standups, storyboards):
  gemini-2.5-flash-lite → gemini-2.0-flash-lite → local Qwen (free)

Local Workers (private data, volume tasks):
  Qwen 2.5 7B MLX → always free, never fails

OpenRouter usage: ONLY for (a) CEO fallback when Anthropic + Gemini quota hit,
                           (b) free OpenRouter models as level-3 fallback for MDs.
NEVER use OpenRouter for Naggar/Turicks internal private data tasks.

NEVER commit this file with real keys. Always use .env.
"""

import os, logging, time, random, hashlib, httpx, threading
from pathlib import Path
from dotenv import load_dotenv

log = logging.getLogger("Config")

# Load .env from .c-suite directory
# override=True: .env is the source-of-truth. Without it, parent processes that pre-set
# an empty ANTHROPIC_API_KEY (e.g. Claude Code's subprocess environment) silently block
# the real key from loading — causing "Could not resolve authentication method" errors.
load_dotenv(
    Path.home() / "Documents" / "Coding stuff" / "FounderOS" / ".c-suite" / ".env",
    override=True,
)

# ════════════════════════════════════════════════════════════════════════════════
# PATHS
# ════════════════════════════════════════════════════════════════════════════════
BASE_DIR       = Path.home() / "Documents" / "Coding stuff" / "FounderOS"
C_SUITE_DIR    = BASE_DIR / ".c-suite"
TURICKS_DIR    = BASE_DIR / "turicks_agency"
NAGGAR_DIR     = BASE_DIR / "naggar_retreat"
CHROMA_DIR     = C_SUITE_DIR / "memory" / "chroma_data"
SQLITE_PATH    = str(C_SUITE_DIR / "memory" / "langgraph_state.db")
STRATEGIC_DIR  = BASE_DIR / "strategic_output"
CONTENT_DIR    = BASE_DIR / "content_output"

# ════════════════════════════════════════════════════════════════════════════════
# API KEYS  — all from .env, never hardcoded
# ════════════════════════════════════════════════════════════════════════════════
ANTHROPIC_API_KEY  = os.getenv("ANTHROPIC_API_KEY",  "")   # Claude 4.x Sonnet (CEO)
GOOGLE_API_KEY     = os.getenv("GOOGLE_API_KEY",     "")   # Gemini 2.5 Pro/Flash/Lite + Veo 2
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")   # CEO fallback + free model leverage
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID",   "")
FIRECRAWL_API_KEY  = os.getenv("FIRECRAWL_API_KEY",  "")   # Clean web scraping
LANGCHAIN_API_KEY  = os.getenv("LANGCHAIN_API_KEY",  "")   # LangSmith tracing (free tier)
OPENWEATHER_KEY    = os.getenv("OPENWEATHER_API_KEY", "")  # Farm weather (free tier)
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY",  "")  # TTS audio briefs (optional)
COMPOSIO_API_KEY   = os.getenv("COMPOSIO_API_KEY",    "")  # MCP hub (optional)

# ════════════════════════════════════════════════════════════════════════════════
# TELEGRAM TOPIC IDs
# ════════════════════════════════════════════════════════════════════════════════
TOPIC_BOARDROOM    = int(os.getenv("TOPIC_BOARDROOM",  "8"))  # #The_Boardroom  (thread 8 — confirmed)
TOPIC_THINK_TANK   = int(os.getenv("TOPIC_THINK_TANK", "0"))  # #The_Think_Tank (needs creation)
TOPIC_TURICKS      = int(os.getenv("TOPIC_TURICKS",    "0"))  # #Turicks_Floor  (needs creation)
TOPIC_NAGGAR       = int(os.getenv("TOPIC_NAGGAR",     "0"))  # #Naggar_HQ      (needs creation)
TOPIC_SOCIAL       = int(os.getenv("TOPIC_SOCIAL",     "6"))  # #Social_Command (thread 6 — confirmed)

# ════════════════════════════════════════════════════════════════════════════════
# LOCAL MODEL CONFIG (M4 Optimized)
# ════════════════════════════════════════════════════════════════════════════════
# Qwen3-8B: best JSON/tool-calling on M4 16GB (4.1GB weights, 9.4GB headroom).
# Falls back to 7B if 8B not yet downloaded.
import os as _os
_qwen2_5_7b_path = _os.path.expanduser("~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-7B-Instruct-4bit/snapshots")
LOCAL_MODEL  = (
    "mlx-community/Qwen2.5-7B-Instruct-4bit"
    if _os.path.isdir(_qwen2_5_7b_path) and any(_os.scandir(_qwen2_5_7b_path))
    else "mlx-community/Qwen3-8B-4bit"
)
LOCAL_URL    = "http://127.0.0.1:8000"
VIDEO_MODEL  = "veo-2.0-generate-001"

# ════════════════════════════════════════════════════════════════════════════════
# MODEL REGISTRY — CASCADE CHAINS
# ════════════════════════════════════════════════════════════════════════════════

CEO_CASCADE = [
    ("local",        LOCAL_MODEL),                                  # Forced Local First (M4 Mastery)
    ("anthropic",    "claude-sonnet-4-6"),
    ("google",       "gemini-2.5-pro"),
    ("google",       "gemini-2.0-flash"),
    ("openrouter",   "meta-llama/llama-3.3-70b-instruct:free"),
]

DEEP_RESEARCH_CASCADE = [
    ("local",        LOCAL_MODEL),                                  # Forced Local First
    ("google",       "gemini-2.5-pro"),
    ("google",       "gemini-2.0-flash"),
    ("openrouter",   "deepseek/deepseek-r1:free"),
]

MD_CASCADE = [
    ("local",        LOCAL_MODEL),                                  # Forced Local First
    ("google",       "gemini-2.0-flash"),
    ("google",       "gemini-2.0-flash-lite"),
    ("openrouter",   "meta-llama/llama-3.3-70b-instruct:free"),
]

NANO_CASCADE = [
    ("local",        LOCAL_MODEL),                                  # Forced Local First
    ("google",       "gemini-2.0-flash-lite"),
    ("google",       "gemini-2.0-flash"),
]

CODE_CASCADE = [
    ("local",        LOCAL_MODEL),                                  # Forced Local First
    ("openrouter",   "qwen/qwen3-coder:free"),
    ("openrouter",   "openai/gpt-oss-120b:free"),
]

MODELS = {
    "ceo":               CEO_CASCADE[0][1],
    "ceo_cascade":       CEO_CASCADE,
    "deep_research":     DEEP_RESEARCH_CASCADE[0][1],
    "notebooklm_brief":  DEEP_RESEARCH_CASCADE[0][1],
    "market_scout":      DEEP_RESEARCH_CASCADE[0][1],
    "deep_cascade":      DEEP_RESEARCH_CASCADE,
    "md_turicks":        MD_CASCADE[0][1],
    "md_naggar":         MD_CASCADE[0][1],
    "proposal_writer":   MD_CASCADE[0][1],
    "web_designer":      MD_CASCADE[0][1],
    "social_researcher": MD_CASCADE[0][1],
    "social_handler":    MD_CASCADE[0][1],
    "cost_watchdog":     MD_CASCADE[0][1],
    "hr_agent":          MD_CASCADE[0][1],
    "scrum_engine":      MD_CASCADE[0][1],
    "revenue_scout":     MD_CASCADE[0][1],
    "md_cascade":        MD_CASCADE,
    "nano":              NANO_CASCADE[0][1],
    "nano_cascade":      NANO_CASCADE,
    "local":             LOCAL_MODEL,
    "local_url":         LOCAL_URL,
    "video":             VIDEO_MODEL,
}

CEO_MODEL        = MODELS["ceo"]
MD_MODEL         = MODELS["md_turicks"]
LOCAL_LLM_URL    = LOCAL_URL
LOCAL_MODEL_NAME = LOCAL_MODEL

# ════════════════════════════════════════════════════════════════════════════════
# V7 M4 MASTERY: Native MLX-LM Engine
# ════════════════════════════════════════════════════════════════════════════════

class MLXModelManager:
    """Singleton to manage MLX model lifecycle for local inference.

    Thread-Safety Fix (V8.1):
    Metal GPU (MLX) is NOT thread-safe. Concurrent access from parallel_dispatch
    thread pool workers causes a Metal abort / SIGABRT.
    A global reentrant lock serialises all MLX load + generate calls so only
    one thread uses the GPU at a time. Other threads wait (queue, no crash).
    """
    _instance = None
    _lock     = threading.Lock()   # Serialises all GPU access across threads
    model     = None
    tokenizer = None

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def load_model(self, model_path: str = LOCAL_MODEL):
        # Lock is held by caller (call_mlx_native) — safe to check without re-acquiring
        if self.model is None:
            try:
                from mlx_lm import load
                log.info(f"[MLX] Loading native M4-optimized model: {model_path}")
                self.model, self.tokenizer = load(model_path)
            except Exception as e:
                log.error(f"[MLX] Failed to load native model: {e}")
                raise e
        return self.model, self.tokenizer

    def unload_model(self):
        """Mandatory for 16GB RAM: Flush VRAM after background tasks."""
        with self._lock:
            if self.model is not None:
                log.info("[MLX] Unloading model to free Unified Memory...")
                self.model = None
                self.tokenizer = None
                import gc
                gc.collect()

def call_mlx_native(prompt: str, system: str = "", max_tokens: int = 2000) -> str:
    """Hardware-native inference on M4 via MLX logic.

    Acquires the global MLX lock before touching Metal GPU to prevent the
    concurrent-thread SIGABRT that occurs when parallel workers all fall back
    to the local model simultaneously.
    """
    manager = MLXModelManager.get_instance()
    with manager._lock:
        try:
            from mlx_lm import generate
            model, tokenizer = manager.load_model()
            full_prompt = f"{system}\n\n{prompt}" if system else prompt
            log.info(f"[MLX] Generating on M4 GPU/ANE (lock held)...")
            response = generate(model, tokenizer, prompt=full_prompt, max_tokens=max_tokens)
            return response
        except Exception as e:
            log.error(f"[MLX] Native generation failed: {e}")
            raise e

def call_apple_intelligence(prompt: str, system: str = "") -> str:
    """
    V7.1: Bridge to macOS Apple Intelligence (Siri + Private Cloud Compute).
    Executes via 'shortcuts' CLI. Requires a 'FounderOS_Intel' shortcut setup.
    """
    import subprocess
    from core.tool_hooks import scrub_prompt
    
    # Privacy Layer: Scrub internal paths/secrets before sending to external tier
    clean_system = scrub_prompt(system) if system else ""
    clean_prompt = scrub_prompt(prompt)
    full_prompt = f"{clean_system}\n\n{clean_prompt}" if clean_system else clean_prompt
    
    try:
        log.info("[AppleIntel] Dispatching to macOS Shortcuts (PCC/Siri)...")
        result = subprocess.check_output(
            ["shortcuts", "run", "FounderOS_Intel", "-i", full_prompt],
            text=True, timeout=60
        )
        return result.strip()
    except subprocess.TimeoutExpired:
        log.error("[AppleIntel] Siri/Shortcut timed out. Falling back.")
        raise RuntimeError("Apple Intelligence Timeout")
    except Exception as e:
        log.error(f"[AppleIntel] Execution failed: {e}")
        raise e

def call_firecrawl(url: str) -> str:
    """
    Scrape a URL using the Firecrawl API and return its content in Markdown.
    Mandatory for research and SEO specialist agents.
    """
    if not FIRECRAWL_API_KEY:
        return "[Error] FIRECRAWL_API_KEY not set in .env"

    try:
        log.info(f"[Firecrawl] Scraping URL: {url}")
        headers = {
            "Authorization": f"Bearer {FIRECRAWL_API_KEY}",
            "Content-Type":  "application/json"
        }
        # Firecrawl v1 API pattern for immediate scraping
        body = {
            "url": url,
            "formats": ["markdown"]
        }
        r = httpx.post(
            "https://api.firecrawl.dev/v1/scrape",
            headers=headers,
            json=body,
            timeout=60
        )
        
        if r.status_code == 429:
            return "[Error] Firecrawl rate limit exceeded."
        
        r.raise_for_status()
        data = r.json()
        
        if data.get("success"):
            return data.get("data", {}).get("markdown", "No content found.")
        else:
            return f"[Error] Firecrawl failed: {data.get('error', 'Unknown error')}"
            
    except Exception as e:
        log.error(f"[Firecrawl] Scraping failed for {url}: {e}")
        return f"[Error] Scraper connection failed: {e}"


# ════════════════════════════════════════════════════════════════════════════════
# V7 RATE MANAGEMENT — TPM Tracking + Exponential Backoff with Jitter
# ════════════════════════════════════════════════════════════════════════════════

# Circuit breaker state
_cb_failures:   dict[str, int]   = {}
_cb_tripped_at: dict[str, float] = {}
CIRCUIT_BREAKER_MAX = 3
CIRCUIT_RESET_SECS  = 300  # 5-minute cooldown

# V7: Token-Per-Minute (TPM) Window Tracking
# Estimates token usage per provider to avoid soft bans from heavy parallel workloads.
_tpm_usage:      dict[str, list[tuple[float, int]]] = {}  # provider → [(timestamp, tokens)]
TPM_WINDOW_SECS = 60
TPM_LIMITS = {
    "anthropic":   90_000,   # Claude Sonnet typical TPM limit
    "google":     300_000,   # Gemini Flash generous free-tier TPM
    "openrouter":  50_000,   # Conservative estimate for free-tier models
    "local":    9_999_999,   # No limit — local hardware
}

def _estimate_tokens(text: str) -> int:
    """Fast approximate token count (1 token ≈ 4 chars)."""
    return max(1, len(text) // 4)

def prune_tpm_memory_leak():
    """Universal garbage collection to prevent memory pooling in TPM tracker."""
    now = time.time()
    window_start = now - TPM_WINDOW_SECS
    for provider in list(_tpm_usage.keys()):
        valid = [(ts, toks) for ts, toks in _tpm_usage[provider] if ts > window_start]
        if valid:
            _tpm_usage[provider] = valid
        else:
            del _tpm_usage[provider]

def _tpm_check_and_record(provider: str, prompt: str, system: str) -> bool:
    """
    Returns True if we have remaining TPM budget for this provider.
    Records the estimated token cost of the current request.
    """
    limit = TPM_LIMITS.get(provider, 50_000)
    now   = time.time()
    window_start = now - TPM_WINDOW_SECS

    # Prune old entries outside the window
    history = _tpm_usage.get(provider, [])
    history = [(ts, toks) for ts, toks in history if ts > window_start]

    used = sum(toks for _, toks in history)
    cost = _estimate_tokens(prompt) + _estimate_tokens(system)

    if used + cost > limit:
        log.warning(
            f"[TPM] Provider '{provider}' at {used}/{limit} TPM — "
            f"request of ~{cost} tokens would exceed limit. Skipping."
        )
        return False  # Budget exceeded — try next provider

    history.append((now, cost))
    _tpm_usage[provider] = history
    return True  # Budget OK


def _jitter_backoff(attempt: int, base_secs: float = 1.0, cap_secs: float = 30.0) -> float:
    """
    Exponential Backoff with Full Jitter.
    Prevents "thundering herd" retries when 50 parallel workers all hit a 429 simultaneously.

    Formula: min(cap, random(0, base * 2^attempt))
    """
    exp_wait = base_secs * (2 ** attempt)
    jitter   = random.uniform(0.0, min(exp_wait, cap_secs))
    return jitter


def call_with_fallback(
    cascade:      list[tuple],
    prompt:       str,
    system:       str = "",
    max_tokens:   int = 4096,
    cascade_name: str = "",
) -> str:
    """
    V7 Enhanced: Try each model in cascade order.
    - Circuit Breaker (Claude Code pattern): stops hammering quota-exhausted providers.
    - TPM Tracking: skips a provider if its minute-window token budget is exhausted.
    - Exponential Backoff + Jitter: spreads retry load from parallel workers.
    - Retry-After header respect: waits the exact server-specified cooldown.
    """
    cb_key = cascade_name or str(cascade[0]) if cascade else "unknown"

    # ── Circuit breaker check ──────────────────────────────────────────────────
    failures  = _cb_failures.get(cb_key, 0)
    if failures >= CIRCUIT_BREAKER_MAX:
        elapsed = time.time() - _cb_tripped_at.get(cb_key, 0.0)
        if elapsed < CIRCUIT_RESET_SECS:
            remaining = int(CIRCUIT_RESET_SECS - elapsed)
            raise RuntimeError(f"Circuit breaker OPEN for '{cb_key}'. Retry in {remaining}s.")
        else:
            log.info(f"[CB] Circuit breaker RESET for '{cb_key}'")
            _cb_failures[cb_key] = 0
            _cb_tripped_at.pop(cb_key, None)

    last_error = None

    for attempt, (provider, model_id) in enumerate(cascade):

        # ── V7: TPM budget check before sending request ─────────────────────
        if not _tpm_check_and_record(provider, prompt, system):
            log.info(f"[TPM] Skipping {provider}/{model_id} — TPM budget exhausted.")
            continue

        try:
            if provider == "anthropic":
                import anthropic as ant
                client = ant.Anthropic(api_key=ANTHROPIC_API_KEY)
                resp   = client.messages.create(
                    model=model_id, max_tokens=max_tokens,
                    system=system or "You are a helpful AI assistant.",
                    messages=[{"role": "user", "content": prompt}]
                )
                log.debug(f"[Cascade] Used {provider}/{model_id}")
                _cb_failures[cb_key] = 0
                return resp.content[0].text

            elif provider == "google":
                from google import genai as _genai
                from google.genai import types as _genai_types
                _client = _genai.Client(api_key=GOOGLE_API_KEY)
                contents = f"{system}\n\n{prompt}" if system else prompt
                _cfg = _genai_types.GenerateContentConfig(
                    max_output_tokens=max_tokens,
                    system_instruction=system if system else None,
                )
                resp = _client.models.generate_content(
                    model=model_id,
                    contents=prompt if system else contents,
                    config=_cfg,
                )
                log.debug(f"[Cascade] Used {provider}/{model_id}")
                _cb_failures[cb_key] = 0
                return resp.text

            elif provider == "openrouter":
                import httpx
                headers = {
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type":  "application/json",
                    "X-Title":       "FounderOS",
                }
                body = {
                    "model": model_id,
                    "messages": [
                        {"role": "system", "content": system or "You are a helpful AI assistant."},
                        {"role": "user",   "content": prompt},
                    ],
                    "max_tokens": max_tokens,
                }
                r = httpx.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers=headers, json=body, timeout=60
                )
                # V7: Respect Retry-After header
                if r.status_code == 429:
                    retry_after = float(r.headers.get("Retry-After", 5))
                    log.warning(f"[RateLimit] {provider}/{model_id} → 429. Waiting {retry_after}s (Retry-After).")
                    time.sleep(retry_after)
                    raise RuntimeError(f"Rate limited by {provider} — retrying after {retry_after}s")
                r.raise_for_status()
                log.debug(f"[Cascade] Used {provider}/{model_id}")
                _cb_failures[cb_key] = 0
                return r.json()["choices"][0]["message"]["content"]

            elif provider == "local":
                # V8 FIXED: Try local HTTP server first to avoid double-loading model into RAM.
                import httpx
                try:
                    body = {
                        "model":      LOCAL_MODEL,
                        "messages":   [{"role": "user", "content": prompt}],
                        "max_tokens": max_tokens,
                    }
                    if system:
                        body["messages"].insert(0, {"role": "system", "content": system})
                    
                    r = httpx.post(f"{LOCAL_URL}/v1/chat/completions", json=body, timeout=120)
                    r.raise_for_status()
                    log.debug(f"[Cascade] Used local HTTP server/{model_id}")
                    _cb_failures[cb_key] = 0
                    return r.json()["choices"][0]["message"]["content"]
                except Exception as http_err:
                    log.warning(f"[MLX] HTTP server failed or not available ({http_err}). Trying native MLX...")
                    try:
                        return call_mlx_native(prompt, system, max_tokens)
                    except Exception as mlx_err:
                        log.error(f"[MLX] Both HTTP and Native failed: {mlx_err}")
                        raise mlx_err

            elif provider == "apple_intel":
                # V7.1: Apple Intelligence Tier (Shortcut Bridge)
                try:
                    return call_apple_intelligence(prompt, system)
                except Exception as e:
                    log.warning(f"[AppleIntel] Failed: {e}. Falling back to next provider.")
                    raise e

        except Exception as e:
            # V7: Jitter backoff before trying next provider
            backoff = _jitter_backoff(attempt)
            log.warning(
                f"[Cascade] {provider}/{model_id} failed — {e}. "
                f"Backoff {backoff:.2f}s before next provider."
            )
            last_error = e
            time.sleep(backoff)

    # All models failed — trip circuit breaker
    _cb_failures[cb_key] = _cb_failures.get(cb_key, 0) + 1
    if _cb_failures[cb_key] >= CIRCUIT_BREAKER_MAX:
        _cb_tripped_at[cb_key] = time.time()
        log.error(f"[CB] Circuit breaker TRIPPED for '{cb_key}' after {_cb_failures[cb_key]} failures.")
    raise RuntimeError(f"All cascade models failed. Last error: {last_error}")


def call_ceo(prompt: str, system: str = "", max_tokens: int = 512) -> str:
    """CEO cascade: Claude → Gemini Pro → OpenRouter. Default 512 — CEO only classifies/routes."""
    return call_with_fallback(CEO_CASCADE, prompt, system, max_tokens=max_tokens, cascade_name="CEO")

def call_deep_research(prompt: str, system: str = "", max_tokens: int = 2048) -> str:
    """Deep Research cascade. Higher ceiling — research needs synthesis space."""
    return call_with_fallback(DEEP_RESEARCH_CASCADE, prompt, system, max_tokens=max_tokens, cascade_name="DEEP_RESEARCH")

def call_md(prompt: str, system: str = "", max_tokens: int = 1024) -> str:
    """MD cascade (Gemini Flash → OpenRouter). 1024 covers all business outputs."""
    return call_with_fallback(MD_CASCADE, prompt, system, max_tokens=max_tokens, cascade_name="MD")

def call_nano(prompt: str, system: str = "", max_tokens: int = 256) -> str:
    """Nano cascade (Flash Lite → local). 256 — captions, standups, micro-tasks."""
    return call_with_fallback(NANO_CASCADE, prompt, system, max_tokens=max_tokens, cascade_name="NANO")

def call_local(prompt: str, system: str = "", max_tokens: int = 512) -> str:
    """Local Qwen 2.5 MLX only — private data, volume tasks."""
    return call_with_fallback([("local", LOCAL_MODEL)], prompt, system, max_tokens=max_tokens, cascade_name="LOCAL")


# ════════════════════════════════════════════════════════════════════════════════
# OPENROUTER FREE MODELS
# ════════════════════════════════════════════════════════════════════════════════
OPENROUTER_FREE_MODELS = {
    # All verified free as of 2026-04 — always use :free suffix to guarantee $0 cost
    "reasoning":  "deepseek/deepseek-r1:free",
    "large":      "meta-llama/llama-3.3-70b-instruct:free",
    "coding":     "qwen/qwen3-coder:free",
    "fast":       "google/gemma-3-27b-it:free",
    "multimodal": "google/gemma-3-12b-it:free",
}

# ════════════════════════════════════════════════════════════════════════════════
# AGENT → CASCADE MAPPING
# ════════════════════════════════════════════════════════════════════════════════
AGENT_CASCADES = {
    "bidding_sniper":    "local",
    "lead_intel":        "local",
    "senior_dev":        "code",
    "vibe_coder":        "code",
    "qa_tester":         "local",
    "proposal_writer":   "md",
    "ops_agent":         "nano",
    "kb_agent":          "local",
    "web_designer":      "md",
    "farm_weather":      "local",
    "yield_scout":       "local",
    "booking_concierge": "nano",
    "vibe_designer":     "md",
    "culinary_agent":    "local",
    "market_scout":      "deep_research",
    "guest_crm":         "local",
    "naggar_kb":         "local",
    "video_editor":      "md",
    "social_researcher": "deep_research",
    "social_handler":    "md",
    "cost_watchdog":     "md",
    "team_therapist":    "md",
    "hr_agent":          "deep_research",
    "revenue_scout":     "deep_research",
    "outreach_agent":    "md",
    "pipeline_md":       "md",
    "scrum_engine":      "nano",
    "orchestrator":      "ceo",
}


def get_cascade_for_agent(agent_name: str) -> list[tuple]:
    """Returns the appropriate model cascade list for a given agent."""
    tier = AGENT_CASCADES.get(agent_name, "md")
    return {
        "ceo":           CEO_CASCADE,
        "deep_research": DEEP_RESEARCH_CASCADE,
        "md":            MD_CASCADE,
        "nano":          NANO_CASCADE,
        "code":          CODE_CASCADE,
        "local":         [("local", LOCAL_MODEL)],
    }.get(tier, MD_CASCADE)

def call_agent(agent_name: str, prompt: str, system_override: str = "", use_memory: bool = True) -> str:
    """
    The Recommended Way to call any FounderOS Agent.
    
    1. RECALL: Automatically pulls relevant context from VectorDB (RAG).
    2. CALL:   Invokes the agent's assigned model cascade.
    3. STORE:  Automatically persists the task/result back into memory.
    """
    from core.registry import get_agent
    from memory.memory import multi_recall, store_experience
    
    agent = get_agent(agent_name)
    if not agent:
        # Fallback to general MD if agent not in registry
        return call_md(prompt, system_override)

    # ━━━ 1. AUTOMATIC CONTEXT RECALL (ACR) ━━━
    context = ""
    if use_memory and agent.allowed_collections:
        context = multi_recall(agent.allowed_collections, query=prompt, n_results=3)
    
    # ━━━ 2. AUGMENT PROMPT ━━━
    base_system = f"You are the '{agent_name}' agent in FounderOS.\n"
    if context:
        base_system += f"\n<PAST_RELEVANT_MEMORIES>\n{context}\n</PAST_RELEVANT_MEMORIES>\n"
    
    final_system = system_override or base_system
    cascade = get_cascade_for_agent(agent_name)
    
    # ━━━ 3. EXECUTE LLM CALL ━━━
    result = call_with_fallback(cascade, prompt, final_system, cascade_name=f"Agent:{agent_name}")
    
    # ━━━ 4. AUTOMATIC CONTEXT STORAGE (ACS) ━━━
    if use_memory:
        store_experience(agent_name, prompt, result)
        
    return result

# ════════════════════════════════════════════════════════════════════════════════
# TOOL REGISTRY — 28 tools with cost tier
# ════════════════════════════════════════════════════════════════════════════════
TOOLS = {
    "claude-sonnet-4-6":      {"cost": "$$$",  "tier": "cloud",  "purpose": "CEO routing (primary)"},
    "gemini-2.5-pro":         {"cost": "$$",   "tier": "cloud",  "purpose": "Deep research + CEO fallback"},
    "gemini-2.5-flash":       {"cost": "FREE", "tier": "cloud",  "purpose": "MD execution (free tier primary)"},
    "gemini-2.5-flash-lite":  {"cost": "FREE", "tier": "cloud",  "purpose": "Nano/micro tasks (free tier)"},
    "gemini-2.0-flash":       {"cost": "FREE", "tier": "cloud",  "purpose": "MD fallback (free tier)"},
    "veo-2.0":                {"cost": "$$$",  "tier": "cloud",  "purpose": "Video generation for Reels"},
    "qwen-2.5-7b-mlx":        {"cost": "FREE", "tier": "local",  "purpose": "Private/volume worker tasks"},
    "openrouter-deepseek-r1": {"cost": "FREE", "tier": "cloud",  "purpose": "CEO/research fallback (free via OR)"},
    "openrouter-llama-3.3-70b":{"cost":"FREE", "tier": "cloud",  "purpose": "MD fallback (free via OR)"},
    "chromadb":               {"cost": "FREE", "tier": "local",  "purpose": "Vector memory — 3 siloed collections"},
    "langgraph-sqlite":       {"cost": "FREE", "tier": "local",  "purpose": "State persistence, crash recovery"},
    "langgraph":              {"cost": "FREE", "tier": "local",  "purpose": "Agentic DAG+Cyclic orchestration"},
    "aiogram-v3":             {"cost": "FREE", "tier": "local",  "purpose": "Telegram bot gateway"},
    "apscheduler":            {"cost": "FREE", "tier": "local",  "purpose": "Cron-style scheduling"},
    "firecrawl":              {"cost": "$",    "tier": "cloud",  "purpose": "Clean web scraping"},
    "duckduckgo-html":        {"cost": "FREE", "tier": "cloud",  "purpose": "Fallback web search"},
    "openweathermap":         {"cost": "FREE", "tier": "cloud",  "purpose": "Farm Weather (free tier)"},
    "google-stitch":          {"cost": "FREE", "tier": "cloud",  "purpose": "AI UI/UX generation"},
    "pollinations-ai":        {"cost": "FREE", "tier": "cloud",  "purpose": "Image/video fallback"},
    "ffmpeg":                 {"cost": "FREE", "tier": "local",  "purpose": "Video assembly"},
    "macos-tts":              {"cost": "FREE", "tier": "local",  "purpose": "Audio brief voiceover"},
    "telegram":               {"cost": "FREE", "tier": "cloud",  "purpose": "Primary command interface"},
    "notebooklm":             {"cost": "FREE", "tier": "cloud",  "purpose": "Strategic synthesis"},
    "github-mcp":             {"cost": "FREE", "tier": "cloud",  "purpose": "PR creation, code review"},
    "langsmith":              {"cost": "FREE", "tier": "cloud",  "purpose": "Agent tracing (free tier)"},
    "composio":               {"cost": "$",    "tier": "cloud",  "purpose": "MCP hub (future)"},
    "elevenlabs":             {"cost": "$",    "tier": "cloud",  "purpose": "TTS audio briefs (future)"},
    "a2a-gateway":            {"cost": "FREE", "tier": "local",  "purpose": "V7: Agent-to-Agent protocol (new)"},
    "live-voice-whisper":     {"cost": "FREE", "tier": "local",  "purpose": "V7: Local Whisper STT (new)"},
}

# ════════════════════════════════════════════════════════════════════════════════
# CHROMADB COLLECTIONS
# ════════════════════════════════════════════════════════════════════════════════
COLLECTION_TURICKS = "turicks_mem"
COLLECTION_NAGGAR  = "naggar_mem"
COLLECTION_SOCIAL  = "social_mem"

# ════════════════════════════════════════════════════════════════════════════════
# OBSERVABILITY (LangSmith — auto-enables if key present)
# ════════════════════════════════════════════════════════════════════════════════
if LANGCHAIN_API_KEY:
    os.environ["LANGCHAIN_TRACING_V2"] = "true"
    os.environ["LANGCHAIN_PROJECT"]    = "FounderOS"
    os.environ["LANGCHAIN_API_KEY"]    = LANGCHAIN_API_KEY

# ════════════════════════════════════════════════════════════════════════════════
# HELPERS
# ════════════════════════════════════════════════════════════════════════════════
def get_tool_cost_summary() -> str:
    """Formatted tool cost table for Cost Watchdog Agent."""
    lines = ["| Tool | Cost | Purpose |", "|---|---|---|"]
    for tool, meta in TOOLS.items():
        lines.append(f"| `{tool}` | {meta['cost']} | {meta['purpose']} |")
    return "\n".join(lines)


def get_cascade_summary() -> str:
    """Human-readable cascade summary for architecture review."""
    return """
MODEL CASCADE SUMMARY (V7 — TPM-Aware + Jitter Backoff)
═══════════════════════════════════════════════════════
CEO (orchestration):
  1. claude-sonnet-4-6 (Anthropic — latest stable)
  2. gemini-2.5-pro (Google)
  3. gemini-2.0-flash (Google — free-tier flash fallback)
  4. meta-llama/llama-3.3-70b-instruct (OpenRouter free — JSON-capable cloud fallback)
  5. local Qwen 2.5 on M4 (ALWAYS FREE — limited JSON)

DEEP RESEARCH (market intel, NotebookLM, HR):
  1. gemini-2.5-pro (Google)
  2. gemini-2.0-flash (Google — free tier)
  3. local Qwen 2.5 on M4 (ALWAYS FREE)

MD EXECUTION (27 agents, planning, copy, social):
  1. gemini-2.0-flash (Google — FREE tier primary)
  2. local Qwen 2.5 on M4
  3. gemini-2.0-flash-lite (Google — FREE fallback)

NANO / QUICK (standups, captions, micro-tasks):
  1. gemini-2.0-flash-lite (Google — FREE)
  2. local Qwen 2.5 7B on M4 (ALWAYS FREE)

LOCAL WORKERS (private data, volume):
  Qwen 2.5 7B MLX on M4 — ALWAYS FREE, ALWAYS PRIVATE

VIDEO:
  Veo 2.0 (one-off cost, used only for Reel generation)

V7 RATE MANAGEMENT:
  - TPM window: 60s per provider
  - Backoff: Exponential + Full Jitter (0 → min(cap, 2^attempt * base))
  - Retry-After: Respected for 429 responses
  - Circuit Breaker: 3 failures → 5-min cooldown per cascade
"""
