"""
FounderOS — Task Protocol (v1.0)
=================================
Structured XML result format for inter-agent communication.

Borrowed from: Claude Code `src/coordinator/coordinatorMode.ts`
Pattern: <task-notification> XML envelope for worker→coordinator results.

WHY: FounderOS previously used free-form JSON (broken by repair_json failures).
     This replaces it with a parse-safe XML protocol that coordinators can
     structurally read without LLM assistance.

Usage:
    # In worker agents — wrap your result:
    from core.task_protocol import format_task_notification
    return format_task_notification("worker-01", "completed", "Found 3 leads", result_text)

    # In orchestrator/coordinator — parse worker results:
    from core.task_protocol import parse_task_notification
    notif = parse_task_notification(worker_response)
    if notif and notif.status == "completed":
        process(notif.result)
"""

import xml.etree.ElementTree as ET
import time
import logging
from dataclasses import dataclass, field

log = logging.getLogger("TaskProtocol")


@dataclass
class TaskNotification:
    """Structured result from a worker agent back to coordinator."""
    task_id: str
    status: str          # "completed" | "failed" | "killed"
    summary: str
    result: str
    agent_name: str = ""
    tokens_used: int = 0
    duration_ms: int = 0
    timestamp: str = field(default_factory=lambda: str(int(time.time())))


def format_task_notification(
    task_id: str,
    status: str,
    summary: str,
    result: str,
    agent_name: str = "",
    tokens_used: int = 0,
    duration_ms: int = 0,
) -> str:
    """
    Create a structured XML task notification for a worker to send to its coordinator.

    Borrowed from Claude Code coordinatorMode.ts task-notification format.
    Workers call this at the end of their execution to report structured results.

    Example output:
        <task-notification>
          <task-id>worker-01</task-id>
          <status>completed</status>
          <summary>Found 3 high-quality Upwork leads</summary>
          <result>Lead 1: Acme Corp ...</result>
          <usage>
            <total_tokens>1200</total_tokens>
            <duration_ms>4200</duration_ms>
          </usage>
        </task-notification>
    """
    result_snippet = result[:3000] if len(result) > 3000 else result
    return f"""<task-notification>
<task-id>{_esc(task_id)}</task-id>
<status>{_esc(status)}</status>
<agent>{_esc(agent_name)}</agent>
<summary>{_esc(summary)}</summary>
<result>{_esc(result_snippet)}</result>
<usage>
  <total_tokens>{tokens_used}</total_tokens>
  <duration_ms>{duration_ms}</duration_ms>
</usage>
<timestamp>{int(time.time())}</timestamp>
</task-notification>"""


def parse_task_notification(text: str) -> TaskNotification | None:
    """
    Parse a task-notification XML envelope from a worker response.

    Coordinator agents call this to extract structured results.
    Returns None if the text does not contain a valid task-notification.
    """
    try:
        # Locate the task-notification block by string search — avoids XML parse
        # errors when surrounding LLM output contains stray < or > characters.
        import re
        match = re.search(r'<task-notification>.*?</task-notification>', text, re.DOTALL)
        if not match:
            return None
        notif = ET.fromstring(match.group(0))
        usage = notif.find("usage")

        def _get(tag: str, default: str = "") -> str:
            el = notif.find(tag)
            return (el.text or default) if el is not None else default

        tokens_text = usage.findtext("total_tokens", "0") if usage is not None else "0"
        duration_text = usage.findtext("duration_ms", "0") if usage is not None else "0"

        return TaskNotification(
            task_id=_get("task-id", "unknown"),
            status=_get("status", "unknown"),
            summary=_get("summary"),
            result=_get("result"),
            agent_name=_get("agent"),
            tokens_used=int(tokens_text or "0"),
            duration_ms=int(duration_text or "0"),
            timestamp=_get("timestamp"),
        )
    except ET.ParseError:
        log.debug("parse_task_notification: no valid XML found in response")
        return None
    except Exception as e:
        log.warning(f"parse_task_notification: unexpected error — {e}")
        return None


def _esc(text: str) -> str:
    """Escape special XML characters in text content."""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def is_task_notification(text: str) -> bool:
    """Quick check: does this text contain a task-notification?"""
    return "<task-notification>" in text


def format_failed_notification(task_id: str, error: str, agent_name: str = "") -> str:
    """Convenience: format a failure notification."""
    return format_task_notification(
        task_id=task_id,
        status="failed",
        summary=f"Task failed: {error[:200]}",
        result=f"Error details: {error}",
        agent_name=agent_name,
    )
