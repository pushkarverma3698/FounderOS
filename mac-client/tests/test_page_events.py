"""`window.founderosEvent` is callable by EVERY script in the employer's page, not only by the overlay.

The name a caller passes picks a handler on this side. The overlay sends exactly two names
(`submit-attempted`, `answered-no`: what the host is TOLD, which only ever leads to a question or a
log line). The handler named `decision` is the one that RECORDS an outcome, and it must be reachable
only through `founderosDecision`, the founder's own press of a button. A page that sends
`founderosEvent("decision")` must get nothing, whatever signature that handler has today or tomorrow.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from mac_client import apply as apply_mod


class OnePage:
    """The router only uses the page as a dictionary key."""


async def _send(kind, handlers: dict) -> None:
    page = OnePage()
    apply_mod._ON_SCREEN[page] = handlers
    try:
        await apply_mod._founderos_event({"page": page}, kind)
    finally:
        apply_mod._ON_SCREEN.pop(page, None)


@pytest.mark.asyncio
async def test_a_page_cannot_reach_the_decision_handler_through_the_event_binding(capsys):
    recorded: list[str] = []

    # The WORST signature the handler could ever get: it records without being told what.
    async def on_decision(_source, outcome="applied"):
        recorded.append(outcome)

    await _send("decision", {"decision": on_decision})

    assert recorded == []
    assert "ignored" in capsys.readouterr().out


@pytest.mark.asyncio
@pytest.mark.parametrize("hostile", ["applied", "skipped", "", "DECISION", ["decision"], {"k": 1}, None, 7])
async def test_nothing_but_the_two_known_names_is_routed(hostile):
    reached: list = []

    async def anything(_source, *args):
        reached.append(args)

    await _send(hostile, {"decision": anything, "submit-attempted": anything, "answered-no": anything})

    assert reached == []


@pytest.mark.asyncio
async def test_a_huge_name_does_not_flood_the_terminal(capsys):
    await _send("x" * 100_000, {})

    assert len(capsys.readouterr().out) < 300


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["submit-attempted", "answered-no"])
async def test_the_two_names_the_overlay_sends_still_reach_the_job_on_screen(kind):
    seen: list[str] = []

    async def handler(_source):
        seen.append(kind)

    await _send(kind, {kind: handler})

    assert seen == [kind]


def test_the_allowed_names_are_exactly_the_ones_the_overlay_sends():
    """Adding an overlay event without allowing it here would silently drop it; allowing a name the
    overlay never sends widens what a page may say."""
    overlay = (Path(apply_mod.__file__).parent / "overlay.js").read_text()
    sent = set(re.findall(r'tellHost\("([^"]+)"\)', overlay))

    assert sent == set(apply_mod._EVENT_KINDS)
    assert "decision" not in apply_mod._EVENT_KINDS
