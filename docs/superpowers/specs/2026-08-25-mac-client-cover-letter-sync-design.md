# Mac client: sync the cover letter the VPS already made

## The problem, stated precisely

`/apply N` and `/draft N` already produce a tailored resume **and** a cover
letter for a row, via the LLM, and archive both to S3 on the same
`job_applications` row (`tailored_cv_s3_key`, `cover_letter_s3_key` —
`src/tools/jobhunt/apply-packet.ts:115-131`, `src/gateway/cover-letter-delivery.ts:107-124`).
`mac_client/sync.py` already pulls the tailored CV down for any queued job
that has one (`QUEUE_SQL`, `QueueJob.tailored_cv_s3_key`, the fetch loop in
`save_queue()`). It never asks for the cover letter — `cover_letter_s3_key`
isn't in the `SELECT`, isn't on `QueueJob`, and nothing fetches it. The letter
exists, on the same row, fetched the same way, and the mac client simply
doesn't ask for it.

This was raised and confirmed live on 2026-08-25 while auditing the mac
client's per-job fidelity — full context in `docs/superpowers/plans/2026-08-24-easy-apply-mac-client-and-cv-base.md`.
Three more independent gaps came out of that same audit (adapter coverage,
Telegram notifications on apply, and cost/token tracking for the LLM calls
that make these artifacts) — each is its own sub-project with its own spec;
this document covers only the cover-letter sync.

## Design

### 1. `mac_client/sync.py` — fetch it the same way the CV already is

Add `cover_letter_s3_key` to `QUEUE_SQL`'s `SELECT` list and to `QueueJob`
(`cover_letter_s3_key: str | None = None`, mapped in `QueueJob.from_row`
exactly like `tailored_cv_s3_key` is today).

The current fetch loop inside `save_queue()` is inline, untested, and only
handles the PDF case:

```python
for job in jobs:
    if job.tailored_cv_s3_key:
        job_dir = path.parent / job.id
        job_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = job_dir / "tailored_cv.pdf"
        if not pdf_path.exists():
            try:
                cmd = ["ssh", SSH_HOST, f'aws s3 cp "s3://$STORAGE_BUCKET/{job.tailored_cv_s3_key}" -']
                proc = subprocess.run(cmd, capture_output=True, timeout=30, check=False)
                if proc.returncode == 0 and len(proc.stdout) > 100:
                    pdf_path.write_bytes(proc.stdout)
            except Exception:
                pass
```

Adding a second near-identical block for the `.txt` letter would duplicate
it, so this becomes a shared helper instead:

```python
def _fetch_s3_artifact(s3_key: str, dest_path: Path, min_bytes: int) -> bool:
    """One best-effort S3 pull over the existing SSH host. False on any
    failure — a missing artifact must never stop the rest of the queue from
    syncing, the same reasoning save_queue() already applies to the CV.
    """
    if dest_path.exists():
        return True
    try:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = ["ssh", SSH_HOST, f'aws s3 cp "s3://$STORAGE_BUCKET/{s3_key}" -']
        proc = subprocess.run(cmd, capture_output=True, timeout=30, check=False)
        if proc.returncode == 0 and len(proc.stdout) > min_bytes:
            dest_path.write_bytes(proc.stdout)
            return True
    except Exception:
        pass
    return False
```

`save_queue()` calls it twice per job, both sharing one `job_dir = path.parent
/ job.id`:

```python
for job in jobs:
    job_dir = path.parent / job.id
    if job.tailored_cv_s3_key:
        _fetch_s3_artifact(job.tailored_cv_s3_key, job_dir / "tailored_cv.pdf", min_bytes=100)
    if job.cover_letter_s3_key:
        _fetch_s3_artifact(job.cover_letter_s3_key, job_dir / "cover_letter.txt", min_bytes=20)
```

`min_bytes=100` for the PDF is the unchanged existing threshold; `min_bytes=20`
for the letter only exists to reject an empty or error response, not to
validate content — a real letter is easily hundreds of characters. This
closes a pre-existing gap — the CV fetch has zero test coverage today
(confirmed: no `s3`/`tailored_cv` match anywhere in `tests/test_sync.py`) —
as a side effect of not duplicating untested code a second time, not as
separate scope.

### 2. `mac_client/apply.py` — clipboard, not auto-type

Confirmed with the founder (2026-08-25): the letter goes to the clipboard,
not into a detected form field. `adapters.py`'s field maps deliberately never
fill a cover-letter box today — that line doesn't move. This only removes the
"open the file yourself" step; the founder still places it.

```python
def copy_to_clipboard(text: str) -> bool:
    """Best-effort, macOS only (pbcopy) — this client only runs on the
    founder's Mac. Never raises: a clipboard failure must not stop the job
    from opening, only cost the founder one manual copy.
    """
    try:
        subprocess.run(["pbcopy"], input=text.encode(), timeout=5, check=True)
        return True
    except Exception:
        return False
```

Called from `process_job()`, right before the overlay renders: if
`.queue/{job.id}/cover_letter.txt` exists, read it and copy it. The overlay
call already passes a data dict (`position`, `company`, `title`, `filled`,
`skipped`) — add `cover_letter_copied: bool`.

### 3. `mac_client/overlay.js` — say so

One more line in the status bar, same style as the existing `Filled:` /
`Left for you:` lines:

- Copied: `📋 Cover letter copied to clipboard`
- Not available: `No cover letter yet — ask the bot to draft one for
  {company}`

No hard preflight gate (unlike `missing_resumes()` for the CV). A missing
letter isn't a blocker — the founder writes one, exactly like today, just
without knowing in advance which jobs need it. Adding a preflight would be a
second, separate enhancement, not part of wiring the existing pipe.

## What this does not cover

- **Not a generation change.** No new LLM call, no new prompt. The letter is
  already made; this only fetches what already exists.
- **Not the other three audit findings** (Workable/Recruitee adapters,
  Telegram per-apply/session-end notifications, token/cost tracking for
  `tailor_cv`/`buildCoverLetter`) — each gets its own spec, in that order,
  after this one ships.
- **Not a preflight/warning system** for jobs missing a letter — see above.
- **Not cross-platform.** `pbcopy` is macOS-only, matching every other
  assumption this client already makes (LaunchAgent, `.venv`, Mac paths).

## Testing

- `test_sync.py`: `_fetch_s3_artifact` — successful fetch writes the file;
  a short/error response (`returncode != 0`, or `len(stdout) <= min_bytes`)
  is rejected and leaves no file; an already-existing dest_path is left alone
  (no re-fetch). Run once against the CV's existing call shape and once
  against the letter's, since both now share the function.
  `QueueJob.from_row` — `cover_letter_s3_key` round-trips through
  `save_queue`/`load_queue` alongside `tailored_cv_s3_key`.
- New test (co-located with the browser tests, or a small pure-function file
  if `pbcopy` needs mocking without a browser): `copy_to_clipboard` — mocks
  `subprocess.run`, confirms success returns `True`, confirms a raised
  exception returns `False` rather than propagating.
- No live S3/SSH calls in tests — mocked exactly as `test_sync.py` already
  mocks `subprocess.run` for the rest of the module.
