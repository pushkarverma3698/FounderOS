/**
 * Apply queue: the one inline script (nonce in the CSP, see apply-page.ts)
 * ========================================================================
 * Runs inside the Telegram Mini App. GET /apply/api/queue gives the four groups. Every action calls an endpoint that
 * already exists, under the row's signed answer link (`path` below):
 *   Send        POST <path>/submit {createdAt, taps}, then poll GET <path>/status   (the Mini App Submit path, apply-api.ts)
 *   Save        POST <path> as a form (the answer page's own POST), then poll the queue until the re-fill is done and Send shows
 *   Copy all    GET  <path>/handoff/panel, joined as "label: value" lines     (the hand-off panel, apply-handoff-routes.ts)
 *   I applied   POST <path>/handoff/applied
 * Ready rows come one card at a time (swipe or Next/Back); Send is one tap and the card turns into the outcome.
 * Taps on a card's own controls are counted and posted with the Send. I applied needs a second tap. Server text goes in through textContent; the hand-off panel fragment is parsed
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

  var OUTCOME = {
    confirmed: ["ok", "Sent. The company confirmed it."],
    unconfirmed: ["bad", "Unconfirmed: clicked, but no confirmation came back. Check your email before sending again."]
  };

  /** Send through the existing Submit; ctx = {item, path, taps(), note, result, done}. One run per card: a double tap is ignored here and refused by the server's row lock. */
  function send(ctx) {
    if (ctx.busy) return;
    ctx.busy = true;
    ctx.note.textContent = "Sending. This takes about a minute.";
    function fail(text) { ctx.busy = false; ctx.note.textContent = text; ctx.btn.disabled = false; }
    call(ctx.path + "/submit", "POST", { createdAt: ctx.item.createdAt, taps: ctx.taps() }).then(function (r) {
      return r.json().then(function (j) { return { code: r.status, data: j }; });
    }).then(function (r) {
      if (r.code !== 202) { fail(r.data.detail || "Not sent."); return; }
      var n = 0;
      var timer = setInterval(function () {
        n += 1;
        call(ctx.path + "/status", "GET").then(function (s) { return s.json(); }).then(function (s) {
          if (s.state === "submitting" && n < 150) return;
          clearInterval(timer);
          var o = OUTCOME[s.state];
          if (o) { ctx.settle(o[0], o[1]); return; }
          fail(s.detail || "Not sent.");
        }, function () { clearInterval(timer); ctx.settle("bad", "Lost contact. Check the Telegram chat for the result."); });
      }, 2000);
    }, function () { fail("Network error. Nothing was sent."); });
  }

  /** A card with its own tap counter (capture phase, so the tap that sends is already counted); taps on its buttons and fields (not the Back/Next row) are posted with the Send. */
  function card(item) {
    var node = el("div", "q");
    var c = { node: node, taps: 0, state: "pending" };
    node.addEventListener("click", function () { c.taps += 1; }, true);
    node.appendChild(el("span", "t big", item.company + ": " + item.title));
    if (item.reason) node.appendChild(el("p", "note", item.reason));
    return c;
  }

  /** Fills c.node with Send for a row that can be sent now. onSettle hears the outcome. */
  function sendControls(c, item, onSettle) {
    var path = pathOf(item.answerUrl || "");
    var note = el("p", "note");
    var ctx = { item: item, path: path, taps: function () { return c.taps; }, note: note, busy: false };
    ctx.btn = button("Send to " + item.company, "", function () { ctx.btn.disabled = true; send(ctx); });
    ctx.settle = function (kind, text) {
      ctx.btn.remove(); note.remove();
      c.node.appendChild(el("p", kind, text));
      c.state = kind === "ok" ? "sent" : "unconfirmed";
      if (onSettle) onSettle(c);
    };
    c.node.appendChild(ctx.btn);
    c.node.appendChild(note);
    return ctx;
  }

  function readyCard(item, onSettle) {
    var c = card(item);
    if (item.canSend && item.answerUrl) sendControls(c, item, onSettle);
    else c.node.appendChild(el("p", "note", "Not prepared yet. Open it from the Jobs list first."));
    return c;
  }

  /** Ready rows: one card on screen, swipe left or right, Next/Back, Skip (this sitting only: nothing is sent or changed). */
  function deck(rows) {
    var wrap = el("div", "deck"), pos = el("p", "pos"), holder = el("div"), nav = el("div", "row");
    var cards = [], at = 0, x0 = null;
    function left() { return cards.filter(function (c) { return c.state === "pending"; }).length; }
    function show(i) {
      at = (i + cards.length) % cards.length;
      holder.textContent = ""; holder.appendChild(cards[at].node);
      var l = left();
      pos.textContent = (at + 1) + " of " + cards.length + (l ? ", " + l + " left" : ", all handled");
    }
    function next() {
      for (var k = 1; k <= cards.length; k++) { var j = (at + k) % cards.length; if (cards[j].state === "pending") { show(j); return; } }
      show(at);
    }
    rows.forEach(function (item) { cards.push(readyCard(item, function (c) { if (c.skip) c.skip.remove(); show(at); })); });
    cards.forEach(function (c) {
      c.skip = button("Skip for now", "alt", function () { c.state = "skipped"; next(); });
      c.node.appendChild(c.skip);
    });
    holder.addEventListener("touchstart", function (e) { x0 = e.changedTouches[0].clientX; }, { passive: true });
    holder.addEventListener("touchend", function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (dx < -50) show(at + 1); else if (dx > 50) show(at - 1);
    }, { passive: true });
    if (cards.length > 1) { nav.appendChild(button("Back", "alt", function () { show(at - 1); })); nav.appendChild(button("Next", "alt", function () { show(at + 1); })); }
    wrap.appendChild(pos); wrap.appendChild(holder); wrap.appendChild(nav);
    show(0);
    return wrap;
  }

  /** The error text out of the answer page's notice HTML (h1 + p), read as text only. */
  function noticeText(html) {
    var p = new DOMParser().parseFromString(html, "text/html").querySelector("p");
    return p ? p.textContent : "Could not save.";
  }

  /** After Save: wait for the re-fill (about a minute), then show Send, or the question again when it is still open. */
  function awaitRefill(c, item, note, rebuild) {
    var n = 0;
    var timer = setInterval(function () {
      n += 1;
      call("/apply/api/queue", "GET").then(function (r) { return r.json(); }).then(function (q) {
        var now = (q.items || []).filter(function (i) { return i.id === item.id; })[0];
        if (!now) { clearInterval(timer); note.textContent = "This one left your queue."; return; }
        if (now.createdAt === item.createdAt && n < 90) return;
        clearInterval(timer);
        if (now.createdAt === item.createdAt) { note.textContent = "Still re-filling. Reopen this page in a minute."; return; }
        rebuild(now);
      }, function () { clearInterval(timer); note.textContent = "Lost contact. Reopen this page in a minute."; });
    }, 3000);
  }

  /** One-answer row: the question and its draft, editable. Save posts the answer page's own form; then Send. */
  function answerCard(item) {
    var c = card(item);
    function build(it, msg) {
      var q = it.question, path = pathOf(it.answerUrl || "");
      var note = el("p", "note", msg || "");
      var old = c.node.querySelector(".ctl"); if (old) old.remove();
      var ctl = el("div", "ctl");
      if (it.canSend) { sendControls(c, it, null); if (msg) c.node.appendChild(note); return; }
      if (!q || !path) {
        if (path) { var a = el("a", "go", "Answer on the form page"); a.href = it.answerUrl; ctl.appendChild(a); } else note.textContent = "Not prepared yet. Open it from the Jobs list first.";
        ctl.appendChild(note); c.node.appendChild(ctl); return;
      }
      ctl.appendChild(el("span", "t", q.label));
      var field;
      if (q.options && q.options.length) {
        field = el("select");
        q.options.forEach(function (o) { var op = el("option", "", o); op.value = o; field.appendChild(op); });
        if (q.draft && q.options.indexOf(q.draft) >= 0) field.value = q.draft; else field.selectedIndex = -1;
      } else { field = el("textarea"); field.rows = 4; field.value = q.draft || ""; }
      ctl.appendChild(field);
      var save = button("Save and re-fill", "", function () {
        var v = (field.value || "").trim();
        if (!v) { note.textContent = "Type an answer first."; return; }
        save.disabled = true; note.textContent = "Saving...";
        var body = new URLSearchParams(); body.set(q.field, v);
        fetch(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }).then(function (r) {
          return r.text().then(function (t) { return { code: r.status, text: t }; });
        }).then(function (r) {
          if (r.code !== 200) { save.disabled = false; note.textContent = noticeText(r.text); return; }
          note.textContent = "Saved. Re-filling the form, about a minute.";
          awaitRefill(c, it, note, function (now) { ctl.remove(); build(now, now.canSend ? "" : "Still needs an answer."); });
        }, function () { save.disabled = false; note.textContent = "Network error. Nothing was saved."; });
      });
      ctl.appendChild(save); ctl.appendChild(note); c.node.appendChild(ctl);
    }
    build(item, "");
    return c;
  }

  function plainCard(item, macOnline) {
    var c = card(item), path = pathOf(item.answerUrl || ""), note = el("p", "note"), row = el("div");
    if (item.group === "mac") {
      note.textContent = item.macNote || (macOnline ? "Click the check on your Mac." : "Mac offline. This waits until it is back on.");
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
    c.node.appendChild(row); c.node.appendChild(note);
    return c;
  }

  function render(data) {
    bodyEl.textContent = "";
    var items = data.items || [], filled = data.filled || [];
    statusEl.textContent = items.length || filled.length ? "" : "Nothing waiting in your queue.";
    var c = data.counts || {};
    subEl.textContent = items.length || filled.length ? (c.ready || 0) + " ready to send, " + (c.answer || 0) + " need one answer, " + (c.mac || 0) + " need a click on your Mac, " + (c.site || 0) + " need you on the site" + (filled.length ? ", " + filled.length + " filled tabs wait for your yes." : ".") : "";
    if (c.mac && !data.macOnline) bodyEl.appendChild(el("p", "warn", "Mac offline: the Mac rows wait until it checks in."));
    (data.groups || []).forEach(function (g) {
      var rows = items.filter(function (i) { return i.group === g.id; });
      if (!rows.length) return;
      bodyEl.appendChild(el("h2", "", g.title + " (" + rows.length + ")"));
      if (g.id === "ready") { bodyEl.appendChild(deck(rows)); return; }
      rows.forEach(function (item) { bodyEl.appendChild((g.id === "answer" ? answerCard(item) : plainCard(item, data.macOnline)).node); });
    });
    filledList(filled);
  }

  function filledList(filled) {
    if (!filled.length) return;
    bodyEl.appendChild(el("h2", "", "Claude filled, waiting for your yes (" + filled.length + ")"));
    bodyEl.appendChild(el("p", "hint", "Approve in your Remote Control chat: write the numbers, like \"submit 1, 3 and 5\"."));
    filled.forEach(function (f) {
      var c = el("div", "q");
      c.appendChild(el("span", "t big", f.n + ". " + f.company + " - " + f.title));
      if (f.link) { var a = el("a", "go", "Open the filled tab"); a.href = f.link; a.target = "_blank"; a.rel = "noopener noreferrer"; c.appendChild(a); }
      c.appendChild(el("p", "note", f.blanks.length ? "Blanks left: " + f.blanks.join(", ") : "No blanks left."));
      bodyEl.appendChild(c);
    });
  }

  if (!initData) { statusEl.textContent = "Open this from the queue button in Telegram."; return; }
  call("/apply/api/queue", "GET").then(function (r) {
    if (r.status !== 200) { statusEl.textContent = "Could not sign you in. Open this from the bot in Telegram."; return; }
    return r.json().then(render);
  }, function () { statusEl.textContent = "Network error. Reopen this page."; });
})();`;
