"""
FounderOS — Memory Extractor (v1.0)
=====================================
Background post-turn memory extraction and persistence.

Borrowed from: Claude Code `src/services/extractMemories/extractMemories.ts`
Pattern: After every complete agent turn, fire a background extraction that
         reads the conversation and writes durable knowledge to disk.

WHY: FounderOS currently only stores memories when manually called
     (auto_researcher.py). This makes memory extraction AUTOMATIC — after
     every orchestrator turn, valuable insights are captured silently.

Claude Code mechanism:
  - Runs as a "forked agent" in background (we use threading.Thread)
  - Scans recent messages since the last extraction
  - Writes structured JSON memory files
  - Never blocks the main agent thread

Memory file structure:
  ~/Documents/Coding stuff/FounderOS/docs/memories/
    turicks_memories.json   — Turicks agency learnings
    naggar_memories.json    — Naggar retreat learnings
    system_memories.json    — Architecture, model cascade, tool decisions

Usage:
    from memory.memory_extractor import MemoryExtractor

    extractor = MemoryExtractor()

    # Call fire-and-forget at end of each turn:
    extractor.extract_async(messages, agent_name="orchestrator", company="turicks")

    # Or wait for result:
    count = extractor.extract(messages, "orchestrator", "turicks")
"""

import json
import logging
import threading
import time
import re
from pathlib import Path
from dataclasses import dataclass, field, asdict

log = logging.getLogger("MemoryExtractor")

# Memory directory — follows Claude Code's ~/.claude/memory/ pattern
MEMORY_DIR = Path.home() / "Documents" / "Coding stuff" / "FounderOS" / "docs" / "memories"
MEMORY_DIR.mkdir(parents=True, exist_ok=True)

# Minimum new messages before extraction is worthwhile
MIN_NEW_MESSAGES = 4

# Minimum turns between extractions (avoid running every single message)
EXTRACT_EVERY_N_TURNS = 3


@dataclass
class Memory:
    """A single extracted memory item."""
    id: str            # Unique hash of the fact
    topic: str
    fact: str
    company: str       # "turicks" | "naggar" | "system" | "cross"
    source_agent: str
    confidence: str    # "high" | "medium" | "low"
    timestamp: int = field(default_factory=lambda: int(time.time()))
    related_ids: List[str] = field(default_factory=list) # V7 Graph Links
    turn_count: int = 0


# ─── Extraction Prompt ────────────────────────────────────────────────────────

EXTRACT_PROMPT = """Review the recent conversation and extract durable facts worth remembering in future sessions.

Focus on:
- Decisions made about architecture, models, or tools
- Problems solved and how (with specific solutions)
- User (Chairman) preferences and working style
- Company-specific patterns that proved effective
- Errors that were fixed (so we don't repeat them)
- Cost optimizations or performance wins

Company context:
  Turicks = AI/software agency. Upwork bidding, MERN stack, agentic frameworks.
  Naggar = Himalayan raspberry farm + homestay. Local model for all private data.
  System = FounderOS architecture, LangGraph, model cascade decisions.

DO NOT extract:
- Content of specific proposals or guest messages (private/PII)
- Time-sensitive data (prices, weather) — these expire
- Trivial operational logs

Respond with ONLY valid JSON in this exact format:
{
  "memories": [
    {
      "topic": "str", 
      "fact": "str", 
      "company": "turicks|naggar|system|cross", 
      "confidence": "high|medium|low",
      "related_topics": ["str", "str"] 
    }
  ]
}

If nothing worth saving, respond: {"memories": []}

Recent conversation to analyse:
{conversation}"""


# ─── Core Extractor ───────────────────────────────────────────────────────────

