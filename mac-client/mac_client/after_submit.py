"""A submit that navigates away: she is asked, the machine never assumes (ADR-018).

THE HOLE. The decision bar is JavaScript in the page, so it dies with the page. A
form that HARD-NAVIGATES when she presses SUBMIT & NEXT (a plain POST, a 302 to a
thank-you page) sends the application and destroys the bar in the same breath:
nothing calls `founderosDecision`, `process_job` waits for ever, nothing is
written down and the row is offered again tomorrow. Found 2026-09-29; every
fixture used `preventDefault`, which is why no test saw it.

THE FIX IS A QUESTION, NOT A GUESS. Before it presses the employer's button the
overlay tells this watcher that SUBMIT & NEXT was pressed. If the page is then
replaced and she has not decided, the watcher puts the SAME "Did the application
go through?" bar on the new page. Only her YES (the overlay's own
`founderosDecision`) writes anything. This module has no way to write an outcome:
it does not import the outcome store, and tests/test_hard_navigation.py plus the
CI guard in tests/unit/jobhunt/overlay-never-submits.test.ts fail if that changes.

Why not read the new page for a success sign? The three signs the overlay trusts
in-page do not survive the move: the address always differs after a navigation,
the old button is always gone, and "Thank you" has no earlier page to be compared
with. Treating any of them as success would store "applied" for an error page,
and a wrong "applied" drops the role from every future queue. One click from her
is the price.

What is NOT asked about: a navigation before she pressed SUBMIT & NEXT (a link, a
second step, a redirect), and an in-document change (a hash or history route),
where the bar is still on the page and is running its own check.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeout

#: How long the page a submit navigated to may take to load before she cannot be
#: asked on it. Read when used, so a test can shorten it.
LOAD_TIMEOUT_MS = 30_000

#: Shown above the question on the new page; mirrors the overlay's own wording.
ASK = "The page changed after you pressed SUBMIT & NEXT, so I cannot tell whether it was sent."

_BAR_IS_THERE = "() => !!document.getElementById('founderos-bar')"

#: Tries to put the question on a page that keeps changing under it, and the
#: pause between them. Read when used, so a test can shorten the pause.
_ATTEMPTS = 3
_RETRY_PAUSE_S = 0.25


class NavigationUnconfirmed(RuntimeError):
    """The page changed after SUBMIT & NEXT and she could not be asked. Nothing was recorded."""


class SubmitWatch:
    """Watches one job's page for a navigation that follows her SUBMIT & NEXT.

    `show(extra)` puts the overlay on whatever page is current, with `extra` merged
    into the data the first overlay got. `decided` is the job's own future: this
    watcher only ever fails it (when the question cannot be put), never completes it.
    """

    def __init__(self, page, label: str, decided: "asyncio.Future[str]",
                 show: Callable[[dict], Awaitable[object]]) -> None:
        self._page = page
        self._label = label
        self._decided = decided
        self._show = show
        self._armed = False
        self._task: asyncio.Task | None = None
        self._listener = self._on_navigated

    # What the overlay reports (apply.py routes `founderosEvent` here) ---------------

    def submit_attempted(self) -> None:
        """She pressed SUBMIT & NEXT. From here a replaced page is a question.

        Never disarmed within a job: after a NO the buttons are back, and a later
        navigation would otherwise leave her on a page with no bar and no way to
        record or skip. A repeated question is the cheaper mistake.
        """
        self._armed = True

    def answered_no(self) -> None:
        print(
            f"  [NOT RECORDED] {self._label}: you answered NO to \"Did the application go through?\". "
            "Nothing was recorded; the row stays in your queue unless you press SKIP.",
            flush=True,
        )

    # Lifecycle ----------------------------------------------------------------------

    def start(self) -> None:
        self._page.on("framenavigated", self._listener)

    def stop(self) -> None:
        self._page.remove_listener("framenavigated", self._listener)
        if self._task is not None and not self._task.done():
            self._task.cancel()

    # The navigation -----------------------------------------------------------------

    def _on_navigated(self, frame) -> None:
        if frame != self._page.main_frame or not self._armed or self._decided.done():
            return
        if self._task is not None and not self._task.done():
            self._task.cancel()  # a newer page replaces the one we were about to ask on
        self._task = asyncio.ensure_future(self._ask_on_the_new_page())

    async def _ask_on_the_new_page(self) -> None:
        last_error: Exception | None = None
        for attempt in range(_ATTEMPTS):
            try:
                await self._page.wait_for_load_state("domcontentloaded", timeout=LOAD_TIMEOUT_MS)
                # A page that loaded but then stops answering must not hold the queue either.
                await asyncio.wait_for(self._ask_unless_the_bar_is_there(), LOAD_TIMEOUT_MS / 1000)
                return
            except (PlaywrightTimeout, asyncio.TimeoutError):
                self._give_up("never finished loading")
                return
            except PlaywrightError as err:
                last_error = err  # the page moved on again mid-call; look again
                if attempt < _ATTEMPTS - 1:
                    await asyncio.sleep(_RETRY_PAUSE_S)
        self._give_up(f"could not be asked on it ({last_error})")

    async def _ask_unless_the_bar_is_there(self) -> None:
        if await self._page.evaluate(_BAR_IS_THERE):
            return  # the same document (a hash or history route): the bar is still there
        await self._show({"ask": ASK, "manual": True})

    def _give_up(self, why: str) -> None:
        print(
            f"  [NOT RECORDED] {self._label}: the page changed after SUBMIT & NEXT and {why}, so I could "
            "not ask whether it went through. Nothing was recorded; the row stays in your queue, so check "
            "the site before you apply again.",
            flush=True,
        )
        if not self._decided.done():
            self._decided.set_exception(
                NavigationUnconfirmed(f"the page changed after SUBMIT & NEXT and {why}")
            )
