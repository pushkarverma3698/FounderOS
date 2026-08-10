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
from .sync import SyncError, fetch_queue, save_queue


def main() -> int:
    try:
        jobs = fetch_queue()
        save_queue(jobs)
    except SyncError as err:
        # Reported, never swallowed. A sync that failed and a queue that is
        # empty produce the same silence, and only one of them is fine.
        print(f"✗ sync failed: {err}")
        try:
            notify.send(notify.sync_failed_message(str(err)))
        except notify.NotifyError as notify_err:
            print(f"✗ could not report the failure either: {notify_err}")
        return 1

    top = [f"{j.company} — {j.title}" for j in jobs]
    try:
        notify.send(notify.queue_ready_message(len(jobs), top))
    except notify.NotifyError as err:
        print(f"⚠ queue synced ({len(jobs)} jobs) but Telegram failed: {err}")
        return 1

    print(f"✓ {len(jobs)} job(s) synced and announced")

    if jobs:
        # Automatically launch interactive browser session when jobs are ready
        import subprocess
        from pathlib import Path
        command_file = Path(__file__).resolve().parent.parent / "run-apply.command"
        if command_file.is_file():
            subprocess.run(["open", "-a", "Terminal", str(command_file)], check=False)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
