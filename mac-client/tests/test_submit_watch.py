"""The navigation watcher's decisions, without a browser: when it asks, when it waits, when it gives up.

tests/test_hard_navigation.py drives the whole thing in Chromium. This pins the
paths a real browser cannot produce on demand (a page that moves on again in the
middle of the question, a page that stops answering) and the two it must never
take: asking about a navigation she did not cause, and completing the job itself.
"""

from __future__ import annotations

import asyncio

import pytest
from playwright.async_api import Error as PlaywrightError

from mac_client import after_submit
from mac_client.after_submit import ASK, NavigationUnconfirmed, SubmitWatch

LABEL = "Fixture BV — Financial Analyst"


class FakePage:
    """Just enough of a Playwright page for the watcher: events, load state, one evaluate."""

    def __init__(self):
        self.main_frame = object()
        self.listeners: dict[str, list] = {}
        self.load_errors: list[Exception] = []
        self.bar_there = False
        self.loads = 0

    def on(self, event, handler):
        self.listeners.setdefault(event, []).append(handler)

    def remove_listener(self, event, handler):
        if handler in self.listeners.get(event, []):
            self.listeners[event].remove(handler)

    async def wait_for_load_state(self, state, timeout=None):
        self.loads += 1
        if self.load_errors:
            raise self.load_errors.pop(0)

    async def evaluate(self, _js):
        return self.bar_there

    def navigate(self, frame=None):
        for handler in list(self.listeners.get("framenavigated", [])):
            handler(frame if frame is not None else self.main_frame)


class Harness:
    def __init__(self, show=None):
        self.page = FakePage()
        self.decided: asyncio.Future = asyncio.get_running_loop().create_future()
        self.shown: list[dict] = []
        self.watch = SubmitWatch(self.page, LABEL, self.decided, show or self._show)
        self.watch.start()

    async def _show(self, extra):
        self.shown.append(extra)

    async def settle(self):
        await asyncio.sleep(0.05)


@pytest.fixture
def quick(monkeypatch):
    monkeypatch.setattr(after_submit, "LOAD_TIMEOUT_MS", 150)
    monkeypatch.setattr(after_submit, "_RETRY_PAUSE_S", 0.01)


@pytest.mark.asyncio
async def test_a_navigation_before_she_pressed_submit_is_not_asked_about(quick):
    h = Harness()
    h.page.navigate()
    await h.settle()
    assert h.shown == [] and h.page.loads == 0


@pytest.mark.asyncio
async def test_a_navigation_after_she_pressed_submit_puts_the_question_on_the_new_page(quick):
    h = Harness()
    h.watch.submit_attempted()
    h.page.navigate()
    await h.settle()
    assert h.shown == [{"ask": ASK, "manual": True}]
    assert not h.decided.done()  # the question decides nothing


@pytest.mark.asyncio
async def test_a_sub_frame_navigating_is_not_the_page_changing(quick):
    h = Harness()
    h.watch.submit_attempted()
    h.page.navigate(frame=object())
    await h.settle()
    assert h.shown == []


@pytest.mark.asyncio
async def test_a_bar_that_is_still_on_the_page_is_left_alone(quick):
    h = Harness()
    h.watch.submit_attempted()
    h.page.bar_there = True  # an in-document change: same page, the bar is running its own check
    h.page.navigate()
    await h.settle()
    assert h.shown == []


@pytest.mark.asyncio
async def test_a_job_she_has_already_decided_is_left_alone(quick):
    h = Harness()
    h.watch.submit_attempted()
    h.decided.set_result("skipped")
    h.page.navigate()
    await h.settle()
    assert h.shown == [] and h.page.loads == 0


@pytest.mark.asyncio
async def test_no_does_not_disarm_it_so_a_later_page_change_still_gets_a_bar(quick, capsys):
    h = Harness()
    h.watch.submit_attempted()
    h.watch.answered_no()
    h.page.navigate()
    await h.settle()
    assert h.shown == [{"ask": ASK, "manual": True}]
    out = capsys.readouterr().out
    assert out.count("[NOT RECORDED]") == 1 and "NO" in out and LABEL in out


@pytest.mark.asyncio
async def test_a_page_that_moves_on_again_mid_question_is_asked_again(quick):
    h = Harness()
    h.watch.submit_attempted()
    h.page.load_errors = [PlaywrightError("Execution context was destroyed, most likely because of a navigation")]
    h.page.navigate()
    await h.settle()
    assert h.shown == [{"ask": ASK, "manual": True}]
    assert not h.decided.done()


@pytest.mark.asyncio
async def test_a_page_that_cannot_be_asked_on_is_given_up_with_the_reason(quick, capsys):
    h = Harness()
    h.watch.submit_attempted()
    h.page.load_errors = [PlaywrightError("Target page, context or browser has been closed")] * 3
    h.page.navigate()
    await h.settle()
    await h.settle()
    assert h.shown == []
    with pytest.raises(NavigationUnconfirmed, match="could not be asked on it"):
        h.decided.result()
    lines = [line for line in capsys.readouterr().out.splitlines() if "[NOT RECORDED]" in line]
    assert len(lines) == 1 and "Target page, context or browser has been closed" in lines[0]
    assert "Nothing was recorded" in lines[0]


@pytest.mark.asyncio
async def test_a_page_that_stops_answering_is_given_up_not_waited_for_ever(quick, capsys):
    async def never(_extra):
        await asyncio.Event().wait()  # the question is put, and the page never answers

    h = Harness(show=never)
    h.watch.submit_attempted()
    h.page.navigate()
    await asyncio.sleep(0.4)
    with pytest.raises(NavigationUnconfirmed, match="never finished loading"):
        h.decided.result()
    assert len([ln for ln in capsys.readouterr().out.splitlines() if "[NOT RECORDED]" in ln]) == 1


@pytest.mark.asyncio
async def test_a_newer_page_replaces_the_one_being_asked_on(quick):
    h = Harness()
    h.watch.submit_attempted()
    gate = asyncio.Event()

    async def slow_first(state, timeout=None):
        h.page.loads += 1
        if h.page.loads == 1:
            await gate.wait()  # the first page is still loading when the second one commits

    h.page.wait_for_load_state = slow_first
    h.page.navigate()
    await asyncio.sleep(0.01)
    h.page.navigate()
    gate.set()  # the first page finishes loading after the second has replaced it
    await h.settle()
    assert h.shown == [{"ask": ASK, "manual": True}]  # once: the older attempt was cancelled


@pytest.mark.asyncio
async def test_stop_removes_the_listener_and_cancels_what_is_in_flight(quick):
    h = Harness()
    h.watch.submit_attempted()
    gate = asyncio.Event()

    async def hold(state, timeout=None):
        await gate.wait()

    h.page.wait_for_load_state = hold
    h.page.navigate()
    await asyncio.sleep(0.01)
    h.watch.stop()
    await h.settle()
    assert h.page.listeners["framenavigated"] == []
    assert h.shown == [] and not h.decided.done()
    h.page.navigate()  # a later job's navigation on the same page is not this job's business
    await h.settle()
    assert h.shown == []
