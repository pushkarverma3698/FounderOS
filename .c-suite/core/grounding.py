"""
FounderOS — Memory Grounding
=============================
ANTI-HALLUCINATION layer. Before any LLM call that answers a Chairman question,
inject verified facts from ChromaDB so the model is forced to ground its
response in real data (career_mem, turicks_mem, naggar_mem, social_mem).

Usage:
    from core.grounding import build_grounded_system, ground_topic

    system = build_grounded_system(
        role_prompt="You are Kai, Chief of Staff.",
        collections=["turicks_mem", "social_mem"],
        query=user_text,
    )
"""
from __future__ import annotations
import logging
from typing import List

import chromadb

log = logging.getLogger("Grounding")

CHROMA_PATH = "/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite/memory/chroma_data"
_client = None

def _get_client():
    global _client
    if _client is None:
        _client = chromadb.PersistentClient(path=CHROMA_PATH)
    return _client


def recall_facts(collection_name: str, query: str, n: int = 3) -> List[str]:
    """Pull top-N relevant docs from a collection. Never raises."""
    try:
        client = _get_client()
        col = client.get_or_create_collection(collection_name)
        if col.count() == 0:
            return []
        res = col.query(query_texts=[query], n_results=min(n, col.count()))
        docs = res.get("documents") or []
        return docs[0] if docs else []
    except Exception as e:
        log.warning(f"[Grounding] recall failed for {collection_name}: {e}")
        return []


# Anti-hallucination preamble that goes on EVERY grounded prompt
ANTI_HALLU = (
    "RULES (follow exactly):\n"
    "1. If the answer IS in <FACTS> — give it directly, concisely, no padding.\n"
    "2. If a specific number (price, metric, date) is NOT in <FACTS> — write 'not in memory' for that field. "
    "Do NOT estimate, interpolate, or fabricate ANY number.\n"
    "3. If FACTS have partial information — answer what you know, flag what's missing.\n"
    "4. NEVER write fake engagement metrics, fake salaries, or fake client names.\n"
    "5. If FACTS are completely empty on the topic — say 'No data in memory for this — "
    "I can dispatch a research agent if you want.'\n"
    "6. Keep replies concise unless the user asks for detail.\n"
)


def build_grounded_system(role_prompt: str, collections: List[str], query: str,
                          n_per_collection: int = 3, extra_facts: str = "") -> str:
    """Compose a system prompt with hard anti-hallucination rules + recalled facts."""
    facts: List[str] = []
    for col in collections:
        for doc in recall_facts(col, query, n=n_per_collection):
            facts.append(f"[{col}] {doc}".strip())
    facts_block = "\n---\n".join(facts) if facts else "(no relevant memories)"

    parts = [
        role_prompt.strip(),
        "",
        ANTI_HALLU,
        "",
        "<FACTS>",
        facts_block[:6000],  # cap to keep prompt small for local model
        "</FACTS>",
    ]
    if extra_facts:
        parts.extend(["", "<ADDITIONAL_CONTEXT>", extra_facts.strip(), "</ADDITIONAL_CONTEXT>"])
    return "\n".join(parts)


# Topic → collections mapping (matches telegram_gateway routing)
TOPIC_COLLECTIONS = {
    "boardroom":  ["turicks_mem", "naggar_mem", "social_mem", "career_mem"],
    "think_tank": ["turicks_mem", "naggar_mem", "social_mem"],
    "turicks":    ["turicks_mem", "social_mem"],
    "naggar":     ["naggar_mem", "social_mem"],
    "social":     ["social_mem", "turicks_mem"],
    "revenue":    ["turicks_mem", "social_mem"],
}


def ground_for_topic(topic_key: str, query: str) -> List[str]:
    """Get the right facts for a Telegram topic."""
    cols = TOPIC_COLLECTIONS.get(topic_key, ["social_mem"])
    return [
        f"[{c}] {doc}"
        for c in cols
        for doc in recall_facts(c, query, n=2)
    ]
