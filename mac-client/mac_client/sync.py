"""Pull the ranked apply queue from the VPS, and push back what was done.

ONE SOURCE OF TRUTH. The queue is read straight from the production Postgres
over SSH — not from a scp'd SQLite file, not from the Google Sheet. The Sheet is
a view the founder reads; if this client also read it, a Sheets outage or a
half-finished write would become an apply-queue that disagreed with the
database, and the visible symptom would be applying twice to the same role.

The prototype this replaces scp'd ``jobs.db`` from a path the real pipeline
never wrote to, and queried a table (``jobs``) that did not exist — so it
reported zero jobs forever, and the error was swallowed.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

SSH_HOST = "founderos-vps"
PSQL = "sudo -n docker exec founderos-postgres psql -U founderos -d founderos -t -A -c"

QUEUE_DIR = Path(__file__).resolve().parent.parent / ".queue"
QUEUE_PATH = QUEUE_DIR / "queue.json"

#: Long enough for a slow link, short enough that a hung SSH is a failure and
#: not a session the founder waits on forever.
SSH_TIMEOUT_S = 60

#: `applied_at IS NULL AND skipped_at IS NULL` is the whole definition of "still
#: in the queue"; `brief_section` is written by brief-select.ts and is the only
#: place that decides which rows are actionable — re-deciding it here would
#: create a second answer that drifts from the Sheet's.
QUEUE_SQL = """
SELECT coalesce(json_agg(row_to_json(q) ORDER BY q.brief_rank), '[]'::json)
FROM (
  SELECT id, company, title, track, url, brief_rank, brief_section, tailored_cv_s3_key
  FROM agents.job_applications
  WHERE tenant_id = 'turicks'
    AND brief_section IN ('do_today','stretch')
    AND applied_at IS NULL
    AND skipped_at IS NULL
    AND url IS NOT NULL
  ORDER BY brief_rank
) q
"""


class SyncError(RuntimeError):
    """The VPS could not be reached or answered with something unusable."""


@dataclass(frozen=True)
class QueueJob:
    id: str
    company: str
    title: str
    track: str
    url: str
    brief_rank: int | None
    tailored_cv_s3_key: str | None = None

    @staticmethod
    def from_row(row: dict) -> "QueueJob":
        return QueueJob(
            id=str(row["id"]),
            company=str(row.get("company") or ""),
            title=str(row.get("title") or ""),
            track=str(row.get("track") or "unclassified"),
            url=str(row.get("url") or ""),
            brief_rank=row.get("brief_rank"),
            tailored_cv_s3_key=row.get("tailored_cv_s3_key"),
        )


def run_remote(sql: str) -> str:
    """One psql statement on the VPS. Raises with stderr rather than returning ''.

    An empty string is a valid psql result, so a failure that returned one would
    be read as "the queue is empty" — the founder would open the client, see
    nothing to do, and conclude the pipeline found no jobs.
    """
    command = ["ssh", SSH_HOST, f'{PSQL} "{sql.strip()}"']
    try:
        done = subprocess.run(
            command, capture_output=True, text=True, timeout=SSH_TIMEOUT_S, check=False
        )
    except subprocess.TimeoutExpired as err:
        raise SyncError(f"{SSH_HOST} did not answer within {SSH_TIMEOUT_S}s") from err
    except FileNotFoundError as err:
        raise SyncError("ssh is not installed or not on PATH") from err

    if done.returncode != 0:
        raise SyncError(f"{SSH_HOST} returned {done.returncode}: {done.stderr.strip()[:300]}")
    return done.stdout.strip()


def fetch_queue() -> list[QueueJob]:
    """The ranked queue, best first."""
    payload = run_remote(QUEUE_SQL)
    if not payload:
        raise SyncError("the queue query returned nothing at all — that is a failure, not an empty queue")
    try:
        rows = json.loads(payload)
    except json.JSONDecodeError as err:
        raise SyncError(f"could not parse the queue: {payload[:200]}") from err
    return [QueueJob.from_row(r) for r in rows]


def save_queue(jobs: list[QueueJob], path: Path = QUEUE_PATH) -> None:
    """Cache the queue so the browser session does not need the network."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([j.__dict__ for j in jobs], indent=2))

    # Fetch tailored CV PDFs for jobs that have them
    for job in jobs:
        if job.tailored_cv_s3_key:
            job_dir = path.parent / job.id
            job_dir.mkdir(parents=True, exist_ok=True)
            pdf_path = job_dir / "tailored_cv.pdf"
            if not pdf_path.exists():
                try:
                    # Download via AWS CLI or SSH S3 stream helper
                    cmd = ["ssh", SSH_HOST, f'aws s3 cp "s3://$STORAGE_BUCKET/{job.tailored_cv_s3_key}" -']
                    proc = subprocess.run(cmd, capture_output=True, timeout=30, check=False)
                    if proc.returncode == 0 and len(proc.stdout) > 100:
                        pdf_path.write_bytes(proc.stdout)
                except Exception:
                    pass


def load_queue(path: Path = QUEUE_PATH) -> list[QueueJob]:
    """Read the cached queue. Missing file means 'not synced yet', not 'empty'."""
    if not path.exists():
        raise SyncError(f"no synced queue at {path} — run the sync first")
    return [QueueJob.from_row(r) for r in json.loads(path.read_text())]


def push_outcomes(applied_ids: list[str], skipped_ids: list[str]) -> int:
    """Record what the founder did, back where the truth lives.

    ``IS NULL`` guards make this idempotent: the client retries after a failed
    push, and a retry must not move a timestamp set an hour ago. Returns rows
    changed so a push that matched nothing is visible as such.
    """
    statements = []
    if applied_ids:
        ids = ",".join(f"'{_uuid(i)}'" for i in applied_ids)
        statements.append(
            "UPDATE agents.job_applications SET applied_at = now(), stage = 'applied', "
            f"updated_at = now() WHERE id IN ({ids}) AND applied_at IS NULL"
        )
    if skipped_ids:
        ids = ",".join(f"'{_uuid(i)}'" for i in skipped_ids)
        statements.append(
            "UPDATE agents.job_applications SET skipped_at = now(), updated_at = now() "
            f"WHERE id IN ({ids}) AND skipped_at IS NULL"
        )
    if not statements:
        return 0

    changed = 0
    for statement in statements:
        # RETURNING + count so a no-op UPDATE is distinguishable from a real one.
        out = run_remote(f"WITH u AS ({statement} RETURNING 1) SELECT count(*) FROM u")
        changed += int(out or 0)
    return changed


def _uuid(value: str) -> str:
    """Reject anything that is not a plain UUID before it reaches SQL.

    These ids come from our own database via our own query, so this is not the
    primary defence — it is the one that still holds if that ever stops being
    true. psql takes the statement as a shell argument, so a crafted id would be
    both an injection and a shell-quoting problem.
    """
    cleaned = value.strip()
    allowed = set("0123456789abcdefABCDEF-")
    if len(cleaned) != 36 or not set(cleaned) <= allowed:
        raise SyncError(f"refusing to send a non-UUID row id: {value!r}")
    return cleaned
