"""The profile the browser session fills from must be the one the founder edits.

Founder's call, 2026-08-24: the apply profile lives on the VPS
(``/opt/founderos-data/apply-profile.json``) and is edited through Telegram, so
this client pulls it rather than keeping a second hand-maintained copy. Two
copies drift, and the direction they drift in is "the form was filled with an
address he changed three weeks ago".

The property that matters more than the pull working is what happens when it
does NOT: a partial or unparseable read must leave the good local file alone.
Overwriting it would turn a network blip into ``load_profile`` rejecting a file
the founder never touched.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from mac_client import sync


VALID = json.dumps(
    {
        "first_name": "Pushkar",
        "last_name": "Verma",
        "email": "pushkar3698@gmail.com",
        "phone": "+91 97792 60517",
        "default_resume": "/tmp/cv.pdf",
    }
)


class _Done:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _stub_run(monkeypatch, result):
    def fake(*_args, **_kwargs):
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(subprocess, "run", fake)


def test_writes_the_remote_profile_when_it_parses(monkeypatch, tmp_path):
    _stub_run(monkeypatch, _Done(0, VALID))
    target = tmp_path / "apply-profile.json"

    assert sync.sync_profile(target) is True
    assert json.loads(target.read_text())["email"] == "pushkar3698@gmail.com"


def test_written_profile_is_not_world_readable(monkeypatch, tmp_path):
    # It carries a real name, email and phone number.
    _stub_run(monkeypatch, _Done(0, VALID))
    target = tmp_path / "apply-profile.json"

    sync.sync_profile(target)
    assert target.stat().st_mode & 0o077 == 0


def test_reports_no_change_when_the_remote_matches(monkeypatch, tmp_path):
    _stub_run(monkeypatch, _Done(0, VALID))
    target = tmp_path / "apply-profile.json"
    target.write_text(VALID)

    assert sync.sync_profile(target) is False


@pytest.mark.parametrize(
    "result",
    [
        _Done(1, "", "cat: no such file"),
        _Done(0, ""),
        _Done(0, '{"first_name": "Pushk'),  # truncated read
        subprocess.TimeoutExpired(cmd="ssh", timeout=60),
        FileNotFoundError("ssh"),
    ],
    ids=["remote-missing", "empty", "truncated-json", "timeout", "no-ssh"],
)
def test_a_bad_pull_never_overwrites_a_good_local_profile(monkeypatch, tmp_path, result):
    _stub_run(monkeypatch, result)
    target = tmp_path / "apply-profile.json"
    target.write_text(VALID)

    assert sync.sync_profile(target) is False
    assert target.read_text() == VALID


def test_a_bad_pull_leaves_no_file_behind_when_there_was_none(monkeypatch, tmp_path):
    _stub_run(monkeypatch, _Done(0, "not json at all"))
    target = tmp_path / "apply-profile.json"

    assert sync.sync_profile(target) is False
    assert not target.exists()
