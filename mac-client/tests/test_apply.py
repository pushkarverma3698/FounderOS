"""Tests for mac_client.apply — browser queue and window close handling."""

import pytest
from mac_client.apply import BrowserClosedError


def test_browser_closed_error_class():
    err = BrowserClosedError("test message")
    assert isinstance(err, RuntimeError)
    assert str(err) == "test message"
