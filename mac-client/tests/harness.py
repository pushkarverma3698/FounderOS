"""Shared helpers for the overlay tests: real Chromium, local pages, no network."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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


# -- a real HTTP server, for what file:// cannot do: a form POST that navigates -------

@dataclass(frozen=True)
class Reply:
    body: str = ""
    status: int = 200
    location: str | None = None
    #: Send the first bytes of a page and never finish it (until the site closes):
    #: the browser commits the navigation but the document never finishes loading.
    hold: bool = False


class _Handler(BaseHTTPRequestHandler):
    def _serve(self, method: str) -> None:
        site: LocalSite = self.server.site  # type: ignore[attr-defined]
        if method == "POST":
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
        path = self.path.split("?")[0]
        site.seen.append((method, path))
        reply = site.pages.get((method, path))
        if reply is None:
            self.send_error(404)
            return
        self.send_response(reply.status)
        if reply.location:
            self.send_header("Location", reply.location)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        if reply.hold:
            self.end_headers()
            self.wfile.write(b"<!doctype html><html><body><p>loading")
            self.wfile.flush()
            site.release.wait(30)
            return
        body = reply.body.encode()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (http.server's naming)
        self._serve("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._serve("POST")

    def log_message(self, *_args) -> None:
        pass  # pytest output, not an access log


class LocalSite:
    """Pages over real HTTP on 127.0.0.1 (no network leaves the machine).

    `pages` maps (method, path) to a `Reply`; every request is recorded in `seen`,
    so a test can say the employer's form really was POSTed, and how often.
    """

    def __init__(self, pages: dict[tuple[str, str], Reply]):
        self.pages = pages
        self.seen: list[tuple[str, str]] = []
        self.release = threading.Event()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        self._server.site = self  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> "LocalSite":
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.release.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(5)

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}{path}"

    @property
    def posts(self) -> list[str]:
        return [path for method, path in self.seen if method == "POST"]
