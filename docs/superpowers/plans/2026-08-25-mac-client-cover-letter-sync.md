# Mac Client Cover-Letter Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mac client already downloads the VPS-tailored resume for each queued job; make it do the same for the cover letter the VPS already writes and archives to S3, and put that letter on the clipboard the moment the job opens.

**Architecture:** Extend `mac_client/sync.py`'s existing per-job S3 fetch loop (today CV-only) with a shared helper so it also pulls `cover_letter.txt`; call `pbcopy` on that file from `mac_client/apply.py` right before the overlay renders; add one status line to `mac_client/overlay.js` so the founder can see whether a letter was found. No new services, no new dependencies, no LLM calls — everything the VPS already generates and archives just needs to be asked for.

**Tech Stack:** Python 3 (mac_client package), pytest + pytest-asyncio + Playwright (existing test infra), macOS `pbcopy` via `subprocess`.

**Spec:** `docs/superpowers/specs/2026-08-25-mac-client-cover-letter-sync-design.md` (founder-approved 2026-08-25).

---

## Before you start (read this once, applies to every task)

**Where the code actually lives.** `mac-client/` is a real subdirectory of the main FounderOS git repo (`git rev-parse --show-toplevel` from inside it returns the repo root) — it is not a separate project. Work in this worktree's own copy at `mac-client/` (relative to the worktree root). Verified 2026-08-25: this worktree's `mac-client/mac_client/apply.py` is blob-identical to `main`'s copy, so it already has the 2026-08-25 Ashby `/application`-route fix — you're starting from a clean, current base. You do not need to touch the separate main checkout at `~/Projects/founderos` for this plan; ignore it.

**Environment setup (one-time, do this before Task 1's first test run):**

```bash
cd mac-client
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/playwright install chromium
```

This worktree has no `.venv` yet (confirmed 2026-08-25) — the venv is gitignored and per-checkout, so it must be created here even though the main checkout already has one. Run all commands in this plan via `.venv/bin/pytest`, `.venv/bin/python`, etc. — do not rely on a global `pytest` (confirmed not on PATH).

**Running the full suite** (do this at the end of every task, not just the file you touched):

```bash
cd mac-client && .venv/bin/pytest -v
```

**Git.** Commit only the files each task names. Never `git add -A` or `git add .` — this repo's convention (and this session's own incident history) is to stage explicit paths only.

---

### Task 1: `mac_client/sync.py` — fetch the cover letter the same way the CV already is

**Files:**
- Modify: `mac-client/mac_client/sync.py`
- Test: `mac-client/tests/test_sync.py`

**Context:** `QUEUE_SQL` (sync.py:35-47) already selects `tailored_cv_s3_key` but not `cover_letter_s3_key`, even though both columns exist on the same `job_applications` row and are populated the same way by the VPS. `QueueJob` (sync.py:54-74) has `tailored_cv_s3_key: str | None = None` and needs a matching `cover_letter_s3_key` field. `save_queue()`'s fetch loop (sync.py:116-129) is inline, CV-only, and has zero existing test coverage — you're adding real coverage for the CV path as a side effect of not duplicating its logic untested a second time.

