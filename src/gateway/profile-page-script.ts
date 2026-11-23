/**
 * Saved-answers editor: the one inline script (nonce in the CSP, see profile-page.ts)
 * ===================================================================================
 * Runs inside the Telegram Mini App. Reads Telegram.WebApp.initData, loads GET /apply/api/profile with it in
 * the X-Telegram-Init-Data header, and builds the editor. Every edit is a POST of one op plus the `version`
 * the page loaded; a 409 swaps in the latest answers and says so. Server text goes in through textContent and
 * .value only, never innerHTML. The viewer blocks confirm() and alert(), so Delete and Restore confirm in page.
 */

export const PROFILE_PAGE_SCRIPT = String.raw`(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : "";
  var root = document.getElementById("root");
  var msg = document.getElementById("msg");
  var who = document.getElementById("who");
  var api = location.pathname.replace(/\/+$/, "").replace(/\/profile$/, "/api/profile");
  var state = null;

  if (tg) { tg.ready(); tg.expand(); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function flash(text, bad) {
    msg.hidden = false;
    msg.className = bad ? "bad" : "ok";
    msg.textContent = text;
    if (!bad) window.scrollTo(0, 0);
  }
  function call(method, body) {
    var h = { "X-Telegram-Init-Data": initData };
    if (body) h["Content-Type"] = "application/json";
    return fetch(api, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().then(function (j) { return { code: r.status, data: j }; }, function () { return { code: r.status, data: {} }; });
    });
  }
  function send(op, err, buttons) {
    op.baseVersion = state.version;
    err.textContent = "";
    buttons.forEach(function (b) { b.disabled = true; });
    call("POST", op).then(function (r) {
      buttons.forEach(function (b) { b.disabled = false; });
      if (r.code === 200) { state = r.data.state; draw(); flash("Saved: " + r.data.summary, false); return; }
      if (r.code === 409 && r.data.state) { state = r.data.state; draw(); flash(r.data.error, true); return; }
      err.textContent = (r.data && r.data.error) || "Could not save (" + r.code + ").";
    }, function () {
      buttons.forEach(function (b) { b.disabled = false; });
      err.textContent = "Could not reach the server. Nothing was saved.";
    });
  }
  function title(card, text) { card.appendChild(el("span", "t", text)); }

  function fieldCard(f, hint) {
    var card = el("div", "card");
    title(card, f.label);
    var input;
    if (f.options) {
      input = el("select");
      var opts = f.options.slice();
      if (opts.indexOf(f.value) < 0) opts.unshift("");
      opts.forEach(function (o) {
        var op = el("option", "", o === "" ? "(not set)" : o);
        op.value = o;
        input.appendChild(op);
      });
    } else {
      input = el("input");
      input.type = "text";
      if (f.kind === "number") input.inputMode = "decimal";
    }
    input.value = f.value;
    card.appendChild(input);
    if (hint) card.appendChild(el("p", "hint", hint));
    var err = el("p", "err");
    var save = el("button", "", "Save");
    var row = el("div", "row");
    row.appendChild(save);
    card.appendChild(err);
    card.appendChild(row);
    save.onclick = function () { send({ op: "setCore", field: f.field, value: input.value }, err, [save]); };
    return card;
  }

  function learnedCard(l) {
    var card = el("div", "card");
    title(card, l.question);
    var ta = el("textarea");
    ta.value = l.answer;
    card.appendChild(ta);
    var err = el("p", "err");
    var save = el("button", "", "Save");
    var del = el("button", "alt", "Delete");
    var row = el("div", "row");
    row.appendChild(save);
    row.appendChild(del);
    var ask = el("div", "row");
    ask.hidden = true;
    var yes = el("button", "danger", "Yes, delete");
    var keep = el("button", "alt", "Keep it");
    ask.appendChild(yes);
    ask.appendChild(keep);
    card.appendChild(err);
    card.appendChild(row);
    card.appendChild(ask);
    save.onclick = function () { send({ op: "upsertLearned", question: l.question, answer: ta.value }, err, [save, del]); };
    del.onclick = function () { err.textContent = "Delete this saved answer?"; row.hidden = true; ask.hidden = false; };
    keep.onclick = function () { err.textContent = ""; ask.hidden = true; row.hidden = false; };
    yes.onclick = function () { send({ op: "deleteLearned", question: l.question }, err, [yes, keep]); };
    return card;
  }

  function addCard() {
    var card = el("div", "card");
    title(card, "Add answer");
    var q = el("input");
    q.type = "text";
    q.placeholder = "Question, as the form words it";
    var a = el("textarea");
    a.placeholder = "Your answer";
    var err = el("p", "err");
    var add = el("button", "", "Add answer");
    var row = el("div", "row");
    row.appendChild(add);
    card.appendChild(q);
    card.appendChild(a);
    card.appendChild(err);
    card.appendChild(row);
    add.onclick = function () { send({ op: "upsertLearned", question: q.value, answer: a.value }, err, [add]); };
    return card;
  }

  function when(id) {
    var iso = id.replace(/^(.*T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
    var d = new Date(iso);
    return isNaN(d.getTime()) ? id : d.toLocaleString();
  }
  function backupCard(b) {
    var card = el("div", "card");
    title(card, when(b.id));
    var err = el("p", "err");
    var restore = el("button", "alt", "Restore this");
    var row = el("div", "row");
    row.appendChild(restore);
    var ask = el("div", "row");
    ask.hidden = true;
    var yes = el("button", "danger", "Yes, restore");
    var no = el("button", "alt", "Cancel");
    ask.appendChild(yes);
    ask.appendChild(no);
    card.appendChild(err);
    card.appendChild(row);
    card.appendChild(ask);
    restore.onclick = function () { err.textContent = "Replace your current answers with this backup? The current ones are backed up first."; row.hidden = true; ask.hidden = false; };
    no.onclick = function () { err.textContent = ""; ask.hidden = true; row.hidden = false; };
    yes.onclick = function () { send({ op: "restore", backupId: b.id }, err, [yes, no]); };
    return card;
  }

  function factSheet(fs) {
    var done = fs.status.filter(function (s) { return s.filled; }).length;
    heading("Fact sheet (" + done + " of " + fs.status.length + " filled)");
    root.appendChild(el("p", "sub", "Fill these once. Forms use them as your own answers. Core answers and self-identification are edited above."));
    var card = el("div", "card");
    var ul = el("ul", "facts");
    fs.status.forEach(function (s) {
      var where = s.home === "answers" ? " (edit under Core answers)" : "";
      ul.appendChild(el("li", "", (s.filled ? "\u2713 " : "\u25CB ") + s.label + where));
    });
    card.appendChild(ul);
    root.appendChild(card);
    fs.fields.forEach(function (f) {
      var c = fieldCard({ label: f.label, field: f.key, value: f.value, kind: "text" }, "");
      var save = c.querySelector("button");
      var input = c.querySelector("input");
      var err = c.querySelector(".err");
      save.onclick = function () { send({ op: "setFact", key: f.key, value: input.value }, err, [save]); };
      root.appendChild(c);
    });
    fs.skills.forEach(function (k) {
      var c = fieldCard({ label: "Years with " + k.skill, field: "", value: k.years, kind: "number" }, "Empty clears it. 0 answers No to yes/no questions.");
      var save = c.querySelector("button");
      var input = c.querySelector("input");
      var err = c.querySelector(".err");
      save.onclick = function () { send({ op: "setFact", key: "skill_years." + slug(k.skill), value: input.value }, err, [save]); };
      root.appendChild(c);
    });
    var add = el("div", "card");
    title(add, "Add a skill");
    var name = el("input");
    name.type = "text";
    name.placeholder = "Skill, like Python";
    var yrs = el("input");
    yrs.type = "text";
    yrs.inputMode = "decimal";
    yrs.placeholder = "Years, like 5";
    var err2 = el("p", "err");
    var btn = el("button", "", "Add skill");
    var row = el("div", "row");
    row.appendChild(btn);
    [name, yrs, err2, row].forEach(function (n) { add.appendChild(n); });
    btn.onclick = function () {
      var s = slug(name.value);
      if (!s) { err2.textContent = "Type the skill name."; return; }
      send({ op: "setFact", key: "skill_years." + s, value: yrs.value }, err2, [btn]);
    };
    root.appendChild(add);
  }
  function slug(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }

  function heading(text) { root.appendChild(el("h2", "", text)); }

  function draw() {
    root.textContent = "";
    who.textContent = "Answers for " + state.candidateName;
    if (state.broken) {
      var warn = el("div", "card");
      warn.appendChild(el("p", "err", "The saved answers file cannot be read: " + state.broken + ". Restore a backup below."));
      root.appendChild(warn);
    }
    if (state.core.length) { heading("Core answers"); state.core.forEach(function (f) { root.appendChild(fieldCard(f, f.field === "notice_period_days" ? "While the detail below is filled in, forms use the detail, not this number." : "")); }); }
    if (state.eeo.length) {
      heading("Voluntary self-identification");
      state.eeo.forEach(function (f) { root.appendChild(fieldCard({ label: f.label, field: f.field, value: f.value, kind: "text" }, "Leave empty to use the form's decline option.")); });
    }
    if (!state.broken && state.factSheet) factSheet(state.factSheet);
    if (!state.broken) {
      heading("Learned answers (" + state.learned.length + ")");
      state.learned.forEach(function (l) { root.appendChild(learnedCard(l)); });
      root.appendChild(addCard());
    }
    if (state.coreFacts.length) {
      heading("What forms read first (Core Facts)");
      var card = el("div", "card");
      var ul = el("ul", "facts");
      state.coreFacts.forEach(function (c) { ul.appendChild(el("li", "", c.label + ": " + c.value)); });
      card.appendChild(ul);
      root.appendChild(card);
    }
    heading("Restore previous");
    if (!state.backups.length) root.appendChild(el("p", "sub", "No backups yet. One is made before every save."));
    state.backups.forEach(function (b) { root.appendChild(backupCard(b)); });
  }

  if (!initData) { who.textContent = "Open this page from Telegram (/profile)."; return; }
  call("GET").then(function (r) {
    if (r.code === 200) { state = r.data; draw(); return; }
    who.textContent = r.code === 404 ? "This page only opens from the bot for a signed-in user. Send /profile in Telegram." : "Could not load your answers (" + r.code + ").";
  }, function () { who.textContent = "Could not reach the server. Reload the page."; });
})();`;
