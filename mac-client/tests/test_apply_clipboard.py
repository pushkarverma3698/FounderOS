"""copy_to_clipboard — pure function, no browser needed.

Same reasoning as test_ashby_application_url.py: test_apply_browser.py sets
a module-level asyncio pytestmark that pytest-asyncio incorrectly tries to
apply to plain sync functions in that file too, so this pure helper from
apply.py gets its own module.
"""

from __future__ import annotations

import subprocess

from mac_client.apply import copy_to_clipboard


def test_copy_to_clipboard_returns_true_on_success(monkeypatch):
    calls = []
    monkeypatch.setattr(
        subprocess, "run", lambda *a, **k: calls.append((a, k)) or None
    )
    assert copy_to_clipboard("Dear hiring team,") is True
    args, kwargs = calls[0]
    assert args[0] == ["pbcopy"]
    assert kwargs["input"] == b"Dear hiring team,"
    assert kwargs["timeout"] == 5
    assert kwargs["check"] is True


def test_copy_to_clipboard_returns_false_rather_than_raising(monkeypatch):
    def boom(*a, **k):
        raise subprocess.CalledProcessError(1, ["pbcopy"])

    monkeypatch.setattr(subprocess, "run", boom)
    assert copy_to_clipboard("anything") is False
