"""
FounderOS — Parallel Dispatch (v1.0)
======================================
Async coordinator-worker parallel execution engine.

Borrowed from: Claude Code `src/coordinator/coordinatorMode.ts`
Pattern: Fire N workers simultaneously via asyncio, collect structured results.

WHY: FounderOS previously ran agents sequentially (CEO → MD → Worker → END).
     This module enables true parallel multi-agent tasks — 3-7 workers running
     simultaneously the way Claude Code's coordinator does.

Key principles from Claude Code:
  1. "Parallelism is your superpower. Workers are async."
  2. Read-only tasks (research) — run freely in parallel
  3. Write-heavy tasks — one at a time per file/resource set
  4. Workers need SELF-CONTAINED prompts (no "based on your findings")
  5. After parallel research, SYNTHESIZE before dispatching implementation

Usage:
    from core.parallel_dispatch import dispatch_parallel, WorkerTask

    tasks = [
        WorkerTask("auth-bug-research", "MD", "Investigate auth module in src/auth/..."),
        WorkerTask("test-research", "MD", "Find all auth test files..."),
    ]
    results = asyncio.run(dispatch_parallel(tasks))
    for r in results:
        if r.status == "completed":
            process(r.result)
"""

import asyncio
import time
import logging
import threading
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor

from core.config import call_md, call_ceo, call_nano, call_deep_research, call_with_fallback
from core.task_protocol import TaskNotification, format_task_notification, parse_task_notification

log = logging.getLogger("ParallelDispatch")

# Thread pool for running sync `call_*` functions in async context
_executor = ThreadPoolExecutor(max_workers=10, thread_name_prefix="founder_worker")


# ─── Worker Task Definition ───────────────────────────────────────────────────

@dataclass
class WorkerTask:
    """
    A single task to dispatch to a worker.

    Claude Code equivalent: AgentTool({ description, subagent_type, prompt })
    """
    task_id: str           # Unique ID (e.g., "auth-research-01")
    tier: str              # "CEO" | "MD" | "NANO" | "DEEP" | "LOCAL"
    prompt: str            # MUST be self-contained — worker can't see coordinator context
    agent_name: str = ""   # Agent persona to use (injects skill prompt if provided)
    system_prompt: str = ""  # Optional override system prompt


@dataclass
class WorkerResult:
    """Result from a completed/failed worker."""
    task_id: str
    status: str            # "completed" | "failed" | "timeout"
    result: str
    summary: str
    duration_ms: int = 0
    tokens_estimated: int = 0


# ─── Tier Router ──────────────────────────────────────────────────────────────

def _call_for_tier(tier: str, prompt: str, system: str = "") -> str:
    """Route a prompt to the correct model cascade based on tier."""
    tier_upper = tier.upper()
    if tier_upper == "CEO":
        return call_ceo(prompt, system)
    elif tier_upper in ("DEEP", "DEEP_RESEARCH"):
        return call_deep_research(prompt, system)
    elif tier_upper == "NANO":
        return call_nano(prompt, system)
    elif tier_upper == "MD":
        return call_md(prompt, system)
    else:
        log.warning(f"Unknown tier '{tier}', defaulting to MD cascade")
        return call_md(prompt, system)


# ─── Single Worker Execution ──────────────────────────────────────────────────

async def _run_worker(task: WorkerTask, timeout_secs: float = 120.0) -> WorkerResult:
    """
    Execute a single worker task asynchronously.

    Runs the sync call_* function in a thread pool executor so it doesn't
    block the event loop (matching Claude Code's async worker pattern).
    """
    start_ms = int(time.time() * 1000)
    log.info(f"[Dispatch] Starting worker '{task.task_id}' (tier={task.tier})")

    # Build system prompt — inject agent skill if provided
    system = task.system_prompt
    if task.agent_name and not system:
        try:
            from utils.skill_library import get_expert_system_prompt, SKILL_MAP
            if task.agent_name in SKILL_MAP:
                system = get_expert_system_prompt(task.agent_name, task.prompt[:100])
        except ImportError:
            pass

    loop = asyncio.get_event_loop()

    try:
        # Run sync model call in thread pool (non-blocking)
        raw_result = await asyncio.wait_for(
            loop.run_in_executor(
                _executor,
                _call_for_tier,
                task.tier,
                task.prompt,
                system,
            ),
            timeout=timeout_secs,
        )

        duration_ms = int(time.time() * 1000) - start_ms
        tokens_est = len(raw_result) // 4  # Rough estimate: 4 chars/token

        log.info(f"[Dispatch] Worker '{task.task_id}' completed in {duration_ms}ms")

        return WorkerResult(
            task_id=task.task_id,
            status="completed",
            result=raw_result,
            summary=f"Worker '{task.task_id}' completed successfully",
            duration_ms=duration_ms,
            tokens_estimated=tokens_est,
        )

    except asyncio.TimeoutError:
        duration_ms = int(time.time() * 1000) - start_ms
        log.error(f"[Dispatch] Worker '{task.task_id}' timed out after {timeout_secs}s")
        return WorkerResult(
            task_id=task.task_id,
            status="timeout",
            result=f"Worker timed out after {timeout_secs} seconds",
            summary=f"Worker '{task.task_id}' timed out",
            duration_ms=duration_ms,
        )

    except Exception as e:
        duration_ms = int(time.time() * 1000) - start_ms
        log.error(f"[Dispatch] Worker '{task.task_id}' failed: {e}")
        return WorkerResult(
            task_id=task.task_id,
            status="failed",
            result=f"Worker error: {str(e)}",
            summary=f"Worker '{task.task_id}' failed: {str(e)[:100]}",
            duration_ms=duration_ms,
        )


