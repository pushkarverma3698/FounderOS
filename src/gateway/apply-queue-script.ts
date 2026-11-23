/**
 * Apply queue: the one inline script (nonce in the CSP, see apply-page.ts)
 * ========================================================================
 * Runs inside the Telegram Mini App. GET /apply/api/queue gives the four groups. Every action calls an endpoint that
 * already exists, under the row's signed answer link (`path` below):
 *   Send        POST <path>/submit {createdAt}, then poll GET <path>/status   (the Mini App Submit path, apply-api.ts)
 *   Copy all    GET  <path>/handoff/panel, joined as "label: value" lines     (the hand-off panel, apply-handoff-routes.ts)
 *   I applied   POST <path>/handoff/applied
 * Send and I applied need a second tap. Server text goes in through textContent; the hand-off panel fragment is parsed
 * with DOMParser (never inserted) and only its text is read.
 */

export const APPLY_QUEUE_SCRIPT = String.raw`(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : "";
  var bodyEl = document.getElementById("aq-body");
  var statusEl = document.getElementById("aq-status");
  var subEl = document.getElementById("aq-sub");
  if (!bodyEl || !statusEl || !subEl) return;
  if (tg && tg.ready) tg.ready();
  if (tg && tg.expand) tg.expand();
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  function call(path, method, body) {
    var h = { "X-Telegram-Init-Data": initData };
    if (body) h["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined });
  }
  function pathOf(url) { try { return new URL(url).pathname.replace(/\/+$/, ""); } catch (e) { return ""; } }
  function button(label, cls, onTap) { var b = el("button", cls, label); b.type = "button"; b.addEventListener("click", function () { onTap(b); }); return b; }
  /** A button that asks for a second tap before it acts. */
  function twoTap(label, confirmLabel, run) {
    var armed = false;
    return button(label, "", function (b) {
      if (!armed) { armed = true; b.textContent = confirmLabel; return; }
      armed = false; b.disabled = true; run(b, function () { b.disabled = false; b.textContent = label; });
    });
  }

  function copyText(text, note) {
    function done() { note.textContent = "Copied. Paste each answer where the form asks."; }
    function fallback() {
      var t = document.createElement("textarea");
      t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(t);
      note.textContent = ok ? "Copied. Paste each answer where the form asks." : "Could not copy here. Open the form from its own page instead.";
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  function copyAll(path, note) {
    note.textContent = "Getting your answers...";
    call(path + "/handoff/panel", "GET").then(function (r) {
      if (r.status !== 200) throw new Error("closed");
      return r.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, "text/html");
      var lines = [];
      doc.querySelectorAll(".q").forEach(function (q) {
        var t = q.querySelector(".t"), v = q.querySelector(".val");
        if (t && v) lines.push(t.textContent + ": " + v.textContent);
      });
      if (!lines.length) { note.textContent = "No answers on file for this form."; return; }
      copyText(lines.join("\n"), note);
    }, function () { note.textContent = "Could not get the answers. Try again in a minute."; });
  }

  function send(path, item, note, done) {
    call(path + "/submit", "POST", { createdAt: item.createdAt }).then(function (r) {
      return r.json().then(function (j) { return { code: r.status, data: j }; });
    }).then(function (r) {
      if (r.code !== 202) { note.textContent = r.data.detail || "Not sent."; done(); return; }
      note.textContent = "Sending. This takes about a minute.";
      var n = 0;
      var timer = setInterval(function () {
        n += 1;
        call(path + "/status", "GET").then(function (s) { return s.json(); }).then(function (s) {
          if (s.state === "submitting" && n < 150) return;
          clearInterval(timer);
          note.textContent = s.state === "confirmed" ? "Sent. The company confirmed it."
            : s.state === "unconfirmed" ? "Clicked, but no confirmation came back. Check your email before sending again."
            : (s.detail || "Not sent.");
          if (s.state !== "confirmed" && s.state !== "unconfirmed") done();
        }, function () { clearInterval(timer); note.textContent = "Lost contact. Check the Telegram chat for the result."; });
      }, 2000);
    }, function () { note.textContent = "Network error. Nothing was sent."; done(); });
  }

  function actions(item, macOnline, card) {
    var path = pathOf(item.answerUrl || "");
    var note = el("p", "note");
    var row = el("div");
    if (item.group === "ready") {
      if (item.canSend && path) row.appendChild(twoTap("Send", "Tap again to send to " + item.company, function (b, done) { send(path, item, note, done); }));
      else note.textContent = "Not prepared yet. Open it from the Jobs list first.";
    } else if (item.group === "answer") {
      if (path) { var a = el("a", "go", "Answer the question"); a.href = item.answerUrl; row.appendChild(a); }
      else note.textContent = "Not prepared yet. Open it from the Jobs list first.";
    } else if (item.group === "mac") {
      note.textContent = macOnline ? "Your Mac will try this one." : "Your Mac is offline. This waits until it is back on.";
    } else {
      if (item.jobUrl) {
        var o = el("a", "go", "Open form"); o.href = item.jobUrl; o.target = "_blank"; o.rel = "noopener noreferrer";
        if (tg && tg.openLink) o.addEventListener("click", function (e) { e.preventDefault(); tg.openLink(o.href); });
        row.appendChild(o);
      }
      if (path) {
        row.appendChild(button("Copy all answers", "alt", function () { copyAll(path, note); }));
        row.appendChild(twoTap("I applied", "Tap again: I applied", function (b, done) {
          call(path + "/handoff/applied", "POST").then(function (r) {
            if (r.status !== 200) throw new Error("refused");
            b.textContent = "Marked applied"; note.textContent = "Counted as applied.";
          }, function () { throw new Error("network"); }).catch(function () { note.textContent = "Could not mark it. Nothing changed."; done(); });
        }));
      } else note.textContent = "No saved answers for this one yet. Open the form and fill it by hand.";
    }
    card.appendChild(row);
    card.appendChild(note);
  }

  function render(data) {
    bodyEl.textContent = "";
    var items = data.items || [];
    statusEl.textContent = items.length ? "" : "Nothing waiting in your queue.";
    var c = data.counts || {};
    subEl.textContent = items.length ? (c.ready || 0) + " ready to send, " + (c.answer || 0) + " need one answer, " + (c.mac || 0) + " need a click on your Mac, " + (c.site || 0) + " need you on the site." : "";
    if (c.mac && !data.macOnline) bodyEl.appendChild(el("p", "warn", "Mac offline: the Mac rows wait until it checks in."));
    (data.groups || []).forEach(function (g) {
      var rows = items.filter(function (i) { return i.group === g.id; });
      if (!rows.length) return;
      bodyEl.appendChild(el("h2", "", g.title + " (" + rows.length + ")"));
      rows.forEach(function (item) {
        var card = el("div", "q");
        card.appendChild(el("span", "t", item.company + ": " + item.title));
        if (item.reason) card.appendChild(el("p", "note", item.reason));
        actions(item, data.macOnline, card);
        bodyEl.appendChild(card);
      });
    });
  }

  if (!initData) { statusEl.textContent = "Open this from the queue button in Telegram."; return; }
  call("/apply/api/queue", "GET").then(function (r) {
    if (r.status !== 200) { statusEl.textContent = "Could not sign you in. Open this from the bot in Telegram."; return; }
    return r.json().then(render);
  }, function () { statusEl.textContent = "Network error. Reopen this page."; });
})();`;
