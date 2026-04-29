"""
LLM dispatch for department supervisors + workers.

Priority order (saves rate limits, keeps data local):
  1. LOCAL MLX  — Qwen3-8B on-device (free, private, fast on M4)
                   Used for: nano / local tier agents
  2. OpenRouter  — free-tier cloud models
                   Used for: md / deep_research / ceo / code tiers
                   Fallback for nano/local if MLX unavailable

Switching is automatic. If Qwen3-8B isn't downloaded yet, falls back to Qwen2.5-7B.
If both MLX models fail, falls through to OpenRouter as usual.
"""
from __future__ import annotations
import os, time, json, threading, requests

OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")

# ─────────────────────────────────────────────
# 1. LOCAL MLX ENGINE
# ─────────────────────────────────────────────
_mlx_lock = threading.Lock()          # Metal GPU is not thread-safe
_mlx_model = None
_mlx_tokenizer = None
_mlx_model_id = None

LOCAL_TIERS = {"nano", "local", "md"}  # all run MLX first; only ceo/deep_research/code use cloud


def _resolve_local_model() -> str:
    """Pick best available local model."""
    candidates = [
        "mlx-community/Qwen3-8B-4bit",
        "mlx-community/Qwen2.5-7B-Instruct-4bit",
    ]
    hub = os.path.expanduser("~/.cache/huggingface/hub")
    for c in candidates:
        slug = "models--" + c.replace("/", "--")
        snap = os.path.join(hub, slug, "snapshots")
        if os.path.isdir(snap):
            try:
                if any(os.scandir(snap)):
                    return c
            except Exception:
                continue
    return candidates[-1]   # attempt anyway (will error gracefully)


def call_mlx(system: str, user: str, max_tokens: int = 500) -> tuple[str, str]:
    """Run inference on-device via MLX. Thread-safe (single lock)."""
    global _mlx_model, _mlx_tokenizer, _mlx_model_id
    model_id = _resolve_local_model()
    with _mlx_lock:
        try:
            from mlx_lm import load, generate   # type: ignore
            if _mlx_model is None or _mlx_model_id != model_id:
                _mlx_model, _mlx_tokenizer = load(model_id)
                _mlx_model_id = model_id

            # Qwen3 supports /think and /no_think control tokens.
            # For tool-calling we want /no_think (deterministic, fast).
            messages = [
                {"role": "system", "content": system},
                {"role": "user",   "content": user + "\n/no_think"},
            ]
            if hasattr(_mlx_tokenizer, "apply_chat_template"):
                prompt = _mlx_tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
            else:
                prompt = f"{system}\n\n{user}"

            out = generate(_mlx_model, _mlx_tokenizer,
                           prompt=prompt, max_tokens=max_tokens,
                           verbose=False)
            # Strip Qwen3 <think>...</think> blocks if any slipped through
            import re
            out = re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()
            if not out:
                raise RuntimeError("empty MLX output")
            return out, model_id
        except Exception as e:
            raise RuntimeError(f"MLX: {e}")


# ─────────────────────────────────────────────
# 2. OPENROUTER ENGINE
# ─────────────────────────────────────────────
_BIG  = ["nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-oss-120b:free",
         "meta-llama/llama-3.3-70b-instruct:free", "nousresearch/hermes-3-llama-3.1-405b:free"]
_MID  = ["google/gemma-3-27b-it:free", "openai/gpt-oss-20b:free",
         "qwen/qwen3-next-80b-a3b-instruct:free", "meta-llama/llama-3.3-70b-instruct:free"]
_SMALL = ["google/gemma-3-12b-it:free", "nvidia/nemotron-nano-9b-v2:free",
          "openai/gpt-oss-20b:free", "meta-llama/llama-3.3-70b-instruct:free"]
_CODE = ["qwen/qwen3-coder:free", "meta-llama/llama-3.3-70b-instruct:free",
         "openai/gpt-oss-120b:free"]

TIER_OR_MODELS = {
    "ceo": _BIG, "deep_research": _BIG,
    "md": _MID, "video": _MID,
    "nano": _SMALL, "local": _SMALL,
    "code": _CODE,
}


def call_openrouter(models: list[str], system: str, user: str, max_tokens: int) -> tuple[str, str]:
    last_err = ""
    for m in models:
        for attempt in range(2):
            try:
                r = requests.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {OPENROUTER_KEY}",
                        "Content-Type": "application/json",
                        "HTTP-Referer": "https://founderos.local",
                        "X-Title": "FounderOS Departments",
                    },
                    json={
                        "model": m, "max_tokens": max_tokens, "temperature": 0.4,
                        "messages": [
                            {"role": "system", "content": system[:2500]},
                            {"role": "user",   "content": user[:5000]},
                        ],
                    },
                    timeout=120,
                )
                if r.status_code != 200:
                    raise RuntimeError(f"{r.status_code}: {r.text[:120]}")
                data = r.json()
                content = (data["choices"][0]["message"] or {}).get("content", "")
                if not content.strip():
                    raise RuntimeError("empty content")
                return content.strip(), m
            except Exception as e:
                last_err = f"{m}: {e}"
                if "429" in str(e) or "rate" in str(e).lower():
                    time.sleep(2 + attempt * 4)
                    continue
                break
    raise RuntimeError(f"OpenRouter exhausted: {last_err}")


# ─────────────────────────────────────────────
# 3. UNIFIED DISPATCH
# ─────────────────────────────────────────────
def call_llm(tier: str, system: str, user: str, max_tokens: int = 500) -> tuple[str, str]:
    """
    Route by tier:
      nano / local  → MLX first (free, private) → OpenRouter fallback
      everything else → OpenRouter
    Returns (text, model_id_used).
    """
    if tier in LOCAL_TIERS:
        try:
            return call_mlx(system, user, max_tokens)
        except Exception as mlx_err:
            pass  # fall through to OpenRouter
    # Cloud path
    or_models = TIER_OR_MODELS.get(tier, _MID)
    return call_openrouter(or_models, system, user, max_tokens)


def call_llm_json(tier: str, system: str, user: str, max_tokens: int = 400) -> dict:
    """Force JSON output. Falls back gracefully if parse fails."""
    sys2 = system + "\n\nReply ONLY with valid JSON, no markdown fences, no extra prose."
    text, model = call_llm(tier, sys2, user, max_tokens)
    t = text.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
    try:
        return json.loads(t)
    except Exception:
        i, j = t.find("{"), t.rfind("}")
        if i != -1 and j > i:
            try:
                return json.loads(t[i:j+1])
            except Exception:
                pass
    return {"_raw": text}
