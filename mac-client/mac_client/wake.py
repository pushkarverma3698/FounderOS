"""What runs when the Mac wakes up: sync the queue, then say what is in it.

This is the whole "open the laptop and it's ready" promise. It does NOT open a
browser — the founder decided (2026-08-06) that a laptop which hijacks the
screen every time it wakes is worse than one command. So: sync, message, stop.

The prototype had no trigger at all. Its wake notifier queried a table that did
not exist, swallowed the error, and reported zero jobs forever — and nothing
ever called it, because the LaunchAgent was never written.
"""

from __future__ import annotations

from . import notify
from .profile import DEFAULT_PROFILE_ID, ProfileError, load_profile
from .sync import SyncError, fetch_queue, save_queue, sync_profile


def _current_profile_id() -> str:
    """Which candidate this install serves — read BEFORE syncing.

    The VPS keeps one profile file per candidate (see _remote_profile_path in
    sync.py); syncing before knowing which one would pull the DEFAULT profile
    onto an install that has already been set up for someone else. A brand new
    install with no local file yet has nothing to read its identity from, so
    it defaults the same way load_profile itself does.
    """
    try:
        return load_profile().profile_id
    except ProfileError:
        return DEFAULT_PROFILE_ID


def main() -> int:
    # BEFORE the queue, and never fatal. The VPS holds the profile the founder
    # edits with `/profile`, and a browser session that fills forms from a
    # laptop copy he changed three weeks ago is worse than one that fills from
    # today's. If the pull fails the local copy stands and `load_profile` still
    # names anything missing, so the failure direction is loud.
    profile_id = _current_profile_id()
    try:
        if sync_profile(profile_id=profile_id):
            print("✓ apply profile updated from the VPS")
    except OSError as err:
        print(f"⚠ could not refresh the apply profile ({err}) — using the local copy")

    try:
        # WHOSE queue. Read from the same apply-profile.json that supplies the
        # form fields and the resume, so the rows fetched and the CV uploaded to
        # them can never come from two different candidates.
        jobs = fetch_queue(load_profile().profile_id)
        fetch_failures = save_queue(jobs)
    except SyncError as err:
        # Reported, never swallowed. A sync that failed and a queue that is
        # empty produce the same silence, and only one of them is fine.
        print(f"✗ sync failed: {err}")
        try:
            notify.send(notify.sync_failed_message(str(err)))
        except notify.NotifyError as notify_err:
            print(f"✗ could not report the failure either: {notify_err}")
        return 1

    if fetch_failures:
        # T1a: printed here too — the terminal is what's open right now, and
        # Telegram is what's open later. Both must say it, neither is enough alone.
        print(f"⚠ {len(fetch_failures)} artifact fetch(es) failed:")
        for company, reason in fetch_failures:
            print(f"    {company}: {reason}")

    top = [f"{j.company} — {j.title}" for j in jobs]
    try:
        notify.send(notify.queue_ready_message(len(jobs), top, fetch_failures))
    except notify.NotifyError as err:
        print(f"⚠ queue synced ({len(jobs)} jobs) but Telegram failed: {err}")
        return 1

    print(f"✓ {len(jobs)} job(s) synced and announced")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
