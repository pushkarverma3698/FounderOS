"""
FounderOS — Documentation Sync Agent (v1.0)
===========================================
Autonomous documentation maintenance triggered by architectural shifts.
Ensures AGENTS.md and docs/ stay in lock-step with codebase evolution.

USAGE:
    sync = DocumentationSync()
    sync.evaluate_and_sync(history, metadata)
"""

import os
import logging
import json
from pathlib import Path
from core.config import call_nano, CEO_CASCADE

log = logging.getLogger("DocSync")

DOCS_DIR = Path.home() / "Documents" / "Coding stuff" / "FounderOS" / "docs"
COMPONENTS_DIR = DOCS_DIR / "components"
AGENTS_MD = Path.home() / "Documents" / "Coding stuff" / "FounderOS" / "AGENTS.md"

# Keywords that trigger a "Major Change" evaluation
MAJOR_CHANGE_KEYWORDS = [
    "cascade", "tier", "registry", "security", "sandbox", 
    "protocol", "architecture", "v7", "v8", "refactor"
]

class DocumentationSync:
    def __init__(self):
        COMPONENTS_DIR.mkdir(parents=True, exist_ok=True)

    def evaluate_and_sync(self, messages: list[dict], task_description: str) -> bool:
        """
        Determines if the recent task warrants a doc update, and performs it.
        """
        if not self._is_high_impact(messages, task_description):
            return False

        log.info("[DocSync] High-impact change detected. Starting autonomous doc update...")
        
        # 1. Summarize the changes
        change_summary = self._summarize_changes(messages)
        
        # 2. Update AGENTS.md (Central Registry & Principles)
        self._update_central_docs(change_summary)
        
        # 3. Update specific component docs if relevant
        self._update_component_docs(messages, change_summary)
        
        return True

    def _is_high_impact(self, messages: list[dict], task_description: str) -> bool:
        """Heuristic check for major architectural shifts."""
        combined_text = (task_description + " " + " ".join([m.get("content", "") for m in messages[-3:]])).lower()
        
        # Check against keywords
        matched = [kw for kw in MAJOR_CHANGE_KEYWORDS if kw in combined_text]
        if matched:
            log.debug(f"[DocSync] Impact match found: {matched}")
            return True
        return False

    def _summarize_changes(self, messages: list[dict]) -> str:
        """Uses NANO tier to distill what actually changed in the architecture."""
        prompt = f"""Summarize the architectural or registry changes in this transaction.
Focus on NEW components, NEW security layers, or NEW agent tiers.
CONTEXT:
{messages[-5:]}

Respond with a concise 3-5 bullet point summary of the SHIFT, not the specific code edits."""
        return call_nano(prompt)

    def _update_central_docs(self, change_summary: str):
        """Atomically updates AGENTS.md and V7_UPGRADE_NOTES if needed."""
        # This is a complex LLM edit task. For now, we'll append a log entry to V7_UPGRADE_NOTES.
        upgrade_notes = Path.home() / "Documents" / "Coding stuff" / "FounderOS" / "V7_UPGRADE_NOTES.md"
        if upgrade_notes.exists():
            with open(upgrade_notes, "a") as f:
                f.write(f"\n### Autonomous Sync Update: {change_summary[:100]}...\n{change_summary}\n")
            log.info("[DocSync] Appended to V7_UPGRADE_NOTES.md")

    def _update_component_docs(self, messages: list[dict], summary: str):
        """Identifies which component docs need updating."""
        # Future: Use LLM to identify specific filenames and generate Mermaid updates.
        log.info("[DocSync] Component doc update logic placeholder for V7.1+")

if __name__ == "__main__":
    # Test stub
    sync = DocumentationSync()
    print("DocSync Initialized.")
