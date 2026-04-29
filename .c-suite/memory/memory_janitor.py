"""
FounderOS — Memory Janitor Agent
=================================
Role: Maintain high context density and minimize local storage usage.
Logic: 
  - Scan collections for documents older than X days.
  - Summarize related interaction clusters.
  - Delete raw granular documents after summarization.
"""

import time
import logging
from core.config import call_md
from memory.memory import client, get_collection, store

log = logging.getLogger("MemoryJanitor")

def clean_and_summarize_collection(collection_name: str, days_threshold: int = 7):
    """
    Finds documents older than the threshold and condenses them.
    """
    col = get_collection(collection_name)
    now = time.time()
    threshold_ts = now - (days_threshold * 86400)
    
    # In Chroma, we'd typically use metadata filtering if we stored timestamps
    # For this implementation, we'll assume we filter by a 'timestamp' metadata field
    try:
        results = col.get(
            where={"timestamp": {"$lt": threshold_ts}},
            limit=50
        )
    except Exception as e:
        log.warning(f"Could not filter {collection_name} by timestamp: {e}")
        return

    if not results["documents"]:
        log.info(f"✨ Collection {collection_name} is already high-density. No cleaning needed.")
        return

    log.info(f"🧹 Janitor: Condensing {len(results['documents'])} old documents in {collection_name}...")
    
    context_to_condense = "\n---\n".join(results["documents"])
    
    summarize_prompt = f"""You are the Memory Janitor for FounderOS.
    
    The following are old, granular memories from the '{collection_name}' collection.
    Compress them into a single, high-density 'Strategic Knowledge' document.
    Maintain key facts, results, and insights, but remove conversational fluff and redundant metadata.
    
    OLD MEMORIES:
    {context_to_condense}
    """
    
    summary = call_md(summarize_prompt, system="You are an expert at information compression and knowledge management.")
    
    # 1. Store the new condensed document
    new_id = f"summary_{collection_name}_{int(now)}"
    store(col, new_id, summary, {"timestamp": now, "type": "summary"})
    
    # 2. Delete the old granular documents
    col.delete(ids=results["ids"])
    
    log.info(f"✅ Janitor: Successfully condensed {collection_name}. Saved as {new_id}")

def run_janitor_sweep():
    """Runs the cleaning sweep across all primary collections."""
    collections = ["turicks_mem", "naggar_mem", "social_mem", "career_mem", "chat_mem"]
    for col in collections:
        clean_and_summarize_collection(col)

if __name__ == "__main__":
    run_janitor_sweep()
