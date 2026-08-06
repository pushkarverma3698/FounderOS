"""The crash-safe local record of what the founder did.

WRITTEN BEFORE THE PUSH, ALWAYS. Every click appends one line to a JSONL file
and is flushed to disk immediately, then the flow-back to Postgres happens at
session end. If the laptop dies mid-queue — closed lid, browser crash, killed
terminal — the applications he already submitted are on disk, and the next sync
pushes them.

The alternative, holding outcomes in memory until the end, means a crash at job
nineteen of twenty loses all nineteen. The founder would then see them back in
tomorrow's queue and either apply twice or, having noticed, stop trusting the
queue at all.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

LEDGER_DIR = Path(__file__).resolve().parent.parent / ".queue"
LEDGER_PATH = LEDGER_DIR / "outcomes.jsonl"

APPLIED = "applied"
SKIPPED = "skipped"


@dataclass(frozen=True)
class Outcome:
    job_id: str
    outcome: str
    at: str
    company: str = ""
    title: str = ""


def record(job_id: str, outcome: str, company: str = "", title: str = "",
           path: Path = LEDGER_PATH) -> Outcome:
    """Append one outcome and flush it to disk before returning.

    The flush is the point. A buffered write that is still in memory when the
    process dies is indistinguishable from a click that never happened.
    """
    if outcome not in (APPLIED, SKIPPED):
        raise ValueError(f"unknown outcome {outcome!r} — expected {APPLIED} or {SKIPPED}")

    entry = Outcome(
        job_id=job_id,
        outcome=outcome,
        at=datetime.now(timezone.utc).isoformat(),
        company=company,
        title=title,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json.dumps(entry.__dict__) + "\n")
        handle.flush()
    return entry


def pending(path: Path = LEDGER_PATH) -> list[Outcome]:
    """Everything recorded locally and not yet confirmed pushed.

    A malformed line is SKIPPED, not fatal. A single corrupt line — the shape a
    half-written record takes when the machine dies mid-append — must not
    strand every valid outcome behind it.
    """
    if not path.exists():
        return []
    out: list[Outcome] = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
            out.append(Outcome(**raw))
        except (json.JSONDecodeError, TypeError):
            continue
    return out


def split_pending(entries: list[Outcome]) -> tuple[list[str], list[str]]:
    """(applied ids, skipped ids) for the flow-back push."""
    applied = [e.job_id for e in entries if e.outcome == APPLIED]
    skipped = [e.job_id for e in entries if e.outcome == SKIPPED]
    return applied, skipped


def clear(path: Path = LEDGER_PATH) -> None:
    """Drop the local ledger AFTER a confirmed push.

    Only ever called once Postgres has acknowledged the update. Clearing on
    attempt rather than on confirmation would silently discard the founder's
    afternoon the first time the VPS was unreachable.
    """
    if path.exists():
        path.unlink()
