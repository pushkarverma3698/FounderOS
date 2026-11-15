/**
 * Hand-off panel: the one inline script (nonce in the CSP, see apply-page.ts)
 * ==========================================================================
 * Runs inside the Telegram Mini App. It asks the same origin for the panel with Telegram's signed initData in
 * the X-Telegram-Init-Data header, shows the answer, then wires Copy, the PDF downloads and "I applied".
 * The panel HTML was escaped on the server. Everything the script itself writes goes in through textContent.
 * Without initData (a plain browser) it shows nothing but a line saying to open the panel from Telegram.
 */

export const APPLY_HANDOFF_SCRIPT = String.raw`(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : "";
  var body = document.getElementById("ho-body");
  var statusEl = document.getElementById("ho-status");
  if (!body || !statusEl) return;
  var base = location.pathname.replace(/\/+$/, "");
  if (tg && tg.ready) tg.ready();
  if (tg && tg.expand) tg.expand();
  function say(el, t) { el.textContent = t; }
  function call(sub, method) { return fetch(base + "/" + sub, { method: method, headers: { "X-Telegram-Init-Data": initData } }); }

  function copyText(text, btn) {
    function done() { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); }
    function fallback() {
      var t = document.createElement("textarea");
      t.value = text;
      t.setAttribute("readonly", "");
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(t);
      if (ok) done(); else btn.textContent = "Select and copy by hand";
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  function download(kind, btn) {
    var label = btn.textContent;
    btn.disabled = true;
    say(btn, "Preparing the file");
    call("file/" + kind, "GET").then(function (r) {
      if (r.status !== 200) throw new Error("missing");
      return r.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = kind === "cv" ? "cv.pdf" : "cover-letter.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      say(btn, label);
      btn.disabled = false;
    }, function () { say(btn, "Could not get the file"); btn.disabled = false; });
  }

  function wireApplied() {
    var btn = document.getElementById("ho-applied");
    var note = document.getElementById("ho-applied-note");
    if (!btn || !note) return;
    var armed = false;
    btn.addEventListener("click", function () {
      if (!armed) { armed = true; say(btn, "Tap again to confirm: I applied"); return; }
      btn.disabled = true;
      call("applied", "POST").then(function (r) {
        if (r.status !== 200) throw new Error("refused");
        say(btn, "Marked applied");
        say(note, "Counted as applied. You can close this page.");
      }, function () { throw new Error("network"); }).catch(function () {
        armed = false;
        btn.disabled = false;
        say(btn, "✅ I applied");
        say(note, "Could not mark it. Nothing changed; try again in a minute.");
      });
    });
  }

  function wire() {
    var copies = body.querySelectorAll("button.copy");
    for (var i = 0; i < copies.length; i++) {
      copies[i].addEventListener("click", function (e) {
        var btn = e.currentTarget;
        var src = document.getElementById(btn.getAttribute("data-copy"));
        if (src) copyText(src.textContent, btn);
      });
    }
    var files = body.querySelectorAll("button[data-file]");
    for (var j = 0; j < files.length; j++) {
      files[j].addEventListener("click", function (e) { download(e.currentTarget.getAttribute("data-file"), e.currentTarget); });
    }
    var open = document.getElementById("ho-open");
    if (open && tg && tg.openLink) open.addEventListener("click", function (e) { e.preventDefault(); tg.openLink(open.href); });
    wireApplied();
  }

  if (!initData) { say(statusEl, "Open this from the Copy answers button in Telegram."); return; }
  call("panel", "GET").then(function (r) {
    if (r.status !== 200) { say(statusEl, "This link is closed. Run /apply again in Telegram for a fresh one."); return; }
    return r.text().then(function (html) { body.innerHTML = html; wire(); });
  }, function () { say(statusEl, "Could not reach the server. Try again in a minute."); });
})();`;
