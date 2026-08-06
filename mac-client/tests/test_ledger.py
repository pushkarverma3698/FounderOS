"""The crash-safe record of what the founder actually did.

THE FAILURE THIS GUARDS AGAINST. Holding outcomes in memory until session end
means a crash at job nineteen of twenty loses all nineteen. The founder then
sees them back in tomorrow's queue and either applies twice or, having noticed,
stops trusting the queue — which costs more than the nineteen applications.
"""

from __future__ import annotations

import json

import pytest

from mac_client import ledger


def test_an_outcome_is_on_disk_before_the_call_returns(tmp_path):
    path = tmp_path / "outcomes.jsonl"
    ledger.record("id-1", ledger.APPLIED, company="Adyen", title="SRE", path=path)
    # Read with a fresh handle: a buffered write still in memory when the
    # process dies is indistinguishable from a click that never happened.
    assert json.loads(path.read_text().strip())["job_id"] == "id-1"


def test_an_unknown_outcome_is_refused(tmp_path):
    with pytest.raises(ValueError):
        ledger.record("id-1", "maybe", path=tmp_path / "o.jsonl")


def test_a_corrupt_line_does_not_strand_the_valid_ones(tmp_path):
    # A half-written record is exactly the shape a crash mid-append leaves.
    path = tmp_path / "outcomes.jsonl"
    ledger.record("id-1", ledger.APPLIED, path=path)
    with path.open("a") as handle:
        handle.write('{"job_id": "id-2", "outcome": "appl\n')
    ledger.record("id-3", ledger.SKIPPED, path=path)

    entries = ledger.pending(path)
    assert [e.job_id for e in entries] == ["id-1", "id-3"]


def test_pending_on_a_missing_file_is_empty_not_an_error(tmp_path):
    assert ledger.pending(tmp_path / "never.jsonl") == []


def test_split_pending_separates_applied_from_skipped(tmp_path):
    # The whole reason applied_at and skipped_at are separate columns: merged,
    # the apply rate loses its denominator.
    path = tmp_path / "outcomes.jsonl"
    ledger.record("a", ledger.APPLIED, path=path)
    ledger.record("s", ledger.SKIPPED, path=path)
    ledger.record("a2", ledger.APPLIED, path=path)

    applied, skipped = ledger.split_pending(ledger.pending(path))
    assert applied == ["a", "a2"]
    assert skipped == ["s"]


def test_clear_removes_the_file(tmp_path):
    path = tmp_path / "outcomes.jsonl"
    ledger.record("a", ledger.APPLIED, path=path)
    ledger.clear(path)
    assert not path.exists()


def test_clear_on_a_missing_file_is_harmless(tmp_path):
    ledger.clear(tmp_path / "never.jsonl")
