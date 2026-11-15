/**
 * Answer-bank page: the static shell for GET /apply/questions. Same CSP, headers and styles as the saved-answers
 * editor (profile-page.ts); the one inline script loads GET /apply/api/questions with initData in a header and
 * writes server text through textContent and .value only, never innerHTML.
 */

import { escapeHtml } from "./apply-page.js";
import { PROFILE_PAGE_CSS } from "./profile-page.js";

export { profileHeaders as questionsHeaders } from "./profile-page.js";

export const QUESTIONS_PAGE_SCRIPT = String.raw`(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : "";
  var root = document.getElementById("root");
  var msg = document.getElementById("msg");
  var who = document.getElementById("who");
  var api = location.pathname.replace(/\/+$/, "").replace(/\/questions$/, "/api/questions");
  var state = null;
  if (tg) { tg.ready(); tg.expand(); }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function flash(text, bad) { msg.hidden = false; msg.className = bad ? "bad" : "ok"; msg.textContent = text; }
  function call(method, body) {
    var h = { "X-Telegram-Init-Data": initData };
    if (body) h["Content-Type"] = "application/json";
    return fetch(api, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().then(function (j) { return { code: r.status, data: j }; }, function () { return { code: r.status, data: {} }; });
    });
  }
  function blocks(n) { return "Blocks " + n + (n === 1 ? " role" : " roles"); }

  function card(q) {
    var c = el("div", "card");
    c.appendChild(el("span", "t", q.label));
    c.appendChild(el("p", "hint", blocks(q.roles)));
    if (q.template) { c.appendChild(el("p", "hint", "Names the company, so it is answered on each form and never saved here.")); return c; }
    var ta = el("textarea");
    var err = el("p", "err");
    var save = el("button", "", "Save");
    var row = el("div", "row");
    row.appendChild(save);
    c.appendChild(ta); c.appendChild(err); c.appendChild(row);
    save.onclick = function () {
      err.textContent = ""; save.disabled = true;
      call("POST", { question: q.label, answer: ta.value, baseVersion: state.version }).then(function (r) {
        save.disabled = false;
        if (r.code === 200) { state = r.data.state; draw(); flash("Saved. The next prepare pass fills it.", false); return; }
        if (r.code === 409 && r.data.state) { state = r.data.state; draw(); flash(r.data.error, true); return; }
        err.textContent = (r.data && r.data.error) || "Could not save (" + r.code + ").";
      }, function () { save.disabled = false; err.textContent = "Could not reach the server. Nothing was saved."; });
    };
    return c;
  }

  function draw() {
    root.textContent = "";
    who.textContent = state.summary + " for " + state.candidateName;
    state.questions.forEach(function (q) { root.appendChild(card(q)); });
    if (state.more > 0) root.appendChild(el("p", "sub", state.more + " more not shown. Answer these and reopen."));
    if (state.profileFields.length) {
      root.appendChild(el("h2", "", "Answer in /profile"));
      var c = el("div", "card");
      var ul = el("ul", "facts");
      state.profileFields.forEach(function (f) { ul.appendChild(el("li", "", f.label + " (" + f.roles + ")")); });
      c.appendChild(ul);
      root.appendChild(c);
    }
  }

  if (!initData) { who.textContent = "Open this page from Telegram (/questions)."; return; }
  call("GET").then(function (r) {
    if (r.code === 200) { state = r.data; draw(); return; }
    who.textContent = r.code === 404 ? "This page only opens from the bot for a signed-in user. Send /questions in Telegram." : "Could not load the questions (" + r.code + ").";
  }, function () { who.textContent = "Could not reach the server. Reload the page."; });
})();`;

const TELEGRAM_SCRIPT = "https://telegram.org/js/telegram-web-app.js";

export function renderQuestionsPage(nonce: string): string {
  const n = escapeHtml(nonce);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">` +
    `<title>Open questions</title><style>${PROFILE_PAGE_CSS}</style></head><body><main>` +
    `<h1>Open questions</h1><p class="sub" id="who">Loading</p><div id="msg" role="status" hidden></div><div id="root"></div>` +
    `</main><script nonce="${n}" src="${TELEGRAM_SCRIPT}"></script>` +
    `<script nonce="${n}">${QUESTIONS_PAGE_SCRIPT}</script></body></html>`
  );
}
