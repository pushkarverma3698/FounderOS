"""The one message the founder gets when he opens the laptop.

THE FAILURE THIS GUARDS AGAINST. The prototype ran a SECOND long-polling bot on
the production token; Telegram allows one consumer per token, so the Mac and the
VPS silently stole each other's updates. And its wake message counted rows in a
table that did not exist, so it said "0 jobs" forever. Both failures were
invisible — which is what these tests are really about.
"""

from __future__ import annotations

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


def test_the_message_carries_the_command_to_start():
    # A notification that ends in no action is a log entry.
    assert "mac_client.apply" in notify.queue_ready_message(3, ["A — B"])


def test_a_failed_sync_never_reads_as_an_empty_queue():
    text = notify.sync_failed_message("Host unreachable")
    assert "failed" in text.lower()
    assert "NOT" in text
    assert "Host unreachable" in text
