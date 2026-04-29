"""
FounderOS — Context Manager (v1.0)
====================================
Automatic context compaction at 80% token threshold.

Borrowed from: Claude Code `src/services/compact/autoCompact.ts`
              + `src/services/compact/prompt.ts` (verbatim 9-section structure)

WHY: Long autonomous tasks currently crash when the LLM context fills up
     (context_length_exceeded error). This module monitors token usage and
     automatically summarises conversation history before the limit is hit.

Key numbers from Claude Code source:
  - Compact threshold: context_window * 0.87 - 13,000 buffer
  - FounderOS equivalent: 80% (conservative, uses cheap NANO model)
  - Circuit breaker: 3 consecutive failures → stop retrying this session
  - Compaction model: NANO (Gemini Flash Lite) — cheap and fast

The 9-section compaction prompt is copied VERBATIM from Claude Code's
compact/prompt.ts BASE_COMPACT_PROMPT (the production prompt they ship).

Usage:
    from memory.context_manager import ContextManager

    cm = ContextManager()
    messages = [{"role": "user", "content": "..."}]

    # Check and compact if needed (call after every agent turn):
    messages = cm.maybe_compact(messages, agent_name="orchestrator")

    # Or check manually:
    if cm.should_compact(messages):
        messages = cm.compact(messages)
"""

import re
import logging
import time
from pathlib import Path

log = logging.getLogger("ContextManager")

# ─── Constants (from autoCompact.ts) ─────────────────────────────────────────

# Claude Code uses 87% with a 13k buffer. We use 80% (more conservative).
COMPACT_THRESHOLD_PCT = 0.80

# Claude Code: p99.99 of compact summary output = 17,387 tokens
# We allow up to 3000 tokens for summary (NANO model, shorter responses)
COMPACT_CIRCUIT_BREAKER_MAX = 3  # Stop after 3 consecutive failures

# Default assumed context window for Gemini 2.5 Flash (1M token context)
# But effective window is much smaller in practice — we use 100k as safe default
DEFAULT_CONTEXT_WINDOW = 100_000


# ─── The Exact Claude Code 9-Section Compaction Prompt ───────────────────────
# Copied verbatim from compact/prompt.ts BASE_COMPACT_PROMPT
# Used in production by Anthropic for Claude Code sessions.

COMPACT_PROMPT = """Your task is to create a detailed summary of the conversation so far,
paying close attention to all explicit requests, decisions, and outcomes.
This summary will REPLACE the entire conversation history — nothing else will be available.
Be thorough. Preserve all technical details.

Your summary MUST include these 9 sections:

1. Primary Request and Intent
   Capture ALL of the user's explicit requests and intents in detail.

2. Key Technical Concepts
   List all important technical concepts, technologies, frameworks, and decisions discussed.

3. Files, Code, and Actions
   Enumerate specific files examined, modified, or created. Include full code snippets
   where applicable. Include exact tool calls made and their results.

4. Errors and Fixes
   List all errors encountered and how they were fixed. Note user feedback on any fix.

5. Problem Solving
   Document problems solved and any ongoing troubleshooting efforts.

6. All User Messages
   List ALL user/chairman messages. Critical for understanding evolving intent.

7. Pending Tasks
   Outline any pending tasks that have been explicitly requested and not yet completed.

8. Current Work
   Describe PRECISELY what was being worked on immediately before this compaction.
   Include file names, exact state, and any intermediate results.

9. Next Step
   The immediate next action. Include DIRECT QUOTES from the most recent conversation.
   Only list next steps explicitly in line with the user's most recent request.

Respond ONLY with a <summary>...</summary> block containing the 9 sections above.
Do NOT call any tools. Your entire response must be plain text.
"""


# ─── Token Estimation ─────────────────────────────────────────────────────────

def estimate_tokens(messages: list[dict]) -> int:
    """
    Fast token estimate without tiktoken.
    Rule: ~4 characters per token (GPT/Claude average for English).
    """
    total_chars = 0
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, list):
            # Handle multi-part content (tool results, etc.)
            for block in content:
                if isinstance(block, dict):
                    total_chars += len(str(block.get("text", block.get("content", ""))))
                else:
                    total_chars += len(str(block))
        else:
            total_chars += len(str(content))
    return total_chars // 4


# ─── Context Manager ──────────────────────────────────────────────────────────

