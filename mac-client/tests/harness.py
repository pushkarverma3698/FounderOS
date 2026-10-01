"""Shared helpers for the overlay tests: real Chromium, local pages, no network."""

from __future__ import annotations

from pathlib import Path

from mac_client import apply as apply_mod

FIXTURES = Path(__file__).parent / "fixtures"

#: What `process_job` hands the overlay, minus the fields these tests do not read.
BASE_DATA = {
    "position": "1 of 1",
    "company": "Fixture BV",
    "title": "Financial Analyst",
    "filled": [],
    "skipped": [],
}


class Overlay:
    """A page with the founder's decision bar on it, and every outcome it reported."""

    def __init__(self, page):
        self.page = page
        self.decisions: list[str] = []

    async def open(self, *, fixture: str | None = None, html: str | None = None, **data) -> "Overlay":
        if fixture is not None:
            await self.page.goto((FIXTURES / fixture).as_uri(), wait_until="domcontentloaded")
        else:
            await self.page.set_content(html or "")

        async def on_decision(_source, outcome):
            self.decisions.append(outcome)

        await self.page.expose_binding("founderosDecision", on_decision)
        await self.page.evaluate(apply_mod.OVERLAY_JS.read_text(), {**BASE_DATA, **data})
        return self

    @staticmethod
    def _button(label: str) -> str:
        # "SUBMIT" alone would also match "I SUBMITTED IT MYSELF".
        label = "SUBMIT & NEXT" if label == "SUBMIT" else label
        return f"#founderos-bar button:has-text('{label}')"

    async def press(self, label: str) -> None:
        await self.page.click(self._button(label))

    async def bar_text(self) -> str:
        return await self.page.inner_text("#founderos-bar")

    async def has_button(self, label: str) -> bool:
        return await self.page.locator(self._button(label)).count() > 0

    async def is_enabled(self, label: str) -> bool:
        return await self.page.locator(self._button(label)).is_enabled()

    async def wait_for_bar_text(self, text: str, timeout: int = 6000) -> None:
        await self.page.wait_for_function(
            "(t) => (document.getElementById('founderos-bar')?.innerText || '').includes(t)",
            arg=text,
            timeout=timeout,
        )
