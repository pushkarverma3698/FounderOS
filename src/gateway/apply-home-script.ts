/**
 * Apply home: the one inline script (nonce in the CSP, see apply-home.ts)
 * =======================================================================
 * Runs inside the Telegram Mini App. Plain fetch() to the same origin with the X-Telegram-Init-Data header:
 *   1. GET /apply/api/jobs: the signed-in profile's queue, one button per job.
 *   2. A tap asks GET /apply/api/job-status/<id>. A ready form has a url, so go there. Otherwise POST
 *      /apply/api/prepare/<id> (202 started, 409 already running), then poll job-status every 2 s.
 *   3. When the status carries a url the page navigates to that row's signed answer page.
 * Server text goes in through textContent only, never innerHTML.
 */

export const APPLY_HOME_SCRIPT = String.raw`(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : "";
  var listEl = document.getElementById("jobs");
  var msgEl = document.getElementById("msg");
  if (!listEl || !msgEl) return;
  if (tg) { tg.ready(); tg.expand(); }
  var STATE_TEXT = { preparing: "filling the form...", ready: "ready to review", blocked: "needs your answers", submitting: "submitting...", refilling: "re-filling...", unconfirmed: "check your email", confirmed: "sent", cancelled: "cancelled", idle: "" };
  var MAX_POLLS = 300;
  var timer = 0;
  var buttons = [];

  function say(text) { msgEl.textContent = text; }
  function api(method, path) {
    return fetch("/apply/api/" + path, { method: method, headers: { "X-Telegram-Init-Data": initData } }).then(function (r) {
      return r.json().then(function (j) { return { code: r.status, data: j }; }, function () { return { code: r.status, data: {} }; });
    });
  }
  function lock(on) { for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on; }
  function go(url) { say("Opening the form..."); location.href = url; }
  function fail(text) { clearInterval(timer); say(text); lock(false); }

  function poll(id) {
    var n = 0;
    clearInterval(timer);
    timer = setInterval(function () {
      n += 1;
      if (n > MAX_POLLS) { fail("Still working. Check the Telegram chat, then reopen this list."); return; }
      api("GET", "job-status/" + id).then(function (r) {
        if (r.code !== 200) { fail("Could not read the status. Reopen this list."); return; }
        var s = r.data;
        if (s.url) { clearInterval(timer); go(s.url); return; }
        if (s.state === "failed") { fail(s.detail || "The form could not be prepared."); return; }
        say(s.detail || STATE_TEXT[s.state] || "Working...");
      }, function () { fail("Network error. Reopen this list."); });
    }, 2000);
  }

  function pick(item) {
    lock(true);
    say("Checking " + item.company + "...");
    api("GET", "job-status/" + item.id).then(function (r) {
      if (r.code !== 200) { fail("Could not start. Reopen this list from Telegram."); return; }
      if (r.data.url) { go(r.data.url); return; }
      if (r.data.state === "preparing") { say(r.data.detail || "Filling the form..."); poll(item.id); return; }
      return api("POST", "prepare/" + item.id).then(function (p) {
        if (p.code === 202 || p.code === 409) { say("Opening " + item.company + "'s form and filling it. This takes about a minute."); poll(item.id); }
        else fail("Could not start. Reopen this list from Telegram.");
      });
    }, function () { fail("Network error. Reopen this list."); });
  }

  function render(items) {
    listEl.textContent = "";
    buttons = [];
    items.forEach(function (item) {
      var li = document.createElement("li");
      var b = document.createElement("button");
      b.type = "button";
      var co = document.createElement("span");
      co.className = "co";
      co.textContent = (item.rank ? item.rank + ". " : "") + item.company;
      var title = document.createElement("span");
      title.textContent = item.title;
      var st = document.createElement("span");
      st.className = "st";
      st.textContent = STATE_TEXT[item.state] || "";
      b.appendChild(co);
      b.appendChild(document.createElement("br"));
      b.appendChild(title);
      b.appendChild(st);
      b.addEventListener("click", function () { pick(item); });
      li.appendChild(b);
      listEl.appendChild(li);
      buttons.push(b);
    });
  }

  if (!initData) { say("Open this page from the bot in Telegram: send /apply."); return; }
  api("GET", "jobs").then(function (r) {
    if (r.code !== 200) { say("Could not sign you in. Open this page from the bot in Telegram: send /apply."); return; }
    var items = r.data.jobs || [];
    say(items.length ? "" : "Nothing waiting in your queue.");
    render(items);
  }, function () { say("Network error. Reopen this list."); });
})();`;
