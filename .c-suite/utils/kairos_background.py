"""
FounderOS — KAIROS & Master Background Agents
=============================================================
V7 UPGRADE: Sleep-Time Compute (The "Letta" Pattern)

When Telegram is quiet (idle time), instead of doing nothing, FounderOS
now uses sleep windows to perform deep memory distillation, relationship
structuring in ChromaDB, and knowledge graph compression — entirely free
on local MLX hardware.

1. AutoDream (Enhanced Sleep-Time Compute):
    - Compresses redundant ChromaDB fragments (original).
    - NEW: Extracts entity relationships and structures them for graph-style retrieval.
    - NEW: Runs procedural memory cache: if a successful fix pattern is found,
           stores the exact step-schema so future tasks bypass recomputation.

2. MagicDocs: Watches .founder/skills/ for "# MAGIC DOC:" and auto-updates.

3. KAIROS (Proactive Assistant): Pushes Telegram nudges from observed signals.

4. NEW — SleepTimeCompute: Distils ChromaDB into relationship maps during idle.
"""

from apscheduler.schedulers.asyncio import AsyncIOScheduler
import asyncio
import logging
import sys, os, glob, json, time
sys.path.insert(0, str(os.path.dirname(__file__)))

from core.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TOPIC_BOARDROOM, call_local, call_nano
from memory.memory import turicks_mem, naggar_mem, social_mem, store, recall
from aiogram import Bot

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("KairosBackground")
bot = Bot(token=TELEGRAM_BOT_TOKEN)
scheduler = AsyncIOScheduler()

# ─── 1. AutoDream: Enhanced Memory Consolidation ──────────────────────────────
async def auto_dream_consolidation():
    """
    AutoDream (Sleep-Time Compute, Letta Pattern):
    During idle cycles, compress ChromaDB fragments AND extract relationships.
    Runs on local Qwen — zero cost.
    """
    log.info("🧹 [AutoDream] Running Sleep-Time Compute cycle...")
    for mem_name, mem_col in [("turicks", turicks_mem), ("naggar", naggar_mem)]:
        try:
            docs = mem_col.get(limit=30)
            fragments = docs.get("documents", []) if docs else []
            if len(fragments) < 6:
                continue  # Not enough noise to consolidate

            raw_text = "\n---\n".join(fragments[:20])

            # Step 1: Consolidate redundant memories into dense paragraphs
            consolidation_prompt = (
                f"Condense these {len(fragments[:20])} memory fragments into 2-3 dense "
                f"master paragraphs of ground truth. Remove repetition. Keep ALL unique facts:\n\n{raw_text[:3000]}"
            )
            condensed = call_local(consolidation_prompt)
            if condensed:
                store(mem_col, f"autodream-consolidated-{int(time.time())}", condensed,
                      metadata={"type": "consolidated", "source_count": str(len(fragments[:20]))})
                log.info(f"🧹 [AutoDream/{mem_name}] Compressed {len(fragments[:20])} fragments → 1 dense memory.")

            # Step 2 (NEW): Extract entity relationships for graph-style retrieval
            relationship_prompt = (
                f"From these memories, extract a JSON list of entity relationships. "
                f"Format: [{{\"from\": \"EntityA\", \"relation\": \"...\", \"to\": \"EntityB\"}}]\n\n{raw_text[:2000]}"
            )
            rel_raw = call_local(relationship_prompt)
            try:
                relationships = json.loads(rel_raw.replace("```json", "").replace("```", "").strip())
                rel_doc = json.dumps(relationships, ensure_ascii=False)
                store(mem_col, f"autodream-relationships-{int(time.time())}", rel_doc,
                      metadata={"type": "entity_relationships"})
                log.info(f"🧹 [AutoDream/{mem_name}] Extracted {len(relationships)} entity relationships.")
            except Exception:
                pass  # Relationship extraction is opportunistic

            # Step 3 (NEW): Procedural Memory Cache — detect & store successful fix patterns
            procedural_prompt = (
                f"From these memories, identify any successful problem→solution pairs "
                f"(e.g. 'Fixed X by doing Y'). Return as JSON list: "
                f"[{{\"problem\": \"...\", \"solution\": \"...\", \"steps\": [...]}}]\n\n{raw_text[:2000]}"
            )
            proc_raw = call_local(procedural_prompt)
            try:
                procedures = json.loads(proc_raw.replace("```json", "").replace("```", "").strip())
                if procedures:
                    proc_doc = json.dumps(procedures, ensure_ascii=False)
                    store(mem_col, f"autodream-procedural-{int(time.time())}", proc_doc,
                          metadata={"type": "procedural_cache"})
                    log.info(f"🧹 [AutoDream/{mem_name}] Cached {len(procedures)} procedural fix pattern(s).")
            except Exception:
                pass

        except Exception as e:
            log.error(f"[AutoDream/{mem_name}] Failed: {e}")


