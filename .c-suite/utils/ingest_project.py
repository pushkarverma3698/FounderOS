#!/usr/bin/env python3
"""
FounderOS — Project Context Ingestion Engine
============================================
Recursively crawls the codebase and populates ChromaDB memory collections.
Ensures agents have 100% awareness of existing tools, logic, and docs.
"""

import os
import time
import hashlib
from pathlib import Path
from memory.memory import store, get_collection
from core.config import COLLECTION_TURICKS, COLLECTION_NAGGAR

# Configuration
BASE_DIR = Path.home() / "Documents" / "Coding stuff" / "FounderOS"
EXCLUDE_DIRS = {".git", "__pycache__", "chroma_data", "venv", "node_modules", ".gemini"}
INCLUDE_EXTS = {".py", ".md", ".env", ".json", ".js", ".css", ".html"}
CHUNK_SIZE = 4000  # Chars per memory chunk

def chunk_text(text: str, size: int) -> list[str]:
    """Split text into chunks by character count, trying to break at newlines."""
    chunks = []
    while len(text) > size:
        # Try to find a newline within the last 500 chars of the chunk
        split_at = text.rfind("\n", size - 500, size)
        if split_at == -1:
            split_at = size
        chunks.append(text[:split_at].strip())
        text = text[split_at:].strip()
    if text:
        chunks.append(text)
    return chunks

def get_target_collection(path: Path):
    """Map directory path to ChromaDB collection name."""
    p_str = str(path)
    if "turicks_agency" in p_str:
        return get_collection(COLLECTION_TURICKS)
    elif "naggar_retreat" in p_str:
        return get_collection(COLLECTION_NAGGAR)
    elif "Career Funnel" in p_str or "job_search" in p_str:
        return get_collection("social_mem") # JobOS uses social_mem/career_mem
    else:
        # Default to system-wide social memory (Boardroom access)
        return get_collection("social_mem")

def ingest():
    print(f"🚀 Starting Project Ingestion for: {BASE_DIR}")
    files_processed = 0
    chunks_created = 0

    for root, dirs, files in os.walk(BASE_DIR):
        # Prune excluded directories
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        
        rel_root = Path(root).relative_to(BASE_DIR)
        
        for file_name in files:
            file_path = Path(root) / file_name
            if file_path.suffix not in INCLUDE_EXTS:
                continue

            try:
                content = file_path.read_text(encoding="utf-8", errors="ignore")
                if not content.strip():
                    continue

                collection = get_target_collection(file_path)
                chunks = chunk_text(content, CHUNK_SIZE)
                
                for i, chunk in enumerate(chunks):
                    # Unique stable ID: filename + chunk index
                    doc_id = hashlib.md5(f"{rel_root}/{file_name}_{i}".encode()).hexdigest()[:16]
                    
                    metadata = {
                        "path": str(rel_root / file_name),
                        "chunk": i,
                        "total_chunks": len(chunks),
                        "type": "codebase",
                        "timestamp": time.time()
                    }
                    
                    store(collection, doc_id, chunk, metadata)
                    chunks_created += 1

                files_processed += 1
                if files_processed % 10 == 0:
                    print(f"   Indexed {files_processed} files...")

            except Exception as e:
                print(f"   ⚠️ Failed to process {file_name}: {e}")

    print(f"\n✅ Ingestion Complete!")
    print(f"   Total Files: {files_processed}")
    print(f"   Total Chunks: {chunks_created}")
    print(f"   Collection targets: turicks_mem, naggar_mem, social_mem")

if __name__ == "__main__":
    start_time = time.time()
    ingest()
    duration = round(time.time() - start_time, 2)
    print(f"   Duration: {duration}s")
