"""Talking to the VPS, and never mistaking a failure for an empty queue.

THE FAILURE THIS GUARDS AGAINST. The prototype scp'd a SQLite file the real
pipeline never wrote, queried a table that did not exist, caught the exception,
and returned an empty list. It reported "0 jobs" forever and nothing anywhere
said why. Every test here is about keeping those two states distinguishable.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from mac_client import sync
from mac_client.sync import QueueJob, SyncError


class FakeRun:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr


def test_a_failed_ssh_raises_rather_than_returning_an_empty_queue(monkeypatch):
    monkeypatch.setattr(
        subprocess, "run", lambda *a, **k: FakeRun(returncode=255, stderr="Host unreachable")
    )
    with pytest.raises(SyncError) as err:
        sync.fetch_queue()
    assert "Host unreachable" in str(err.value)


def test_a_timeout_is_a_failure_not_a_quiet_empty(monkeypatch):
    def boom(*a, **k):
        raise subprocess.TimeoutExpired(cmd="ssh", timeout=60)

    monkeypatch.setattr(subprocess, "run", boom)
    with pytest.raises(SyncError) as err:
        sync.fetch_queue()
    assert "did not answer" in str(err.value)


def test_empty_output_is_a_failure_because_psql_always_returns_json(monkeypatch):
    # The query is wrapped in coalesce(..., '[]'), so a truly empty queue comes
    # back as "[]". Literally nothing means the statement did not run.
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeRun(stdout="  \n"))
    with pytest.raises(SyncError) as err:
        sync.fetch_queue()
    assert "not an empty queue" in str(err.value)


def test_an_actually_empty_queue_parses_to_no_jobs(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeRun(stdout="[]"))
    assert sync.fetch_queue() == []


def test_rows_parse_in_rank_order_with_their_fields(monkeypatch):
    payload = json.dumps(
        [
            {"id": "a", "company": "Adyen", "title": "SRE", "track": "backend",
             "url": "https://x/1", "brief_rank": 1, "brief_section": "do_today"},
            {"id": "b", "company": "Mollie", "title": "Backend", "track": "backend",
             "url": "https://x/2", "brief_rank": 2, "brief_section": "stretch"},
        ]
    )
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeRun(stdout=payload))
    jobs = sync.fetch_queue()
    assert [j.company for j in jobs] == ["Adyen", "Mollie"]
    assert jobs[0].brief_rank == 1


def test_the_queue_only_asks_for_unhandled_actionable_rows():
    # Both halves matter: `ask` rows have an unresolved gate and their action is
    # a question, not a submission; a handled row must not come back.
    assert "applied_at IS NULL" in sync.QUEUE_SQL
    assert "skipped_at IS NULL" in sync.QUEUE_SQL
    assert "'do_today','stretch','standing'" in sync.QUEUE_SQL
    assert "'ask'" not in sync.QUEUE_SQL


def test_push_is_idempotent_by_is_null_guard(monkeypatch):
    # The client retries after a failed push. A retry must not move a timestamp
    # the founder set an hour ago.
    sent: list[str] = []
    monkeypatch.setattr(sync, "run_remote", lambda sql: sent.append(sql) or "1")
    sync.push_outcomes(["11111111-1111-1111-1111-111111111111"], [])
    assert "applied_at IS NULL" in sent[0]


def test_applied_and_skipped_write_different_columns(monkeypatch):
    sent: list[str] = []
    monkeypatch.setattr(sync, "run_remote", lambda sql: sent.append(sql) or "1")
    sync.push_outcomes(
        ["11111111-1111-1111-1111-111111111111"],
        ["22222222-2222-2222-2222-222222222222"],
    )
    assert any("applied_at = now()" in s for s in sent)
    assert any("skipped_at = now()" in s for s in sent)
    # A skip must never touch applied_at: that column drives the re-apply
    # staleness rule, and stamping it would suppress a role he'd take later.
    skip_sql = next(s for s in sent if "skipped_at = now()" in s)
    assert "applied_at = now()" not in skip_sql


def test_pushing_nothing_does_no_work(monkeypatch):
    monkeypatch.setattr(sync, "run_remote", lambda sql: pytest.fail("should not run"))
    assert sync.push_outcomes([], []) == 0


def test_a_non_uuid_row_id_is_refused_before_it_reaches_sql(monkeypatch):
    # These ids come from our own query, so this is the defence that still holds
    # if that stops being true — psql takes the statement as a shell argument.
    monkeypatch.setattr(sync, "run_remote", lambda sql: pytest.fail("should not run"))
    with pytest.raises(SyncError):
        sync.push_outcomes(["'; DROP TABLE agents.job_applications; --"], [])


def test_load_queue_on_a_missing_file_says_not_synced(tmp_path):
    with pytest.raises(SyncError) as err:
        sync.load_queue(tmp_path / "queue.json")
    assert "run the sync" in str(err.value)


def test_save_then_load_round_trips(tmp_path):
    path = tmp_path / "queue.json"
    jobs = [QueueJob(id="a", company="Adyen", title="SRE", track="backend",
                     url="https://x/1", brief_rank=1)]
    sync.save_queue(jobs, path)
    assert sync.load_queue(path)[0].company == "Adyen"


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


def test_fetch_s3_artifact_sources_the_env_file_before_calling_aws(tmp_path, monkeypatch):
    # Found live, 2026-08-25: this fetch failed on every call, on any machine,
    # because a bare SSH shell has neither the aws CLI's credentials nor
    # $STORAGE_BUCKET — both only ever reach the Node process via systemd's
    # EnvironmentFile=. Silent-failure-by-design (this function's whole
    # contract) hid a fetch that had never once worked, for the CV as much as
    # the cover letter. This test pins the fix so it can't regress unnoticed
    # the same way.
    captured_cmd = []
    monkeypatch.setattr(
        subprocess, "run",
        lambda cmd, **k: captured_cmd.append(cmd) or FakeRun(stdout=b"x" * 50),
    )
    sync._fetch_s3_artifact("some/key.txt", tmp_path / "out.txt", min_bytes=20)
    ssh_payload = captured_cmd[0][-1]
    # Assert the exact command rather than loose substrings: a plausible-looking
    # "simplification" that drops `set -a` still sources the file and still puts
    # `source` before `aws s3 cp`, so those checks alone would pass while silently
    # reintroducing the credentials half of the original bug — $STORAGE_BUCKET
    # resolves via plain shell substitution either way, but AWS_ACCESS_KEY_ID does
    # not reach a child process without `set -a` actually exporting it first.
    assert ssh_payload == (
        f'set -a; source {sync.REMOTE_ENV_FILE}; set +a; '
        f'aws s3 cp "s3://$STORAGE_BUCKET/some/key.txt" -'
    )


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


def test_save_queue_reports_a_failed_tailored_cv_fetch_instead_of_swallowing_it(tmp_path, monkeypatch):
    # T1a. Before this fix save_queue() called _fetch_s3_artifact and threw the
    # bool away — a fetch that failed looked identical to one that succeeded.
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: FakeRun(returncode=1, stderr=b"NoSuchKey: The specified key does not exist."),
    )
    jobs = [
        QueueJob(id="a", company="Ockto", title="SRE", track="backend",
                 url="https://x/1", brief_rank=1, tailored_cv_s3_key="tailored/ockto.pdf")
    ]
    failures = sync.save_queue(jobs, tmp_path / "queue.json")
    assert len(failures) == 1
    company, reason = failures[0]
    assert company == "Ockto"
    assert "tailored CV" in reason
    assert "NoSuchKey" in reason


def test_save_queue_reports_nothing_when_every_fetch_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeRun(stdout=b"x" * 150))
    jobs = [
        QueueJob(id="a", company="Ockto", title="SRE", track="backend",
                 url="https://x/1", brief_rank=1, tailored_cv_s3_key="tailored/ockto.pdf")
    ]
    assert sync.save_queue(jobs, tmp_path / "queue.json") == []


def test_save_queue_reports_nothing_for_a_job_with_no_s3_keys_at_all(tmp_path, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("should not run"))
    jobs = [
        QueueJob(id="a", company="Ockto", title="SRE", track="backend", url="https://x/1", brief_rank=1)
    ]
    assert sync.save_queue(jobs, tmp_path / "queue.json") == []


def test_fetch_s3_artifact_verbose_carries_stderr_when_bool_helper_would_lose_it(tmp_path, monkeypatch):
    monkeypatch.setattr(
        subprocess, "run", lambda *a, **k: FakeRun(returncode=1, stderr=b"Access Denied")
    )
    ok, reason = sync._fetch_s3_artifact_verbose("k", tmp_path / "out.pdf", min_bytes=10)
    assert ok is False
    assert reason == "Access Denied"
    # The bool-only wrapper other callers still use must keep working unchanged.
    assert sync._fetch_s3_artifact("k", tmp_path / "out2.pdf", min_bytes=10) is False


def test_from_row_maps_the_cover_letter_key():
    row = {"id": "a", "company": "Adyen", "title": "SRE", "track": "backend",
           "url": "https://x/1", "brief_rank": 1,
           "cover_letter_s3_key": "ready-applications/x/cover_letter.txt"}
    job = QueueJob.from_row(row)
    assert job.cover_letter_s3_key == "ready-applications/x/cover_letter.txt"
