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
    assert "'do_today','stretch'" in sync.QUEUE_SQL
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