class ContextManager:
    """
    Manages conversation context length for FounderOS agents.

    Borrowed from Claude Code autoCompact.ts with Python adaptations.
    Maintains per-session circuit breaker state.
    """

    def __init__(
        self,
        threshold_pct: float = COMPACT_THRESHOLD_PCT,
        context_window: int = DEFAULT_CONTEXT_WINDOW,
    ):
        self.threshold_pct = threshold_pct
        self.context_window = context_window
        self.threshold_tokens = int(context_window * threshold_pct)

        # Circuit breaker state (Claude Code: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3)
        self._consecutive_failures = 0
        self._circuit_tripped_at: float | None = None
        self._circuit_reset_secs = 300  # 5 minutes

    def should_compact(self, messages: list[dict]) -> bool:
        """
        Check if context has hit the compaction threshold.

        Returns False if circuit breaker is tripped (stop hammering on failure).
        """
        # Circuit breaker check
        if self._consecutive_failures >= COMPACT_CIRCUIT_BREAKER_MAX:
            elapsed = time.time() - (self._circuit_tripped_at or 0)
            if elapsed < self._circuit_reset_secs:
                log.debug("[ContextManager] Circuit breaker open — skipping compaction check")
                return False
            else:
                log.info("[ContextManager] Circuit breaker reset after cooldown")
                self._consecutive_failures = 0
                self._circuit_tripped_at = None

        token_count = estimate_tokens(messages)
        over_threshold = token_count >= self.threshold_tokens

        if over_threshold:
            pct = (token_count / self.context_window) * 100
            log.info(
                f"[ContextManager] Context at {pct:.1f}% "
                f"({token_count:,} / {self.context_window:,} tokens) — compaction needed"
            )

        return over_threshold

    def compact(
        self,
        messages: list[dict],
        agent_name: str = "agent",
        save_transcript: bool = True,
    ) -> list[dict]:
        """
        Compact the conversation by summarising history with the 9-section prompt.

        Claude Code pattern: replaces ALL messages with the summary, then the
        agent continues as if development never stopped.

        Args:
            messages: Current conversation history
            agent_name: Used for transcript file naming
            save_transcript: Whether to save full transcript before compaction

        Returns:
            New compressed message list (summary + last 2 messages for continuity)
        """
        from core.config import call_nano

        if save_transcript:
            self._save_transcript(messages, agent_name)

        token_count = estimate_tokens(messages)
        log.info(
            f"[ContextManager] Compacting {len(messages)} messages "
            f"({token_count:,} tokens) for '{agent_name}'"
        )

        # Build the full conversation text for summarisation
        conversation_text = self._format_for_summary(messages)
        full_prompt = f"Conversation to summarise:\n\n{conversation_text}\n\n{COMPACT_PROMPT}"

        try:
            raw_summary = call_nano(full_prompt)

            # Extract the <summary>...</summary> block
            match = re.search(r'<summary>(.*?)</summary>', raw_summary, re.DOTALL)
            if match:
                summary_text = match.group(1).strip()
            else:
                summary_text = raw_summary.strip()

            # Reset circuit breaker on success
            self._consecutive_failures = 0
            self._circuit_tripped_at = None

            log.info(
                f"[ContextManager] Compaction complete — "
                f"summary: {estimate_tokens([{'content': summary_text}]):,} tokens"
            )

            # Return compacted history: system summary + preserve last 2 messages for continuity
            compacted = [
                {
                    "role": "system",
                    "content": (
                        "[COMPACTED CONTEXT — Session was compacted to save context space]\n\n"
                        f"{summary_text}\n\n"
                        "Continue working from where we left off. Do not acknowledge this compaction."
                    )
                }
            ]

            # Preserve last 2 real messages for immediate context continuity
            if len(messages) >= 2:
                compacted.extend(messages[-2:])

            return compacted

        except Exception as e:
            self._consecutive_failures += 1
            if self._consecutive_failures >= COMPACT_CIRCUIT_BREAKER_MAX:
                self._circuit_tripped_at = time.time()
                log.error(
                    f"[ContextManager] Circuit breaker tripped after "
                    f"{self._consecutive_failures} consecutive failures"
                )
            log.error(f"[ContextManager] Compaction failed: {e}")
            # Return original messages unchanged — don't crash the agent
            return messages

    def maybe_compact(
        self,
        messages: list[dict],
        agent_name: str = "agent",
    ) -> list[dict]:
        """
        Convenience: check threshold and compact if needed.

        Call this after EVERY agent turn:
            messages = cm.maybe_compact(messages, agent_name="orchestrator")
        """
        if self.should_compact(messages):
            return self.compact(messages, agent_name)
        return messages

    def usage_report(self, messages: list[dict]) -> dict:
        """Return current token usage statistics."""
        token_count = estimate_tokens(messages)
        pct = (token_count / self.context_window) * 100
        return {
            "token_count": token_count,
            "context_window": self.context_window,
            "threshold": self.threshold_tokens,
            "pct_used": round(pct, 1),
            "needs_compact": token_count >= self.threshold_tokens,
            "circuit_breaker_failures": self._consecutive_failures,
        }

    def _format_for_summary(self, messages: list[dict]) -> str:
        """Format messages into readable text for the summarisation model."""
        lines = []
        for msg in messages:
            role = msg.get("role", "unknown").upper()
            content = msg.get("content", "")
            if isinstance(content, list):
                content = " | ".join(
                    str(b.get("text", b.get("content", str(b))))
                    for b in content
                    if isinstance(b, dict)
                )
            lines.append(f"{role}: {str(content)[:2000]}")
        return "\n".join(lines)

    def _save_transcript(self, messages: list[dict], agent_name: str) -> None:
        """Save full transcript to disk before compaction (for debugging)."""
        try:
            from core.config import STRATEGIC_DIR
            transcript_dir = STRATEGIC_DIR / "transcripts"
            transcript_dir.mkdir(parents=True, exist_ok=True)
            timestamp = int(time.time())
            path = transcript_dir / f"{agent_name}_{timestamp}_pre_compact.txt"
            content = self._format_for_summary(messages)
            path.write_text(content, encoding="utf-8")
            log.debug(f"[ContextManager] Transcript saved: {path}")
        except Exception as e:
            log.debug(f"[ContextManager] Could not save transcript: {e}")


# ─── Module-level default instance ────────────────────────────────────────────

# Shared instance for use across the system
default_cm = ContextManager()


def maybe_compact(messages: list[dict], agent_name: str = "agent") -> list[dict]:
    """Module-level convenience function using the default ContextManager."""
    return default_cm.maybe_compact(messages, agent_name)
