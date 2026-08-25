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
  SELECT id, company, title, track, url, brief_rank, brief_section, tailored_cv_s3_key, cover_letter_s3_key
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
    cover_letter_s3_key: str | None = None

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
            cover_letter_s3_key=row.get("cover_letter_s3_key"),
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


#: Where the profile lives on the VPS. THE SOURCE OF TRUTH, founder's call
#: 2026-08-24, so `/profile` in Telegram edits the same file the browser session
#: fills forms from. A second hand-maintained copy on the laptop is how the
#: client ends up typing an address he changed three weeks ago.
REMOTE_PROFILE_PATH = "/opt/founderos-data/apply-profile.json"

#: aws CLI has neither credentials nor a bucket name without this. Both only
#: ever reach the Node process via systemd's EnvironmentFile= — never an SSH
#: login shell. Found live, 2026-08-25: every _fetch_s3_artifact call failed
#: silently (aws: command not found, and even once installed, $STORAGE_BUCKET
#: was empty) for both the cover letter and the pre-existing tailored CV —
#: the function's designed-to-be-silent failure mode had hidden a fetch that
#: had never once worked.
REMOTE_ENV_FILE = "/opt/founderos/.env"


def fetch_profile() -> str | None:
    """The apply profile as it stands on the VPS, or None if there is none yet.

    None is a real answer, not a failure: the founder may not have run
    ``/profile`` yet, and the local file — if he wrote one by hand — must keep
    working. What is NOT tolerated is a partial or unparseable pull silently
    replacing a good local profile, so this validates before returning.
    """
    command = ["ssh", SSH_HOST, f"sudo -n cat {REMOTE_PROFILE_PATH}"]
    try:
        done = subprocess.run(
            command, capture_output=True, text=True, timeout=SSH_TIMEOUT_S, check=False
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    if done.returncode != 0 or not done.stdout.strip():
        return None
    try:
        json.loads(done.stdout)
    except json.JSONDecodeError:
        # A truncated read is worse than no read: it would overwrite a working
        # profile with something `load_profile` then rejects, and the founder
        # would see "missing: first_name" on a file he never touched.
        return None
    return done.stdout


def sync_profile(path: Path | None = None) -> bool:
    """Write the VPS profile over the local one. True when it was updated.

    Returns rather than raises, and the caller reports it — the queue is still
    worth syncing when the profile pull fails, and a stale profile is a visible
    problem (`load_profile` names every missing field) rather than a silent one.
    """
    target = path or (QUEUE_DIR.parent / "apply-profile.json")
    remote = fetch_profile()
    if remote is None:
        return False
    if target.exists() and target.read_text() == remote:
        return False
    target.write_text(remote)
    target.chmod(0o600)
    return True


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


def _fetch_s3_artifact(s3_key: str, dest_path: Path, min_bytes: int) -> bool:
    """One best-effort S3 pull over the existing SSH host. False on any
    failure — a missing artifact must never stop the rest of the queue from
    syncing, the same reasoning save_queue() already applies to the CV.
    """
    ok, _reason = _fetch_s3_artifact_verbose(s3_key, dest_path, min_bytes)
    return ok


def _fetch_s3_artifact_verbose(s3_key: str, dest_path: Path, min_bytes: int) -> tuple[bool, str | None]:
    """Same contract as `_fetch_s3_artifact`, but keeps WHY on failure instead
    of discarding it.

    T1a, 2026-08-25: the bool-only version made a failed fetch indistinguishable
    from "nothing to fetch" — `save_queue` called it and threw the result away,
    so a tailored CV that silently never arrived looked identical to one that
    arrived fine, right up until the generic PDF shipped in its place. This is
    what `save_queue` now reports through, and what `_fetch_s3_artifact` above
    still is for callers that only need the boolean.
    """
    if dest_path.exists():
        return True, None
    try:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            "ssh", SSH_HOST,
            f'set -a; source {REMOTE_ENV_FILE}; set +a; '
            f'aws s3 cp "s3://$STORAGE_BUCKET/{s3_key}" -',
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30, check=False)
        if proc.returncode == 0 and len(proc.stdout) > min_bytes:
            dest_path.write_bytes(proc.stdout)
            return True, None
        stderr = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        reason = stderr[:200] if stderr else f"empty or too-short response ({len(proc.stdout)} bytes, need >{min_bytes})"
        return False, reason
    except subprocess.TimeoutExpired:
        return False, "ssh timed out after 30s"
    except Exception as err:  # noqa: BLE001 — a fetch must never crash the rest of the sync
        return False, str(err)[:200]


def save_queue(jobs: list[QueueJob], path: Path = QUEUE_PATH) -> list[tuple[str, str]]:
    """Cache the queue so the browser session does not need the network.

    Returns one (company, reason) pair per S3 artifact that failed to fetch.
    T1a: this used to call `_fetch_s3_artifact` and discard the result, so a
    fetch that never worked was indistinguishable from one that never ran —
    the caller (`wake.py`) folds this into what the founder is told, instead.
    A fetch failure never blocks the rest of the queue from syncing.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([j.__dict__ for j in jobs], indent=2))

    failures: list[tuple[str, str]] = []
    for job in jobs:
        job_dir = path.parent / job.id
        if job.tailored_cv_s3_key:
            ok, reason = _fetch_s3_artifact_verbose(job.tailored_cv_s3_key, job_dir / "tailored_cv.pdf", min_bytes=100)
            if not ok:
                failures.append((job.company, f"tailored CV — {reason}"))
        if job.cover_letter_s3_key:
            ok, reason = _fetch_s3_artifact_verbose(job.cover_letter_s3_key, job_dir / "cover_letter.txt", min_bytes=20)
            if not ok:
                failures.append((job.company, f"cover letter — {reason}"))
    return failures


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
