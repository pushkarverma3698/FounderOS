/**
 * Apply answer page: the one inline script (nonce in the CSP, see apply-page.ts)
 * ==============================================================================
 * Runs inside the Telegram Mini App. Five jobs, all plain fetch() to the same origin:
 *   1. status: GET .../status with the X-Telegram-Init-Data header, polled every 2 s while a run is going.
 *   2. Submit: the Telegram MainButton, shown only when the state is ready, then an in-page confirm
 *      (no confirm() or alert(): the viewer blocks them), then POST .../submit.
 *   3. Cancel: POST .../cancel.
 *   4. Save answers: the form posts by fetch with in-page progress, then reloads when the re-fill ends.
 *   5. Emailed code: when the state is code-needed, an input and Send code button; POST .../code {code}.
 *   6. Submit it yourself (unconfirmed on a bot check): the job link opens through tg.openLink, each Copy button
 *      copies one answer, and I submitted it (after an in-page confirm) POSTs .../submitted {createdAt}.
 *   7. Prepare again (unconfirmed, cancelled, closed or out of date): POST /apply/api/prepare/<row>, poll
 *      /apply/api/job-status/<row>, and open the fresh answer page when it is ready.
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
  var codeEl = document.getElementById("mini-code");
  var codeInput = document.getElementById("mini-code-input");
  var codeBtn = document.getElementById("mini-code-send");
  var form = document.querySelector("form");
  var rowId = main.getAttribute("data-row") || "";
  var againBtn = document.getElementById("mini-again");
  var againConfirm = document.getElementById("mini-again-confirm");
  var selfDone = document.getElementById("self-done");
  var selfConfirm = document.getElementById("self-confirm");
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
    codeEl.hidden = state !== "code-needed";
    if (state === "confirmed" || state === "cancelled" || state === "unconfirmed") submitted = true;
    showAgain(state === "unconfirmed" || state === "cancelled");
    if (selfDone && state !== "unconfirmed") { selfDone.hidden = true; selfConfirm.hidden = true; }
    if (BUSY[state] || state === "code-needed") schedule();
  }
  function poll() {
    call("status", "GET").then(function (r) {
      if (r.code === 404) { say(statusEl, "This form is closed. Tap Prepare again for a fresh one."); mainButton(false); cancelBtn.hidden = true; codeEl.hidden = true; showAgain(true); return; }
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
      if (r.data && r.data.stale) { showAgain(true); return; }
      poll();
    }, function () { submitted = false; say(statusEl, "Could not reach the server. Nothing was submitted."); });
  }
  function doCode() {
    var code = codeInput.value.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9]{4,12}$/.test(code)) { say(statusEl, "The code is 4 to 12 letters and digits."); return; }
    codeBtn.disabled = true;
    call("code", "POST", { code: code }).then(function (r) {
      codeBtn.disabled = false;
      if (r.code === 202) { codeInput.value = ""; codeEl.hidden = true; state = "submitting"; say(statusEl, "Entering the code and submitting."); schedule(); return; }
      say(statusEl, (r.data && (r.data.detail || r.data.error)) || "The server refused the code.");
      if (r.code === 409) poll();
    }, function () { codeBtn.disabled = false; say(statusEl, "Could not reach the server. The code was not sent."); });
  }
  function doCancel() {
    cancelBtn.disabled = true;
    call("cancel", "POST").then(function (r) {
      cancelBtn.disabled = false;
      if (r.data && r.data.detail) say(statusEl, r.data.detail);
      if (r.code === 200) { mainButton(false); cancelBtn.hidden = true; codeEl.hidden = true; confirmEl.hidden = true; submitted = true; clearTimeout(timer); }
    }, function () { cancelBtn.disabled = false; say(statusEl, "Could not reach the server."); });
  }

  function showAgain(on) {
    againBtn.hidden = !on || !initData || !rowId;
    if (!on) againConfirm.hidden = true;
  }
  function home(method, rest) {
    return fetch("/apply/api/" + rest, { method: method, headers: headers({}) }).then(function (r) {
      return r.json().then(function (j) { return { code: r.status, data: j }; }, function () { return { code: r.status, data: {} }; });
    });
  }
  function watchPrepare(n) {
    if (n > 300) { say(statusEl, "Still working. Check the Telegram chat."); return; }
    home("GET", "job-status/" + rowId).then(function (r) {
      if (r.code !== 200) { say(statusEl, "Could not read the status. Check the Telegram chat."); return; }
      if (r.data.url) { say(statusEl, "Ready. Opening the fresh form."); location.href = r.data.url; return; }
      if (r.data.state === "failed") { say(statusEl, r.data.detail || "The form could not be prepared."); againBtn.hidden = false; return; }
      say(statusEl, r.data.detail || "Opening the form and filling it.");
      setTimeout(function () { watchPrepare(n + 1); }, 2000);
    }, function () { setTimeout(function () { watchPrepare(n + 1); }, 3000); });
  }
  function doAgain() {
    againConfirm.hidden = true;
    againBtn.hidden = true;
    clearTimeout(timer);
    say(statusEl, "Opening the form and filling it. This takes about a minute.");
    home("POST", "prepare/" + rowId).then(function (r) {
      if (r.code === 202 || r.code === 409) { setTimeout(function () { watchPrepare(0); }, 2000); return; }
      againBtn.hidden = false;
      say(statusEl, (r.data && r.data.detail) || "Could not start. Run /apply again in Telegram.");
    }, function () { againBtn.hidden = false; say(statusEl, "Could not reach the server. Nothing was started."); });
  }
  function askAgain() {
    if (state === "unconfirmed") { againBtn.hidden = true; againConfirm.hidden = false; return; }
    doAgain();
  }

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
  var copies = document.querySelectorAll("button.copy");
  for (var i = 0; i < copies.length; i++) {
    copies[i].addEventListener("click", function (e) {
      var btn = e.currentTarget;
      var src = document.getElementById(btn.getAttribute("data-copy"));
      if (src) copyText(src.textContent, btn);
    });
  }
  var selfLink = document.getElementById("self-link");
  if (selfLink && tg && tg.openLink) {
    selfLink.addEventListener("click", function (e) { e.preventDefault(); tg.openLink(selfLink.href); });
  }
  function doSelfDone() {
    selfConfirm.hidden = true;
    selfDone.disabled = true;
    call("submitted", "POST", { createdAt: created }).then(function (r) {
      selfDone.disabled = false;
      if (r.code === 200) { render(r.data); selfDone.hidden = true; return; }
      selfDone.hidden = false;
      say(statusEl, (r.data && (r.data.detail || r.data.error)) || "The server refused it. Nothing was marked.");
      if (r.data && r.data.stale) showAgain(true);
    }, function () { selfDone.disabled = false; selfDone.hidden = false; say(statusEl, "Could not reach the server. Nothing was marked."); });
  }
  if (selfDone) {
    selfDone.addEventListener("click", function () { selfDone.hidden = true; selfConfirm.hidden = false; });
    document.getElementById("self-back").addEventListener("click", function () { selfConfirm.hidden = true; selfDone.hidden = false; });
    document.getElementById("self-yes").addEventListener("click", doSelfDone);
    if (!initData) selfDone.hidden = true;
  }
  againBtn.addEventListener("click", askAgain);
  document.getElementById("mini-again-yes").addEventListener("click", doAgain);
  document.getElementById("mini-again-back").addEventListener("click", function () { againConfirm.hidden = true; againBtn.hidden = false; });

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
  codeBtn.addEventListener("click", doCode);
  if (tg && tg.MainButton) tg.MainButton.onClick(askConfirm);

  if (!initData) { say(statusEl, "Open from Telegram to submit"); cancelBtn.hidden = true; return; }
  poll();
})();`;