- [ ] **Step 1: Write the failing tests for `_fetch_s3_artifact` (the helper you're about to extract)**

Add to `mac-client/tests/test_sync.py` (after the existing imports, anywhere below the `FakeRun` class):

```python
def test_fetch_s3_artifact_writes_the_file_on_success(tmp_path, monkeypatch):
    monkeypatch.setattr(
        subprocess, "run", lambda *a, **k: FakeRun(stdout=b"PDF-BYTES-LONGER-THAN-MIN-BYTES")
    )
    dest = tmp_path / "sub" / "tailored_cv.pdf"
    ok = sync._fetch_s3_artifact("some/key.pdf", dest, min_bytes=10)
    assert ok is True
    assert dest.read_bytes() == b"PDF-BYTES-LONGER-THAN-MIN-BYTES"


def test_fetch_s3_artifact_rejects_a_short_or_failed_response(tmp_path, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeRun(returncode=1, stdout=b""))
    dest = tmp_path / "tailored_cv.pdf"
    ok = sync._fetch_s3_artifact("some/key.pdf", dest, min_bytes=10)
    assert ok is False
    assert not dest.exists()


def test_fetch_s3_artifact_skips_an_already_cached_file(tmp_path, monkeypatch):
    dest = tmp_path / "tailored_cv.pdf"
    dest.write_bytes(b"already here")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("should not run"))
    ok = sync._fetch_s3_artifact("some/key.pdf", dest, min_bytes=10)
    assert ok is True


def test_fetch_s3_artifact_creates_the_parent_directory(tmp_path, monkeypatch):
    # Regression guard: the first draft of this helper dropped the mkdir the
    # inline code it replaced already had, which would fail write_bytes for
    # any job whose directory wasn't already created by an earlier fetch.
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeRun(stdout=b"x" * 50))
    dest = tmp_path / "brand-new-job-dir" / "cover_letter.txt"
    assert not dest.parent.exists()
    ok = sync._fetch_s3_artifact("some/key.txt", dest, min_bytes=20)
    assert ok is True
    assert dest.read_bytes() == b"x" * 50


def test_fetch_s3_artifact_against_the_cvs_real_call_shape(tmp_path, monkeypatch):
    # save_queue() calls this with min_bytes=100 for the CV specifically —
    # exercise that exact threshold, not just the letter's smaller one.
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeRun(stdout=b"%PDF-1.4" + b"x" * 100))
    dest = tmp_path / "tailored_cv.pdf"
    assert sync._fetch_s3_artifact("cv/key.pdf", dest, min_bytes=100) is True
    # A response only just over the letter's threshold (20) must still be
    # rejected at the CV's real threshold (100) — proves min_bytes is honoured
    # per call, not hardcoded inside the helper.
    dest2 = tmp_path / "too_short.pdf"
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeRun(stdout=b"x" * 50))
    assert sync._fetch_s3_artifact("cv/key2.pdf", dest2, min_bytes=100) is False
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd mac-client && .venv/bin/pytest tests/test_sync.py -v -k fetch_s3_artifact`
Expected: FAIL — `AttributeError: module 'mac_client.sync' has no attribute '_fetch_s3_artifact'`

- [ ] **Step 3: Write the failing test for `cover_letter_s3_key` round-tripping through `QueueJob`**

Add to `mac-client/tests/test_sync.py`:

```python
def test_queue_job_round_trips_the_cover_letter_key(tmp_path, monkeypatch):
    # save_queue() now also attempts a real S3 fetch for any job carrying
    # either key — mock subprocess so this stays a $0, offline test like
    # every other test in this file that touches subprocess.
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeRun(returncode=1))
    path = tmp_path / "queue.json"
    jobs = [
        QueueJob(
            id="a", company="Adyen", title="SRE", track="backend",
            url="https://x/1", brief_rank=1,
            tailored_cv_s3_key="ready-applications/x/cv.pdf",
            cover_letter_s3_key="ready-applications/x/cover_letter.txt",
        )
    ]
    sync.save_queue(jobs, path)
    loaded = sync.load_queue(path)
    assert loaded[0].cover_letter_s3_key == "ready-applications/x/cover_letter.txt"


def test_from_row_maps_the_cover_letter_key():
    row = {"id": "a", "company": "Adyen", "title": "SRE", "track": "backend",
           "url": "https://x/1", "brief_rank": 1,
           "cover_letter_s3_key": "ready-applications/x/cover_letter.txt"}
    job = QueueJob.from_row(row)
    assert job.cover_letter_s3_key == "ready-applications/x/cover_letter.txt"
```

- [ ] **Step 4: Run the tests, verify they fail**

Run: `cd mac-client && .venv/bin/pytest tests/test_sync.py -v -k "cover_letter_key or maps_the_cover_letter"`
Expected: FAIL — `TypeError: QueueJob.__init__() got an unexpected keyword argument 'cover_letter_s3_key'`

- [ ] **Step 5: Add `cover_letter_s3_key` to `QUEUE_SQL` and `QueueJob`**

In `mac-client/mac_client/sync.py`, change the `QUEUE_SQL` SELECT list (line 38):

```python
  SELECT id, company, title, track, url, brief_rank, brief_section, tailored_cv_s3_key, cover_letter_s3_key
```

Change the `QueueJob` dataclass (lines 54-74):

```python
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
```

- [ ] **Step 6: Extract `_fetch_s3_artifact` and wire it into `save_queue()`**

Replace the inline fetch loop in `save_queue()` (lines 111-129) with:

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


def save_queue(jobs: list[QueueJob], path: Path = QUEUE_PATH) -> None:
    """Cache the queue so the browser session does not need the network."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([j.__dict__ for j in jobs], indent=2))

    for job in jobs:
        job_dir = path.parent / job.id
        if job.tailored_cv_s3_key:
            _fetch_s3_artifact(job.tailored_cv_s3_key, job_dir / "tailored_cv.pdf", min_bytes=100)
        if job.cover_letter_s3_key:
            _fetch_s3_artifact(job.cover_letter_s3_key, job_dir / "cover_letter.txt", min_bytes=20)
```

`min_bytes=100` for the PDF matches the unchanged existing threshold. `min_bytes=20` for the letter only rejects an empty/error response — a real letter is hundreds of characters.

- [ ] **Step 7: Run the full test file, verify everything passes**

Run: `cd mac-client && .venv/bin/pytest tests/test_sync.py -v`
Expected: PASS — all tests including the 8 pre-existing ones (unaffected — `test_save_then_load_round_trips` at line 125 constructs a `QueueJob` without either S3 key, so both new fields default to `None` and the `if job.x_s3_key:` guards skip the fetch entirely, exactly like today)

- [ ] **Step 8: Commit**

```bash
cd mac-client && git add mac_client/sync.py tests/test_sync.py
git commit -m "feat(mac-client): sync the cover letter the VPS already archives to S3

Mirrors the existing tailored-CV fetch: cover_letter_s3_key is now in the
queue SELECT and on QueueJob, and the fetch loop is a shared, now-tested
_fetch_s3_artifact helper instead of duplicated inline code."
```

---

### Task 2: `mac_client/apply.py` — copy the letter to the clipboard when the job opens

**Files:**
- Modify: `mac-client/mac_client/apply.py`
- Test: `mac-client/tests/test_apply_clipboard.py` (new)

**Context:** `apply.py`'s current import line (line 26) is `from .sync import QueueJob, SyncError, load_queue, push_outcomes` — `sync.py` already defines `QUEUE_DIR = Path(__file__).resolve().parent.parent / ".queue"` (sync.py:24), so reuse that constant rather than recomputing the path. `process_job()` (apply.py:141-202) calls `fill_form()`, then eventually `page.evaluate(OVERLAY_JS.read_text(), {...})` (apply.py:191-200) with a data dict of `position`, `company`, `title`, `filled`, `skipped`.

This module does not import `subprocess` today — `apply.py` drives everything through Playwright's own API. You're adding the first use of raw `subprocess` in this file, for `pbcopy` specifically (macOS-only, matching every other assumption this client already makes — LaunchAgent, `.venv`, Mac paths).

**Note on why the new test is its own file:** `tests/test_apply_browser.py` sets `pytestmark = pytest.mark.asyncio` at module level, which pytest-asyncio then incorrectly tries to apply to any plain sync function defined in that same file — this is exactly why `test_ashby_application_url.py` (a sync pure-function test for another helper in `apply.py`) already lives in its own file rather than in `test_apply_browser.py`. Follow the same pattern.

- [ ] **Step 1: Write the failing tests for `copy_to_clipboard`**

Create `mac-client/tests/test_apply_clipboard.py`:

```python
"""copy_to_clipboard — pure function, no browser needed.

Same reasoning as test_ashby_application_url.py: test_apply_browser.py sets
a module-level asyncio pytestmark that pytest-asyncio incorrectly tries to
apply to plain sync functions in that file too, so this pure helper from
apply.py gets its own module.
"""

from __future__ import annotations

import subprocess

import pytest

from mac_client.apply import copy_to_clipboard


def test_copy_to_clipboard_returns_true_on_success(monkeypatch):
    calls = []
    monkeypatch.setattr(
        subprocess, "run", lambda *a, **k: calls.append((a, k)) or None
    )
    assert copy_to_clipboard("Dear hiring team,") is True
    args, kwargs = calls[0]
    assert args[0] == ["pbcopy"]
    assert kwargs["input"] == b"Dear hiring team,"


def test_copy_to_clipboard_returns_false_rather_than_raising(monkeypatch):
    def boom(*a, **k):
        raise subprocess.CalledProcessError(1, ["pbcopy"])

    monkeypatch.setattr(subprocess, "run", boom)
    assert copy_to_clipboard("anything") is False
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd mac-client && .venv/bin/pytest tests/test_apply_clipboard.py -v`
Expected: FAIL — `ImportError: cannot import name 'copy_to_clipboard' from 'mac_client.apply'`

- [ ] **Step 3: Add `import subprocess` and implement `copy_to_clipboard`**

In `mac-client/mac_client/apply.py`, add to the imports (near the top, after `import asyncio`):

```python
import subprocess
```

Add the function, placed just before `process_job` (after `_upload_first`, before the `from .liveness import classify_response` line — keep it near the other small synchronous helpers):

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

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd mac-client && .venv/bin/pytest tests/test_apply_clipboard.py -v`
Expected: PASS

- [ ] **Step 5: Wire it into `process_job`**

Change the import line (apply.py:26):

```python
from .sync import QueueJob, SyncError, QUEUE_DIR, load_queue, push_outcomes
```

In `process_job` (apply.py:141-202), right before the `await page.evaluate(OVERLAY_JS.read_text(), {...})` call, add:

```python
    cover_letter_path = QUEUE_DIR / job.id / "cover_letter.txt"
    cover_letter_copied = (
        cover_letter_path.is_file() and copy_to_clipboard(cover_letter_path.read_text())
    )
```

And add the new key to the data dict passed to `page.evaluate`:

```python
    await page.evaluate(
        OVERLAY_JS.read_text(),
        {
            "position": position,
            "company": job.company,
            "title": job.title,
            "filled": filled,
            "skipped": skipped,
            "cover_letter_copied": cover_letter_copied,
        },
    )
```

- [ ] **Step 6: Run the full suite, verify nothing broke**

Run: `cd mac-client && .venv/bin/pytest -v`
Expected: PASS — all tests including `test_apply_browser.py`'s Playwright tests. Those tests call `page.evaluate` with a data dict that has no `cover_letter_copied` key; in `overlay.js` (unchanged until Task 3) that key is never read yet, so this is a no-op for them at this point in the plan.

- [ ] **Step 7: Commit**

```bash
cd mac-client && git add mac_client/apply.py tests/test_apply_clipboard.py
git commit -m "feat(mac-client): copy the cover letter to the clipboard when a job opens

Reads .queue/{job.id}/cover_letter.txt (now populated by sync.py) and pushes
it to the clipboard via pbcopy before the overlay renders. Never blocks the
job from opening — a missing letter or a pbcopy failure just means one
manual copy instead of zero."
```

---

### Task 3: `mac_client/overlay.js` — show whether a letter was found

**Files:**
- Modify: `mac-client/mac_client/overlay.js`

**Context:** The overlay's status block (overlay.js:25-33) builds `summary.innerHTML` from `data.filled` and `data.skipped`. `data.cover_letter_copied` is now always present in the dict passed from `process_job` (Task 2, Step 5) — `True` when a letter was found and copied, `False` when no letter exists yet or the copy failed. `escapeHtml` (overlay.js:223-227) is a function declaration in the same closure, so it's safe to call before its own definition point in the file (function declarations hoist) — the existing code already relies on this.

There is no JS unit-test harness in this repo; `overlay.js` is exercised only by evaluating it inside a real Playwright page (see `tests/test_apply_browser.py`). This task's correctness is verified by running the existing Playwright suite (nothing here should break it) and by the live check in Task 4.

- [ ] **Step 1: Add the status line**

In `mac-client/mac_client/overlay.js`, change lines 27-33 from:

```js
  const filled = data.filled.length ? data.filled.join(", ") : "nothing";
  const skipped = data.skipped.length ? data.skipped.join("; ") : "nothing";
  summary.innerHTML =
    `<div style="font-weight:600;margin-bottom:2px">${data.position} — ` +
    `${escapeHtml(data.company)} · ${escapeHtml(data.title)}</div>` +
    `<div style="opacity:.75;font-size:13px">Filled: ${escapeHtml(filled)}</div>` +
    `<div style="opacity:.75;font-size:13px;color:#FFCC66">Left for you: ${escapeHtml(skipped)}</div>`;
```

to:

```js
  const filled = data.filled.length ? data.filled.join(", ") : "nothing";
  const skipped = data.skipped.length ? data.skipped.join("; ") : "nothing";
  const coverLetterLine = data.cover_letter_copied
    ? `<div style="opacity:.75;font-size:13px;color:#8FD19E">📋 Cover letter copied to clipboard</div>`
    : `<div style="opacity:.75;font-size:13px;color:#FFCC66">No cover letter yet — ask the bot to draft one for ${escapeHtml(data.company)}</div>`;
  summary.innerHTML =
    `<div style="font-weight:600;margin-bottom:2px">${data.position} — ` +
    `${escapeHtml(data.company)} · ${escapeHtml(data.title)}</div>` +
    `<div style="opacity:.75;font-size:13px">Filled: ${escapeHtml(filled)}</div>` +
    `<div style="opacity:.75;font-size:13px;color:#FFCC66">Left for you: ${escapeHtml(skipped)}</div>` +
    coverLetterLine;
```

This is not a hard preflight gate — a missing letter never blocks SUBMIT or SKIP, it's informational only, matching the spec.

- [ ] **Step 2: Run the full suite, verify nothing broke**

Run: `cd mac-client && .venv/bin/pytest -v`
Expected: PASS. In particular, re-check the two tests whose assertions read `#founderos-bar` innerText for specific substrings, to confirm the new line doesn't collide:
- `test_a_form_with_no_submit_button_records_nothing` asserts `"Could not find" in text` — unaffected, that text comes from a later `giveBack()` call.
- `test_an_unmet_required_field_blocks_the_click_entirely` asserts `"work_auth_text" in text or "required" in text.lower()` — the new line's text ("No cover letter yet — ask the bot to draft one for …") contains neither substring.
- `test_a_visible_validation_error_is_not_recorded_as_applied` asserts `"already associated" in text.lower()` — unaffected.

These existing tests call `page.evaluate` via the `drive()` helper with a data dict that has no `cover_letter_copied` key (`tests/test_apply_browser.py:160-164`); in JS, `data.cover_letter_copied` is then `undefined`, which the ternary in Step 1 treats as falsy — it renders the "No cover letter yet" branch and does not throw, since `data.company` is always present. No test file needs to change for this to stay green — confirm this by reading the actual test output, not by re-deriving it here.

- [ ] **Step 3: Commit**

```bash
cd mac-client && git add mac_client/overlay.js
git commit -m "feat(mac-client): show whether a cover letter was found for this job

One more status line, same style as Filled/Left for you: green when a
letter was copied to the clipboard, amber with a next step when there
isn't one yet."
```

---

### Task 4: Live verification against the real VPS

**This task is not TDD — there is no new code to write.** Its job is to produce real evidence that the three commits above actually work end to end, per this project's verification-before-completion standard. Do not report success from reading the code; report only what a command actually printed.

**Files:** none modified. Requires SSH access to `founderos-vps` (confirmed available from this Mac) and a working `.venv` from Task 1.

- [ ] **Step 1: Find a real row with both S3 keys set**

```bash
ssh founderos-vps 'sudo -n docker exec founderos-postgres psql -U founderos -d founderos -t -A -c "SELECT id, company, tailored_cv_s3_key, cover_letter_s3_key FROM agents.job_applications WHERE tenant_id = '\''turicks'\'' AND cover_letter_s3_key IS NOT NULL ORDER BY updated_at DESC LIMIT 3"'
```

- [ ] **Step 2a: If a row was found** — verify the real S3 fetch

Note the `id` and `cover_letter_s3_key` from Step 1's output, then run (from `mac-client/`, using the venv from Task 1):

```bash
cd mac-client && .venv/bin/python -c "
from pathlib import Path
from mac_client.sync import _fetch_s3_artifact
dest = Path('.queue/_verify-test/cover_letter.txt')
ok = _fetch_s3_artifact('<paste-cover_letter_s3_key-here>', dest, min_bytes=20)
print('fetched:', ok)
print(dest.read_text()[:200] if ok else 'NOT FETCHED')
"
```

Expected: `fetched: True` followed by real cover-letter text (not lorem ipsum, not empty). If `fetched: False`, stop and report the exact command output — do not proceed to Step 3 with fabricated content.

- [ ] **Step 2b: If no row has `cover_letter_s3_key` set** — report this plainly

State in your final report: "No row on prod currently has a cover letter archived — the fetch logic is covered by Task 1's mocked tests but not live-verified against real S3 content in this session." Then continue to Step 3 using locally-authored sample text instead of a fetched file, and say so explicitly in the report (do not imply this was fetched from S3 if it wasn't).

- [ ] **Step 3: Verify the clipboard half for real**

```bash
cd mac-client && .venv/bin/python -c "
from mac_client.apply import copy_to_clipboard
ok = copy_to_clipboard('FOUNDEROS-VERIFY-TOKEN: this came from copy_to_clipboard')
print('copy_to_clipboard returned:', ok)
"
pbpaste
```

Expected: `copy_to_clipboard returned: True`, and `pbpaste`'s output is exactly `FOUNDEROS-VERIFY-TOKEN: this came from copy_to_clipboard`. This is the real macOS clipboard — if `pbpaste` doesn't show the token, the function is not doing what the unit test's mock claimed.

- [ ] **Step 4: Clean up the test artifact**

```bash
cd mac-client && rm -rf .queue/_verify-test
```

- [ ] **Step 5: Report the evidence**

In your final report, include the literal terminal output from Steps 1-3 (not a paraphrase). State explicitly which half was verified against real prod data (S3 fetch, if a row existed) and which half used synthetic input (clipboard token). Do not write "everything works" — write what the commands printed.

---

## After all tasks: final review and merge

Once Task 4's report is in hand, dispatch a final code-reviewer subagent across the full diff (`git diff main...HEAD -- mac-client/`), then use `superpowers:finishing-a-development-branch` to open the PR. This branch touches only `mac-client/` — no VPS/TypeScript code changes, so the usual `pnpm gate` CI path is unaffected, but confirm the mac-client-specific CI job (if any) is green before merging.
