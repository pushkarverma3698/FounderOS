"""One Telegram message. No bot, no polling, no conflict.

THE PROTOTYPE RAN A SECOND BOT on the production token and long-polled from the
laptop. Telegram allows exactly one long-poll consumer per token, so the Mac and
the VPS bot fought over every update: whichever asked first got the message, and
the other silently lost it. This sends with a single HTTP POST and holds no
connection, so the production bot never notices it exists.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

TELEGRAM_API = "https://api.telegram.org"
SEND_TIMEOUT_S = 15


class NotifyError(RuntimeError):
    """Telegram refused the message, or no credentials were configured."""


def send(text: str) -> None:
    """Post one message to the founder's chat."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        raise NotifyError("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set")

    payload = json.dumps(
        {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    ).encode()
    request = urllib.request.Request(
        f"{TELEGRAM_API}/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=SEND_TIMEOUT_S) as response:
            if response.status != 200:
                raise NotifyError(f"Telegram returned {response.status}")
    except urllib.error.URLError as err:
        raise NotifyError(f"could not reach Telegram: {err}") from err


def queue_ready_message(count: int, top: list[str], fetch_failures: list[tuple[str, str]] = ()) -> str:
    """What the founder reads when he opens the laptop.

    Names the first few roles rather than only counting them. "12 jobs ready" is
    a number he can defer; "12 ready — Adyen, Booking, Mollie" is a reason to
    start now, which is the entire point of sending anything at all.

    T1a: `fetch_failures` (company, reason) surfaces here rather than only in
    the terminal — the terminal is not open when the founder reads this on his
    phone, and a fetch that failed silently is exactly the bug this line exists
    to end.
    """
    if count == 0:
        # Deliberately still a message. Silence after a wake is ambiguous — it
        # reads the same whether the queue is empty or the sync never ran.
        return "☑️ <b>Job queue is empty</b> — nothing new to apply to right now."

    named = "\n".join(f"• {row}" for row in top[:3])
    more = f"\n<i>+ {count - 3} more</i>" if count > 3 else ""
    failure_lines = "\n".join(f"• {company}: {reason}" for company, reason in fetch_failures)
    failure_block = (
        f"\n\n⚠️ <b>{len(fetch_failures)} artifact fetch(es) failed</b>\n{failure_lines}"
        if fetch_failures
        else ""
    )
    return (
        f"🎯 <b>{count} job{'s' if count != 1 else ''} ready to apply</b>\n"
        f"{named}{more}{failure_block}\n\n"
        "<code>cd ~/Projects/founderos/mac-client && .venv/bin/python -m mac_client.apply</code>"
    )


def session_summary_message(applied: int, skipped: int, errored: int = 0) -> str:
    """What the founder's main channel hears after an apply session.

    Before this (concern #2, 2026-08-25), the only place this ever appeared was
    the terminal `apply.py` was run from — Telegram, his main channel, never
    heard a single application or skip until the next brief or `/jobs`.
    """
    parts = [f"{applied} applied", f"{skipped} skipped"]
    if errored:
        parts.append(f"{errored} errored")
    return f"📨 <b>Apply session done</b> — {', '.join(parts)}."


def sync_failed_message(reason: str) -> str:
    """A failed sync must never look like an empty queue."""
    return (
        "⚠️ <b>Job queue sync failed</b>\n"
        f"{reason}\n\n"
        "This is NOT 'no jobs' — the queue could not be read at all."
    )