# ─── Parallel Dispatch (Main API) ─────────────────────────────────────────────

async def dispatch_parallel(
    tasks: list[WorkerTask],
    timeout_secs: float = 120.0,
    max_concurrent: int = 7,
) -> list[WorkerResult]:
    """
    Dispatch multiple worker tasks in parallel and collect all results.

    Claude Code pattern (coordinatorMode.ts):
        "Launch independent workers concurrently whenever possible —
         don't serialize work that can run simultaneously."

    Args:
        tasks: List of WorkerTask to execute concurrently
        timeout_secs: Per-worker timeout (default 120s)
        max_concurrent: Maximum simultaneous workers (default 7)

    Returns:
        List of WorkerResult in the same order as tasks
    """
    if not tasks:
        return []

    log.info(f"[Dispatch] Launching {len(tasks)} parallel workers (max_concurrent={max_concurrent})")

    # Semaphore limits concurrency to prevent API rate limit hammering
    semaphore = asyncio.Semaphore(max_concurrent)

    async def guarded_worker(task: WorkerTask) -> WorkerResult:
        async with semaphore:
            return await _run_worker(task, timeout_secs)

    # Fire all tasks simultaneously, collect results preserving order
    results = await asyncio.gather(
        *[guarded_worker(t) for t in tasks],
        return_exceptions=False,
    )

    completed = sum(1 for r in results if r.status == "completed")
    failed = sum(1 for r in results if r.status == "failed")
    timed_out = sum(1 for r in results if r.status == "timeout")

    log.info(
        f"[Dispatch] All workers done — "
        f"completed={completed}, failed={failed}, timeout={timed_out}"
    )

    return list(results)


def dispatch_parallel_sync(
    tasks: list[WorkerTask],
    timeout_secs: float = 120.0,
) -> list[WorkerResult]:
    """
    Synchronous wrapper for dispatch_parallel.
    Use this from synchronous code (APScheduler jobs, LangGraph nodes).

    Example:
        results = dispatch_parallel_sync([
            WorkerTask("lead-01", "MD", "Find 3 high-ICP companies on ProductHunt..."),
            WorkerTask("lead-02", "MD", "Search AngelList for Series A Python startups..."),
            WorkerTask("lead-03", "DEEP", "Research EU tech companies hiring AI engineers..."),
        ])
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:
        # Active event loop detected — run dispatch in a dedicated thread with
        # its own fresh loop to avoid clashing with the caller's loop.
        import concurrent.futures

        def _runner() -> list[WorkerResult]:
            return asyncio.run(dispatch_parallel(tasks, timeout_secs))

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            return executor.submit(_runner).result(timeout=timeout_secs + 10)

    return asyncio.run(dispatch_parallel(tasks, timeout_secs))


# ─── Synthesis Helper ─────────────────────────────────────────────────────────

def synthesize_results(results: list[WorkerResult], synthesis_prompt_prefix: str = "") -> str:
    """
    After parallel research workers return, synthesize their findings.

    Claude Code principle: "After research completes, you ALWAYS synthesize —
    never write 'based on your findings'. Read the findings yourself."

    This function compiles worker outputs into a synthesis prompt for the CEO.
    """
    completed = [r for r in results if r.status == "completed"]
    if not completed:
        return "No workers completed successfully."

    # Cap per-worker at 500 chars — synthesizer needs signal, not raw dumps
    findings_block = "\n\n".join(
        f"[{r.task_id}]: {r.result[:500]}"
        for r in completed
    )

    prefix = synthesis_prompt_prefix + "\n\n" if synthesis_prompt_prefix else ""

    return (
        f"{prefix}"
        f"Worker findings ({len(completed)} workers completed):\n\n"
        f"{findings_block}\n\n"
        f"Based on ALL the above findings, provide a synthesized analysis and next action plan."
    )