class MemoryExtractor:
    """
    Background memory extractor modelled on Claude Code's extractMemories.ts.
    """

    def __init__(self):
        self._turn_counter = 0
        self._last_extract_message_count = 0
        self._in_progress = False
        self._lock = threading.Lock()
        self.wiki_manager = WikiManager(MEMORY_DIR)

    def extract_async(
        self,
        messages: list[dict],
        agent_name: str,
        company: str = "system",
    ) -> None:
        """
        Fire-and-forget memory extraction (runs in background thread).

        Claude Code pattern: runs after every complete query loop, non-blocking.
        The main agent continues immediately — extraction happens silently.
        """
        self._turn_counter += 1

        # Only extract every N turns to avoid waste
        if self._turn_counter % EXTRACT_EVERY_N_TURNS != 0:
            return

        # Skip if extraction already running (Claude Code: stash pending, run trailing)
        with self._lock:
            if self._in_progress:
                log.debug("[MemoryExtractor] Already running — skipping this turn")
                return
            self._in_progress = True

        thread = threading.Thread(
            target=self._extract_and_release,
            args=(messages.copy(), agent_name, company),
            daemon=True,
            name=f"memory_extractor_{agent_name}",
        )
        thread.start()

    def extract(
        self,
        messages: list[dict],
        agent_name: str,
        company: str = "system",
    ) -> int:
        """
        Synchronous extraction. Returns number of memories saved.
        Use this when you need to wait for completion.
        """
        return self._run_extraction(messages, agent_name, company)

    def _extract_and_release(self, messages: list, agent_name: str, company: str) -> None:
        """Thread target: extract then release the in-progress lock."""
        try:
            self._run_extraction(messages, agent_name, company)
        finally:
            with self._lock:
                self._in_progress = False

    def _run_extraction(self, messages: list, agent_name: str, company: str) -> int:
        """Run the actual extraction and save to disk."""
        from core.config import call_nano

        # Only process new messages since last extraction
        new_messages = messages[self._last_extract_message_count:]
        if len(new_messages) < MIN_NEW_MESSAGES:
            log.debug(f"[MemoryExtractor] Only {len(new_messages)} new messages — skipping")
            return 0

        # Format conversation for the extraction model
        conversation_text = self._format_messages(new_messages)
        prompt = EXTRACT_PROMPT.format(conversation=conversation_text)

        start = time.time()
        try:
            result = call_nano(prompt)

            # Parse JSON response
            memories_data = self._safe_parse_json(result)
            memories = memories_data.get("memories", [])

            if not memories:
                log.debug("[MemoryExtractor] No memories extracted this turn")
                self._last_extract_message_count = len(messages)
                return 0

            # Build Memory objects
            import hashlib
            memory_objects = []
            for m in memories:
                fact_text = m.get("fact", "")
                if not fact_text: continue
                
                # V7: Generate stable ID from hash of fact
                fact_id = hashlib.md5(fact_text.encode()).hexdigest()[:12]
                
                memory_objects.append(Memory(
                    id=fact_id,
                    topic=m.get("topic", ""),
                    fact=fact_text,
                    company=m.get("company", company),
                    source_agent=agent_name,
                    confidence=m.get("confidence", "medium"),
                    related_ids=[] # Populated during save if topics match
                ))

            # Save to appropriate memory file
            self._save_memories(memory_objects)
            
            # V8: Update Knowledge Wiki
            for m in memory_objects:
                try:
                    self.wiki_manager.update_wiki(m)
                except Exception as wiki_err:
                    log.error(f"[WikiManager] Failed for {m.topic}: {wiki_err}")
                    
            self._last_extract_message_count = len(messages)

            duration = round(time.time() - start, 2)
            log.info(
                f"[MemoryExtractor] Saved {len(memory_objects)} memories "
                f"in {duration}s for '{agent_name}'"
            )
            return len(memory_objects)

        except Exception as e:
            log.warning(f"[MemoryExtractor] Extraction failed (non-critical): {e}")
            return 0

    def _save_memories(self, memories: list[Memory]) -> None:
        """Append new memories to the appropriate JSON files."""
        # Group by company
        by_company: dict[str, list[Memory]] = {}
        for m in memories:
            by_company.setdefault(m.company, []).append(m)

        for company, mems in by_company.items():
            file_path = MEMORY_DIR / f"{company}_memories.json"
            existing = []
            if file_path.exists():
                try:
                    existing = json.loads(file_path.read_text())
                except json.JSONDecodeError:
                    existing = []

            new_entries = [asdict(m) for m in mems]
            # Deduplicate by fact text (avoid re-learning same thing)
            existing_facts = {e.get("fact") for e in existing if isinstance(e, dict) and e.get("fact")}
            
            # V7 Graph: Link new entries to existing ones with same topic
            for entry in new_entries:
                topic = entry.get("topic", "")
                related = [e.get("id") for e in existing if isinstance(e, dict) and e.get("topic") == topic]
                entry["related_ids"] = list(set(entry.get("related_ids", []) + related))

            truly_new = [e for e in new_entries if e.get("fact") not in existing_facts]

            if truly_new:
                file_path.write_text(
                    json.dumps(existing + truly_new, indent=2),
                    encoding="utf-8",
                )
                log.debug(f"[MemoryExtractor] Wrote {len(truly_new)} memories to {file_path.name}")

    def _format_messages(self, messages: list[dict]) -> str:
        lines = []
        for msg in messages[-20:]:  # Last 20 only (enough context, not too expensive)
            role = msg.get("role", "?").upper()
            content = msg.get("content", "")
            if isinstance(content, list):
                content = str(content)[:500]
            lines.append(f"{role}: {str(content)[:600]}")
        return "\n".join(lines)

    def _safe_parse_json(self, text: str) -> dict:
        """Try to extract JSON from possibly messy LLM output."""
        # Try direct parse
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        # Try extracting JSON block
        match = re.search(r'\{.*"memories".*\}', text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return {"memories": []}

# ─── V8 Wiki Management ────────────────────────────────────────────────────────

class WikiManager:
    """
    V8 Transition Tool: Evolving JSON fragments into an interlinked Wiki.
    Writes Markdown files to ~/Documents/Coding stuff/FounderOS/docs/memories/ using a [[Topic]] pattern.
    """
    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.wiki_dir = base_dir / "wiki"
        self.wiki_dir.mkdir(parents=True, exist_ok=True)

    def update_wiki(self, memory: Memory):
        """Write or update a Markdown file for the memory's topic."""
        file_path = self.wiki_dir / f"{memory.topic.replace(' ', '_').lower()}.md"
        
        # Link to related topics using Wikilink pattern
        links = "\n".join([f"- [[{rid}]]" for rid in memory.related_ids])
        
        content = f"""# {memory.topic}

## Fact (extracted {memory.timestamp})
{memory.fact}

## Metadata
- **Confidence**: {memory.confidence}
- **Source**: {memory.source_agent}
- **Company**: {memory.company}

## Related Entries
{links}
"""
        file_path.write_text(content, encoding="utf-8")
        log.info(f"[WikiManager] Updated wiki entry: {file_path.name}")

    def get_memories(self, company: str = "system", limit: int = 20) -> list[dict]:
        """Load recent memories for a company. Use in agent system prompts."""
        file_path = MEMORY_DIR / f"{company}_memories.json"
        if not file_path.exists():
            return []
        try:
            all_memories = json.loads(file_path.read_text())
            # Return most recent, high-confidence first
            sorted_mems = sorted(
                all_memories,
                key=lambda m: (m.get("confidence", "low") == "high", m.get("timestamp", 0)),
                reverse=True,
            )
            return sorted_mems[:limit]
        except Exception:
            return []


# ─── Module-level default instance ────────────────────────────────────────────

default_extractor = MemoryExtractor()


def extract_memories_async(messages: list[dict], agent_name: str, company: str = "system") -> None:
    """Fire-and-forget memory extraction using the default extractor."""
    default_extractor.extract_async(messages, agent_name, company)


def get_agent_memories(company: str, limit: int = 10) -> str:
    """
    Get formatted memories for injection into an agent's system prompt.

    Example:
        memories = get_agent_memories("turicks")
        system_prompt = base_prompt + "\\n\\n## Remembered from past sessions:\\n" + memories
    """
    memories = default_extractor.get_memories(company, limit)
    if not memories:
        return ""
    lines = [f"- [{m['confidence']}] {m['topic']}: {m['fact']}" for m in memories]
    return "\n".join(lines)
