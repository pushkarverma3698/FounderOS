"""
FounderOS — ChromaDB Long-Term Memory
======================================
Two isolated collections:
  - turicks_mem  →  Agency work, code, bids, client context
  - naggar_mem   →  Farm logs, bookings, pricing, vibe content
"""

import time
import chromadb
from core.config import CHROMA_DIR, COLLECTION_TURICKS, COLLECTION_NAGGAR

# ─── Initialise persistent client ─────────────────────────────────────────────
client = chromadb.PersistentClient(path=str(CHROMA_DIR))

def get_collection(name: str) -> chromadb.Collection:
    """Dynamically get or create a ChromaDB collection."""
    return client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine", "description": f"{name} Memory"}
    )

turicks_mem = get_collection(COLLECTION_TURICKS)
naggar_mem  = get_collection(COLLECTION_NAGGAR)
social_mem  = get_collection("social_mem")
career_mem  = get_collection("career_mem")
chat_mem    = get_collection("chat_mem")

def store(collection: chromadb.Collection, doc_id: str, text: str, metadata: dict = None):
    """Upsert a document into a memory collection."""
    collection.upsert(
        ids=[doc_id],
        documents=[text],
        metadatas=[metadata or {}]
    )

def recall(collection: chromadb.Collection, query: str, n_results: int = 3, traverse_graph: bool = True) -> list[str]:
    """Retrieve top-n memories, optionally traversing the V7 Wiki Graph."""
    results = collection.query(query_texts=[query], n_results=n_results)
    base_docs = results["documents"][0] if results.get("documents") and results["documents"] else []
    
    if not traverse_graph or not results.get("metadatas") or not results["metadatas"][0]:
        return base_docs

    # V7 Wiki Pattern: Fetch 1st-degree related facts by ID
    seen_ids: set[str] = set()
    for meta in results["metadatas"][0]:
        rel_ids = meta.get("related_ids", [])
        if isinstance(rel_ids, str):
            import json
            try:
                rel_ids = json.loads(rel_ids)
            except Exception:
                rel_ids = []
        for rid in rel_ids:
            if rid:
                seen_ids.add(rid)

    if not seen_ids:
        return base_docs

    try:
        related = collection.get(ids=list(seen_ids))
        related_docs = related.get("documents", []) or []
    except Exception:
        related_docs = []

    return base_docs + [d for d in related_docs if d and d not in base_docs]

def multi_recall(collections: list[str], query: str, n_results: int = 3) -> str:
    """Retrieve relevant context from multiple collections and merge into a string."""
    context_chunks = []
    for col_name in collections:
        col = get_collection(col_name)
        memories = recall(col, query, n_results)
        if memories:
            context_chunks.append(f"--- Memory from {col_name} ---\n" + "\n".join(memories))
    return "\n\n".join(context_chunks)

def store_experience(agent_name: str, task: str, result: str):
    """Convenience helper to store an agent's specific experience."""
    from core.registry import get_agent
    agent = get_agent(agent_name)
    if not agent or not agent.allowed_collections:
        return
    
    # Store in the primary (first) allowed collection
    primary_col = get_collection(agent.allowed_collections[0])
    doc_id = f"{agent_name}_{time.time()}"
    text = f"TASK: {task}\nRESULT: {result}"
    store(primary_col, doc_id, text, {"agent": agent_name, "type": "experience", "timestamp": time.time()})

def cross_company_search(query: str, n_results: int = 3) -> dict:
    """Hourly Ideator: search ALL companies for synergy opportunities."""
    from core.registry import get_all_companies
    results = {}
    for comp in get_all_companies():
        col = get_collection(comp.memory_collection)
        results[comp.name] = recall(col, query, n_results)
    return results
