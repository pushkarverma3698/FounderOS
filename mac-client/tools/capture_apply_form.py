#!/usr/bin/env python3
"""Save the rendered DOM of ONE job-apply page, so a field map can be written from the real thing.

    .venv/bin/python tools/capture_apply_form.py "<apply page url>" --out captures/smartrecruiters-nl

STATUS: THIS TOOL HAS NEVER BEEN RUN AGAINST SMARTRECRUITERS, or any real site. It was
tested only on a local page with an open shadow root (tests/test_capture_apply_form.py).
Expect to adjust it the first time it meets a real page, and say what happened.

READ-ONLY. It loads ONE url, waits for form controls to appear, then writes three files:

  <out>.dom.html        the rendered DOM, open shadow roots inlined (declarative shadow DOM),
                        with scripts, styles, images, iframes, links and form targets removed
  <out>.controls.json   every input, textarea, select, button and custom element, pierced through
                        open shadow roots, with its attributes, label and whether it is visible
  <out>.meta.json       final url, status, redirects, title, language, what was clicked, counts

It NEVER types, selects, uploads or submits. It does not click either, unless you give
`--click "<visible text>"` (repeatable) to reveal a form hidden behind a button. A click is
refused, before the browser even starts, when its text looks like sending an application
(submit, verzenden, versturen, send application, apply now, solliciteer ...), and again
at the element when it is a control that would submit a form, whatever it says.

What it cannot see: closed shadow roots, and anything inside an iframe (both are counted in
the meta file, so a form that is missing from the capture can be explained).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

#: Click texts that look like sending an application. Matched as lowercase substrings, so the
#: stems cover "Verzenden", "Solliciteren", "Submit your application" and the rest.
REFUSED_CLICK_WORDS = (
    "submit", "verzend", "verstuur", "versturen", "send application", "apply now", "solliciteer", "solliciteren",
)

#: Exit codes: 0 captured; 1 the page could not be loaded; 2 a click was refused or the usage is wrong
#: (argparse also uses 2); 3 captured, but no form control ever appeared.
EXIT_OK, EXIT_LOAD_FAILED, EXIT_REFUSED, EXIT_NO_FORM = 0, 1, 2, 3

WAIT_FOR_CONTROLS = "input, textarea, select, [role=textbox], [contenteditable=true]"

# The page as the browser built it, open shadow roots inlined as declarative shadow DOM so the saved
# file rebuilds the same tree when it is loaded again. Drops what can never matter to a field map or
# would make the file carry the page's own machinery: scripts, styles, images, iframes, links, form
# targets, and anything named like a token. A hidden input keeps its name and loses its value.
FLATTEN_JS = r"""
() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'IFRAME', 'META', 'SVG', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'SOURCE', 'BASE', 'OBJECT', 'EMBED', 'CANVAS']);
  const VOID = new Set(['AREA', 'BR', 'COL', 'EMBED', 'HR', 'INPUT', 'WBR']);
  const DROP_ATTR = /^(style|nonce|integrity|crossorigin|srcset|src|href|action|formaction|ping|poster)$/i;
  const SECRET_ATTR = /token|csrf|secret|session|nonce|auth/i;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  function ser(node) {
    if (node.nodeType === 3) return escText(node.textContent);
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    if (SKIP.has(tag.toUpperCase())) return '';
    const name = tag.toLowerCase();
    const hidden = name === 'input' && (node.getAttribute('type') || '').toLowerCase() === 'hidden';
    let attrs = '';
    for (const a of node.attributes) {
      if (DROP_ATTR.test(a.name) || SECRET_ATTR.test(a.name)) continue;
      attrs += ` ${a.name}="${esc(hidden && a.name === 'value' ? '' : a.value)}"`;
    }
    let inner = '';
    if (node.shadowRoot && node.shadowRoot.mode === 'open') {
      inner += '<template shadowrootmode="open">' + [...node.shadowRoot.childNodes].map(ser).join('') + '</template>';
    }
    inner += [...node.childNodes].map(ser).join('');
    if (VOID.has(tag)) return `<${name}${attrs}>`;
    return `<${name}${attrs}>${inner}</${name}>`;
  }
  return '<!doctype html>\n' + ser(document.documentElement);
}
"""

# Every control on the page, pierced through open shadow roots, with the text a human reads next to it.
CONTROLS_JS = r"""
() => {
  const out = [];
  const ROLES = ['combobox', 'textbox', 'button', 'checkbox', 'radio', 'listbox', 'switch'];
  const SECRET_ATTR = /token|csrf|secret|session|nonce|auth/i;
  const labelOf = (el, root) => {
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push((l.innerText || '').trim());
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) {
      const target = root.getElementById ? root.getElementById(id) : null;
      if (target) parts.push((target.innerText || '').trim());
    }
    return parts.filter(Boolean).join(' | ').slice(0, 160);
  };
  const visit = (root, path) => {
    for (const el of root.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      const isControl = ['input', 'textarea', 'select', 'button'].includes(tag) || tag.includes('-') ||
        ROLES.includes(el.getAttribute('role')) || el.getAttribute('contenteditable') === 'true';
      if (isControl) {
        const attrs = {};
        const hidden = tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden';
        for (const a of el.attributes) {
          if (/^(style|class|nonce)$/i.test(a.name) || a.name.startsWith('_ng') || a.name.startsWith('ng-') || SECRET_ATTR.test(a.name)) continue;
          attrs[a.name] = hidden && a.name === 'value' ? '' : a.value.slice(0, 160);
        }
        const r = el.getBoundingClientRect();
        out.push({
          path, tag, attrs, label: labelOf(el, root),
          visible: !!(el.offsetParent || r.width * r.height > 0),
          hasShadow: !!el.shadowRoot, text: (el.innerText || '').slice(0, 80),
        });
      }
      if (el.shadowRoot) visit(el.shadowRoot, path + '>' + tag);
    }
  };
  visit(document, 'document');
  return out;
}
"""

# What the page holds that this tool cannot read, so a missing form can be explained.
UNREADABLE_JS = r"""
() => {
  let withoutOpenShadow = 0;
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName.includes('-') && !el.shadowRoot && el.childElementCount === 0) withoutOpenShadow++;
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  return { iframes: document.querySelectorAll('iframe').length, custom_elements_without_open_shadow: withoutOpenShadow };
}
"""

# True when pressing this element could submit a form: whatever its label says. When in doubt, True.
SUBMIT_LIKE_JS = r"""
(el) => {
  const inForm = (n) => { for (; n; n = n.parentNode || n.host) if (n.tagName === 'FORM') return true; return false; };
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (tag === 'input') return type !== 'button' && type !== 'reset';
  if (tag === 'button') {
    if (type === 'button' || type === 'reset') return false;
    return type === 'submit' || el.hasAttribute('form') || inForm(el);
  }
  return inForm(el);  // a link, role=button or custom element inside a form: cannot tell what it does
}
"""

# The clickable things on the page and the words on them, to say what --click could have meant.
CLICKABLES_JS = r"""
() => {
  const out = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit]')) {
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (text) out.push(text.slice(0, 60));
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
  };
  visit(document);
  return [...new Set(out)].slice(0, 30);
}
"""


class ClickRefused(Exception):
    """A --click that this read-only tool will not make. Nothing was loaded or clicked."""


class CaptureError(Exception):
    """The page could not be loaded or the click could not be found. Says what, and what to try."""


def refused_click(text: str) -> str | None:
    """The word that makes `text` look like sending an application, or None."""
    folded = " ".join(text.lower().split())
    return next((word for word in REFUSED_CLICK_WORDS if word in folded), None)


@dataclass
class Capture:
    files: dict[str, Path]
    controls: list[dict]
    meta: dict = field(default_factory=dict)

    @property
    def has_form(self) -> bool:
        return any(c["tag"] in ("input", "textarea", "select") for c in self.controls)


async def capture(
    url: str,
    out_prefix: str | Path,
    *,
    locale: str = "en-US",
    clicks: tuple[str, ...] = (),
    headed: bool = False,
    controls_timeout_ms: int = 20_000,
    settle_ms: int = 1_500,
) -> Capture:
    """Load `url` once, optionally press the named reveal buttons, and write the three files."""
    for text in clicks:  # refused before a browser exists: a refusal must cost nothing
        word = refused_click(text)
        if word:
            raise ClickRefused(_refusal_message(text, f"it looks like sending an application (it contains {word!r})"))

    from playwright.async_api import Error as PlaywrightError
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not headed)
        try:
            context = await browser.new_context(locale=locale, extra_http_headers={"Accept-Language": f"{locale},en;q=0.8"})
            page = await context.new_page()
            try:
                response = await page.goto(url, wait_until="load", timeout=45_000)
            except PlaywrightError as err:
                raise CaptureError(_load_failure_message(url, str(err))) from err
            await _settle(page, controls_timeout_ms)
            clicked: list[str] = []
            for text in clicks:
                await _click_by_text(page, text)
                clicked.append(text)
                await _settle(page, controls_timeout_ms)
            await page.wait_for_timeout(settle_ms)

            dom = await page.evaluate(FLATTEN_JS)
            controls = await page.evaluate(CONTROLS_JS)
            unreadable = await page.evaluate(UNREADABLE_JS)
            meta = {
                "requested": url,
                "final_url": page.url,
                "status": response.status if response else None,
                "redirect_chain": _redirect_chain(response),
                "title": await page.title(),
                "lang": await page.evaluate("document.documentElement.lang"),
                "locale_sent": locale,
                "clicked": clicked,
                "controls": len(controls),
                "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                **unreadable,
            }
        finally:
            await browser.close()

    prefix = Path(out_prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    files = {
        "dom": prefix.parent / f"{prefix.name}.dom.html",
        "controls": prefix.parent / f"{prefix.name}.controls.json",
        "meta": prefix.parent / f"{prefix.name}.meta.json",
    }
    files["dom"].write_text(dom, encoding="utf-8")
    files["controls"].write_text(json.dumps(controls, indent=1), encoding="utf-8")
    files["meta"].write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return Capture(files=files, controls=controls, meta=meta)


async def _settle(page, controls_timeout_ms: int) -> None:
    """Let the page finish: best effort, never fatal (a page that never goes idle is still captured)."""
    for wait in (
        lambda: page.wait_for_load_state("networkidle", timeout=20_000),
        lambda: page.wait_for_selector(WAIT_FOR_CONTROLS, state="attached", timeout=controls_timeout_ms),
    ):
        try:
            await wait()
        except Exception:  # noqa: BLE001 - reported by the caller as "no form controls", with the counts
            pass


async def _click_by_text(page, text: str) -> None:
    """THE ONE CLICK this tool can make: one button or link whose whole visible text is `text`.

    It must match exactly one element, and that element must not be something that submits a form.
    """
    whole = re.compile(rf"^\s*{re.escape(text.strip())}\s*$", re.IGNORECASE)
    for role in ("button", "link"):
        matches = page.get_by_role(role, name=whole)
        count = await matches.count()
        if count == 0:
            continue
        if count > 1:
            raise CaptureError(
                f"--click {text!r} matches {count} {role}s on the page, so I will not guess which one. "
                "Use the full text of the one you mean."
            )
        target = matches.first
        if await target.evaluate(SUBMIT_LIKE_JS):
            raise ClickRefused(_refusal_message(text, "that control would submit a form"))
        await target.click(timeout=10_000)
        return
    seen = await page.evaluate(CLICKABLES_JS)
    raise CaptureError(
        f"--click {text!r}: no button or link on the page has exactly that text. "
        f"The buttons and links I can see say: {seen}. The text is the one in the page's HTML, "
        "which can differ from what you see when the page shows capital letters by style."
    )


def _refusal_message(text: str, why: str) -> str:
    return (
        f"Refusing to click {text!r}: {why}. This tool only reads. If that button only opens the form, "
        "open the form yourself in your browser and give the tool the form's own address instead."
    )


def _load_failure_message(url: str, error: str) -> str:
    hint = ""
    if "ERR_CERT" in error or "SSL" in error.upper():
        hint = (
            " This is a certificate problem: this browser does not trust the connection. The tool will "
            "not bypass that. Run it on a network and a machine whose browser trusts it."
        )
    return f"Could not load {url}: {error.splitlines()[0] if error else 'unknown error'}.{hint}"


def _redirect_chain(response) -> list[str]:
    chain: list[str] = []
    request = response.request if response else None
    while request is not None:
        chain.append(request.url)
        request = request.redirected_from
    return list(reversed(chain))


def _default_out(url: str) -> str:
    host = urlparse(url).hostname or "page"
    return f"captures/{host}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Save the rendered DOM and controls of ONE job-apply page. Read-only: never types, "
        "never submits, clicks only what you name with --click.",
        epilog="NEVER run against SmartRecruiters (or any real site) as of this writing: see the README.",
    )
    parser.add_argument("url", help="the apply page's address (http, https or file)")
    parser.add_argument("--out", help="output prefix (default captures/<host>-<time>); three files are written")
    parser.add_argument("--locale", default="en-US", help="browser language, e.g. nl-NL (default en-US)")
    parser.add_argument("--click", action="append", default=[], metavar="TEXT",
                        help="press the one button or link with this whole visible text to reveal the form "
                             "(repeatable). Refused when it looks like submitting.")
    parser.add_argument("--wait", type=float, default=20.0, metavar="SECONDS",
                        help="how long to wait for form controls to appear, after loading and after each click "
                             "(default 20; raise it for a slow page)")
    parser.add_argument("--headed", action="store_true", help="show the browser window")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if urlparse(args.url).scheme not in ("http", "https", "file"):
        print(f"This tool loads an http, https or file address, not {args.url!r}.", file=sys.stderr)
        return EXIT_REFUSED
    out = args.out or _default_out(args.url)
    try:
        result = asyncio.run(
            capture(args.url, out, locale=args.locale, clicks=tuple(args.click), headed=args.headed,
                    controls_timeout_ms=int(args.wait * 1000))
        )
    except ClickRefused as err:
        print(err, file=sys.stderr)
        return EXIT_REFUSED
    except CaptureError as err:
        print(err, file=sys.stderr)
        return EXIT_LOAD_FAILED

    print(f"Captured {result.meta['final_url']} (status {result.meta['status']}, lang {result.meta['lang']!r})")
    if (result.meta["status"] or 0) >= 400:
        print(f"WARNING: the page answered {result.meta['status']}: this is probably not the apply form.", file=sys.stderr)
    for name, path in result.files.items():
        print(f"  {name:8} {path}")
    print(f"  {result.meta['controls']} controls, {result.meta['iframes']} iframes, "
          f"{result.meta['custom_elements_without_open_shadow']} custom elements with no readable shadow root")
    if not result.has_form:
        print(
            "WARNING: no input, textarea or select was found. The files hold the page shell only. The form may be "
            "behind a button (try --click \"<its text>\"), inside an iframe, in a closed shadow root, or the site "
            "may have refused this browser (try --headed).",
            file=sys.stderr,
        )
        return EXIT_NO_FORM
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