# ─── 2. MagicDocs Watcher ─────────────────────────────────────────────────────
async def magic_docs_watcher():
    """Scans for # MAGIC DOC headers and updates the files with recent context."""
    log.info("🧙‍♂️ [MagicDocs] Scanning .founder/skills/ for Magic headers...")
    skills_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".founder", "skills"))
    if not os.path.exists(skills_dir):
        return

    for filepath in glob.glob(os.path.join(skills_dir, "*.md")):
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()

        if "# MAGIC DOC:" in content:
            log.info(f"🧙‍♂️ [MagicDocs] Updating bound document: {os.path.basename(filepath)}")
            prompt = "Update this Markdown document by appending a 'Recent Upgrades' section summarizing what we learned this week. Keep it very short."
            try:
                updated_content = call_local(prompt + "\n\n" + content[:1000])
                if updated_content:
                    with open(filepath, "w", encoding="utf-8") as f:
                        f.write(content + "\n\n## Auto-Learned Upgrades\n" + updated_content)
            except Exception as e:
                log.error(f"[MagicDocs] Write failed: {e}")


# ─── 3. KAIROS Proactive Loop ─────────────────────────────────────────────────
async def kairos_proactive_loop():
    """KAIROS Mode: Proactively analyses external signals and pings if needed."""
    log.info("👁️ [KAIROS Mode] Proactive loop cycle...")
    signal_prompt = (
        "Act as KAIROS proactive agent. Generate 1 completely unprompted, highly valuable "
        "insight about AI tech trends today. Keep it ultra-short (1 sentence)."
    )
    try:
        insight = call_local(signal_prompt)
        if insight and len(insight) > 10:
            log.info(f"👁️ [KAIROS] Triggering push notification: {insight}")
            await bot.send_message(
                chat_id=TELEGRAM_CHAT_ID,
                message_thread_id=TOPIC_BOARDROOM if TOPIC_BOARDROOM else None,
                text=f"👁️ *KAIROS Proactive Nudge*\n\n_{insight}_",
                parse_mode="Markdown"
            )
    except Exception as e:
        log.error(f"KAIROS loop failed: {e}")


# ─── 4. NEW: Sleep-Time Knowledge Graph Distillation ─────────────────────────
async def sleep_time_graph_distillation():
    """
    NEW (V7 Sleep-Time Compute): During idle hours, run a deeper
    cross-collection knowledge graph distillation on social_mem.
    Finds cross-company insights that neither turicks nor naggar would
    surface alone — a more powerful version of HivemindSync.
    Runs on local Qwen — zero cost.
    """
    log.info("🧬 [SleepTime] Cross-collection graph distillation starting...")
    try:
        t_docs = turicks_mem.get(limit=10).get("documents", [])
        n_docs = naggar_mem.get(limit=10).get("documents", [])
        combined = "\n".join(t_docs[:5] + n_docs[:5])
        if not combined.strip():
            return

        synergy_prompt = (
            "You are a cross-company AI strategist. Given knowledge from two separate business units "
            "(an AI agency and a farm retreat), identify 2-3 high-value strategic synergies or "
            "shared patterns that could benefit both. Output as a JSON list: "
            "[{\"synergy\": \"...\", \"action\": \"...\"}]\n\n" + combined[:3000]
        )
        raw = call_nano(synergy_prompt)
        synergies = json.loads(raw.replace("```json", "").replace("```", "").strip())
        doc = json.dumps(synergies, ensure_ascii=False)
        store(social_mem, f"sleep-synergy-{int(time.time())}", doc,
              metadata={"type": "cross_company_synergy"})
        log.info(f"🧬 [SleepTime] Found {len(synergies)} cross-company synergies.")
    except Exception as e:
        log.error(f"[SleepTime] Graph distillation failed: {e}")

# ─── 5. System Garbage Collection & DB Vacuum ──────────────────────────────────
async def system_vacuum_loop():
    """Vacuums LangGraph SQLite state bloat and TPM tracker memory drops."""
    log.info("🧹 [SystemVacuum] Running system garbage collection...")
    from core.config import prune_tpm_memory_leak, SQLITE_PATH
    import sqlite3
    
    # Prune TPM Arrays Memory Leak
    try:
        prune_tpm_memory_leak()
    except Exception as e:
        log.error(f"[SystemVacuum] TPM pruning failed: {e}")
        
    # Vacuum LangGraph State DB
    try:
        if os.path.exists(SQLITE_PATH):
            conn = sqlite3.connect(SQLITE_PATH)
            conn.execute("VACUUM;")
            conn.close()
            log.info("🧹 [SystemVacuum] SqliteSaver DB Vacuumed successfully.")
    except Exception as e:
        log.error(f"[SystemVacuum] SQLite vacuum failed: {e}")


# ─── Daemon Startup ───────────────────────────────────────────────────────────
def start_kairos_daemon():
    scheduler.add_job(auto_dream_consolidation,      'interval', minutes=60,  id="autodream")
    scheduler.add_job(magic_docs_watcher,            'interval', minutes=75,  id="magicdocs")
    scheduler.add_job(kairos_proactive_loop,         'interval', minutes=120, id="kairos")
    scheduler.add_job(sleep_time_graph_distillation, 'interval', minutes=180, id="sleeptime_graph")
    scheduler.add_job(system_vacuum_loop,            'interval', minutes=240, id="system_vacuum")
    scheduler.start()
    log.info("⚡ Started KAIROS, AutoDream (Sleep-Time), MagicDocs, Cross-Graph daemon, and DB Vacuum.")

if __name__ == "__main__":
    start_kairos_daemon()
    try:
        asyncio.get_event_loop().run_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
