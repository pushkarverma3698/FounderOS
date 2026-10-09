"""The one message the founder gets when he opens the laptop.

THE FAILURE THIS GUARDS AGAINST. The prototype ran a SECOND long-polling bot on
the production token; Telegram allows one consumer per token, so the Mac and the
VPS silently stole each other's updates. And its wake message counted rows in a
table that did not exist, so it said "0 jobs" forever. Both failures were
invisible — which is what these tests are really about.
"""

from __future__ import annotations

import json

import pytest

from mac_client import notify


def test_missing_credentials_raise_rather_than_no_op(monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    with pytest.raises(notify.NotifyError):
        notify.send("hello")


def test_an_empty_queue_still_sends_a_message():
    # Silence after a wake is ambiguous: it reads the same whether the queue is
    # empty or the sync never ran.
    assert "empty" in notify.queue_ready_message(0, []).lower()


def test_the_message_names_roles_rather_than_only_counting_them():
    # "12 jobs ready" is a number he can defer. "12 ready — Adyen, Booking" is
    # a reason to start now, which is the point of sending anything.
    text = notify.queue_ready_message(5, ["Adyen — SRE", "Booking — Backend", "Mollie — Go", "X — Y"])
    assert "Adyen — SRE" in text
    assert "Booking — Backend" in text
    assert "+ 2 more" in text


def test_singular_and_plural_read_correctly():
    assert "1 job ready" in notify.queue_ready_message(1, ["Adyen — SRE"])
    assert "2 jobs ready" in notify.queue_ready_message(2, ["A — B", "C — D"])


def test_the_message_never_asks_him_to_type_a_laptop_command():
    # Live QA 2026-10-09: the nudge ended in `cd ~/Projects/... && python -m mac_client.apply`, read on a phone, mid
    # conversation. A shell command is not an action he can take from Telegram.
    text = notify.queue_ready_message(3, ["A — B"])
    assert "mac_client" not in text
    assert "cd ~" not in text
    assert "<code>" not in text


def test_the_action_is_a_telegram_button_the_bot_already_handles():
    # `now:jobs` is the /now "Top roles" button (src/gateway/now-command.ts): tapping it opens the compact brief.
    rows = notify.queue_ready_keyboard()["inline_keyboard"]
    assert [b["callback_data"] for row in rows for b in row] == ["now:jobs"]


def test_send_posts_the_buttons_with_the_message(monkeypatch):
    sent = {}

    class _Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(request, timeout):
        sent.update(json.loads(request.data))
        return _Response()

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "1")
    monkeypatch.setattr(notify.urllib.request, "urlopen", fake_urlopen)
    notify.send("hi", reply_markup=notify.queue_ready_keyboard())
    assert sent["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == "now:jobs"
    sent.clear()
    notify.send("plain")
    assert sent["text"] == "plain"
    assert "reply_markup" not in sent


def test_fetch_failures_are_folded_into_the_queue_ready_message():
    # T1a: the terminal is not open when the founder reads this on his phone —
    # a fetch failure has to reach the message he actually sees.
    text = notify.queue_ready_message(5, ["Adyen — SRE"], [("Ockto", "tailored CV — Access Denied")])
    assert "1 artifact fetch" in text
    assert "Ockto" in text
    assert "Access Denied" in text


def test_no_failure_block_when_nothing_failed():
    text = notify.queue_ready_message(5, ["Adyen — SRE"])
    assert "artifact fetch" not in text


def test_session_summary_names_applied_and_skipped():
    # Concern #2, 2026-08-25: before this, Telegram never heard about an apply
    # session at all — only the terminal it was run from did.
    text = notify.session_summary_message(3, 2)
    assert "3 applied" in text
    assert "2 skipped" in text


def test_session_summary_includes_errors_only_when_there_were_any():
    assert "errored" not in notify.session_summary_message(3, 2)
    assert "1 errored" in notify.session_summary_message(3, 2, 1)


def test_a_failed_sync_never_reads_as_an_empty_queue():
    text = notify.sync_failed_message("Host unreachable")
    assert "failed" in text.lower()
    assert "NOT" in text
    assert "Host unreachable" in text
