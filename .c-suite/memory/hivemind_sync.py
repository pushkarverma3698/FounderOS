"""
FounderOS — Hivemind Sync (TeamMemorySync)
=============================================================
Mirrors the TeamMemorySync capabilities found in Claude Code.
Operates periodically to fetch breakthroughs from isolated company knowledge 
bases (turicks_mem, naggar_mem) and explicitly copies the 'synthesized' 
universal business logic into the centralized `social_mem` database.
"""

import sys, os, time
sys.path.insert(0, str(os.path.dirname(__file__)))

from memory.memory import turicks_mem, naggar_mem, social_mem
import logging

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("HivemindSync")

def sync_team_memory():
    log.info("🧠 [HivemindSync] Starting cross-company knowledge sync...")
    
    # 1. Fetch from Turicks
    try:
        t_docs = turicks_mem.get(limit=10)
        if t_docs and t_docs.get("documents"):
            social_mem.add(
                ids=[f"turicks_hive_{int(time.time())}_{i}" for i in range(len(t_docs["documents"]))],
                documents=t_docs["documents"],
                metadatas=[{"source": "hivemind_sync_turicks"} for _ in t_docs["documents"]]
            )
            log.info(f"  -> Synced {len(t_docs['documents'])} logic blocks from Turicks to Hivemind.")
    except Exception as e:
        log.error(f"Turicks sync failed: {e}")

    # 2. Fetch from Naggar
    try:
        n_docs = naggar_mem.get(limit=10)
        if n_docs and n_docs.get("documents"):
            social_mem.add(
                ids=[f"naggar_hive_{int(time.time())}_{i}" for i in range(len(n_docs["documents"]))],
                documents=n_docs["documents"],
                metadatas=[{"source": "hivemind_sync_naggar"} for _ in n_docs["documents"]]
            )
            log.info(f"  -> Synced {len(n_docs['documents'])} logic blocks from Naggar to Hivemind.")
    except Exception as e:
        log.error(f"Naggar sync failed: {e}")

    log.info("🧠 [HivemindSync] Sync complete!")

if __name__ == "__main__":
    sync_team_memory()
