"""wake.py must know WHOSE profile to sync before it syncs it.

Found live, 2026-09-04: `main()` called `sync_profile()` with no argument,
before reading the local file's own `profile_id` — meaning an install already
set up for a second candidate would pull the DEFAULT candidate's remote
profile on every wake, silently overwriting the file it just read. The fix
reads the LOCAL profile_id first (falling back the same way `load_profile`
itself does when there is no file yet) and only then syncs.
"""

from __future__ import annotations

from mac_client import wake
from mac_client.profile import ApplyProfile, ProfileError


def test_reads_the_local_profile_id_before_syncing(monkeypatch):
    tashi = ApplyProfile(
        first_name="Tashi",
        last_name="Goyal",
        email="goyaltashi7@gmail.com",
        phone="+31 6 16527081",
        resumes={},
        default_resume="/tmp/cv.pdf",
        profile_id="wife-nl-finance",
    )
    monkeypatch.setattr(wake, "load_profile", lambda: tashi)

    assert wake._current_profile_id() == "wife-nl-finance"


def test_defaults_to_pushkar_when_no_local_file_exists_yet(monkeypatch):
    def raises():
        raise ProfileError("no profile at ... yet")

    monkeypatch.setattr(wake, "load_profile", raises)

    assert wake._current_profile_id() == "pushkar-nl-tech"


def test_defaults_to_pushkar_when_the_local_file_is_unparseable(monkeypatch):
    def raises():
        raise ProfileError("not valid JSON")

    monkeypatch.setattr(wake, "load_profile", raises)

    assert wake._current_profile_id() == "pushkar-nl-tech"
