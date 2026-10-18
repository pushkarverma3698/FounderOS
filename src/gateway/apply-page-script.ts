/**
 * Apply answer page: the one inline script (nonce in the CSP, see apply-page.ts)
 * ==============================================================================
 * Runs inside the Telegram Mini App. Four jobs, all plain fetch() to the same origin:
 *   1. status: GET .../status with the X-Telegram-Init-Data header, polled every 2 s while a run is going.
 *   2. Submit: the Telegram MainButton, shown only when the state is ready, then an in-page confirm
 *      (no confirm() or alert(): the viewer blocks them), then POST .../submit.
 *   3. Cancel: POST .../cancel.
 *   4. Save answers: the form posts by fetch with in-page progress, then reloads when the re-fill ends.
 * Without initData (a plain browser) Submit and Cancel stay hidden. Without script the form posts as before.
 * Server text goes in through textContent only, never innerHTML.
 */

export const APPLY_PAGE_SCRIPT = String.raw`(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : "";
  var main = document.querySelector("main");
  var box = document.getElementById("mini");
  if (!main || !box) return;
  var created = Number(main.getAttribute("data-created"));
  var company = main.getAttribute("data-company") || "this company";
  var path = location.pathname.replace(/\/+$/, "");
  var statusEl = document.getElementById("mini-status");
  var saveEl = document.getElementById("mini-save");
  var confirmEl = document.getElementById("mini-confirm");
  var cancelBtn = document.getElementById("mini-cancel");
  var form = document.querySelector("form");
  var state = "";
  var timer = 0;
  var submitted = false;
  var BUSY = { preparing: 1, refilling: 1, submitting: 1 };
  var DONE = { confirmed: 1, cancelled: 1 };

  box.hidden = false;
  if (tg) { tg.ready(); tg.expand(); }

  function say(el, text) { el.textContent = text; }
  function headers(extra) {
    var h = { "X-Telegram-Init-Data": initData };
    for (var k in extra) h[k] = extra[k];
    return h;
  }
  function call(action, method, body) {
    return fetch(path + "/" + action, {
      method: method,
      headers: headers(body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (j) { return { code: r.status, data: j }; }, function () { return { code: r.status, data: {} }; });
    });
  }
  function mainButton(show) {
    if (!tg || !tg.MainButton) return;
    if (show) { tg.MainButton.setText("Submit application"); tg.MainButton.show(); } else { tg.MainButton.hide(); }
  }
  function render(s) {
    state = s.state;
    var text = s.detail || state;
    if (s.missingRequired && s.missingRequired.length) text += " Missing: " + s.missingRequired.join(", ") + ".";
    say(statusEl, text);
    mainButton(state === "ready" && !submitted && confirmEl.hidden);
    cancelBtn.hidden = !!DONE[state] || !initData;
    if (state === "confirmed" || state === "cancelled" || state === "unconfirmed") submitted = true;
    if (BUSY[state]) schedule();
  }
  function poll() {
    call("status", "GET").then(function (r) {
      if (r.code === 404) { say(statusEl, "This form is closed. Run /apply again in Telegram for a fresh one."); mainButton(false); cancelBtn.hidden = true; return; }
      if (r.data && r.data.state) render(r.data);
    }, function () { say(statusEl, "Could not reach the server. Retrying."); schedule(); });
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(poll, 2000); }

  function askConfirm() {
    mainButton(false);
    say(document.getElementById("mini-confirm-text"), "Send your application to " + company + " now? This cannot be undone.");
    confirmEl.hidden = false;
  }
  function backFromConfirm() { confirmEl.hidden = true; mainButton(state === "ready" && !submitted); }
  function doSubmit() {
    confirmEl.hidden = true;
    submitted = true;
    say(statusEl, "Submitting the application. This takes about a minute.");
    call("submit", "POST", { createdAt: created }).then(function (r) {
      if (r.code === 202) { state = "submitting"; schedule(); return; }
      submitted = false;
      say(statusEl, (r.data && r.data.detail) || "The server refused the submit.");
      if (r.data && r.data.stale) return;
      poll();
    }, function () { submitted = false; say(statusEl, "Could not reach the server. Nothing was submitted."); });
  }
  function doCancel() {
    cancelBtn.disabled = true;
    call("cancel", "POST").then(function (r) {
      cancelBtn.disabled = false;
      if (r.data && r.data.detail) say(statusEl, r.data.detail);
      if (r.code === 200) { mainButton(false); cancelBtn.hidden = true; confirmEl.hidden = true; submitted = true; clearTimeout(timer); }
    }, function () { cancelBtn.disabled = false; say(statusEl, "Could not reach the server."); });
  }

  function reloadWhenIdle() {
    call("status", "GET").then(function (r) {
      if (r.code !== 200 || !BUSY[r.data.state]) { location.reload(); return; }
      setTimeout(reloadWhenIdle, 2000);
    }, function () { setTimeout(reloadWhenIdle, 3000); });
  }
  function noticeText(html) {
    var p = new DOMParser().parseFromString(html, "text/html").querySelector("p");
    return p ? p.textContent : "";
  }
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("button[type=submit]");
      if (btn) btn.disabled = true;
      say(saveEl, "Saving your answers.");
      fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(new FormData(form)).toString(),
      }).then(function (r) {
        return r.text().then(function (t) {
          say(saveEl, noticeText(t) || "Done.");
          if (r.status === 200 && /Re-filling/.test(t) && initData) { say(saveEl, "Saved. Re-filling the form, this takes about a minute."); setTimeout(reloadWhenIdle, 2000); return; }
          if (btn) btn.disabled = false;
        });
      }, function () { if (btn) btn.disabled = false; say(saveEl, "Could not reach the server. Nothing was saved."); });
    });
  }

  document.getElementById("mini-yes").addEventListener("click", doSubmit);
  document.getElementById("mini-back").addEventListener("click", backFromConfirm);
  cancelBtn.addEventListener("click", doCancel);
  if (tg && tg.MainButton) tg.MainButton.onClick(askConfirm);

  if (!initData) { say(statusEl, "Open from Telegram to submit"); cancelBtn.hidden = true; return; }
  poll();
})();`;
