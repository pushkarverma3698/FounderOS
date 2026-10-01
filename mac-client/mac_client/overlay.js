// The decision bar: what was filled, what is yours, and the two buttons.
//
// SUBMIT & NEXT presses the EMPLOYER'S OWN submit button. The prototype this
// replaces had that line commented out, so its button recorded an application
// that was never sent — every job it "applied" to was still open and the ledger
// said otherwise. The click order below is deliberate: submit first, and only
// report the outcome once the page has accepted it.
//
// Runs as a page function with a single argument (Playwright's page.evaluate
// contract), so everything it needs is on `data`.
(data) => {
  const EXISTING = document.getElementById("founderos-bar");
  if (EXISTING) EXISTING.remove();

  const bar = document.createElement("div");
  bar.id = "founderos-bar";
  bar.style.cssText = [
    "position:fixed", "left:0", "right:0", "bottom:0", "z-index:2147483647",
    "background:#101418", "color:#fff", "padding:14px 20px",
    "font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "display:flex", "align-items:center", "gap:16px",
    "box-shadow:0 -8px 24px rgba(0,0,0,.45)",
  ].join(";");

  const summary = document.createElement("div");
  summary.style.cssText = "flex:1;min-width:0";
  const filled = data.filled.length ? data.filled.join(", ") : "nothing";
  const skipped = data.skipped.length ? data.skipped.join("; ") : "nothing";
  const coverLetterLine = data.cover_letter_copied
    ? `<div style="opacity:.75;font-size:13px;color:#8FD19E">📋 Cover letter copied to clipboard</div>`
    : `<div style="opacity:.75;font-size:13px;color:#FFCC66">No cover letter yet — ask the bot to draft one for ${escapeHtml(data.company)}</div>`;
  // THE SILENT SUBSTITUTION this line exists to stop: the generic resume
  // uploads fine and looks identical to a real tailored one unless this says
  // otherwise — right where the founder is about to press SUBMIT.
  //
  // THREE states, not two. Measured against the real queue 2026-08-25: only 4
  // of 62 rows carried a tailored CV. Warning only on the promised-then-missing
  // case (red) would have left the other 58 silently generic — the same defect
  // in a different shape. What he needs to know is which CV is attached.
  const resumeLine = data.tailored_cv_missing
    ? `<div style="font-size:13px;color:#FF6B6B">⚠️ Generic CV — the tailored one for this role FAILED to download</div>`
    : data.uses_tailored_cv
      ? `<div style="opacity:.75;font-size:13px;color:#8FD19E">📄 Tailored CV for this role attached</div>`
      : `<div style="font-size:13px;color:#FFCC66">📄 Generic CV — no tailored one exists for this role yet</div>`;
  const heading =
    `<div style="font-weight:600;margin-bottom:2px">${data.position} — ` +
    `${escapeHtml(data.company)} · ${escapeHtml(data.title)}</div>`;
  // `data.ask` is set when the host carried this bar onto a page that REPLACED the
  // form (a submit that navigated): what was filled is no longer on screen, so
  // the fill report would describe a page she cannot see.
  summary.innerHTML = data.ask
    ? heading +
      `<div style="opacity:.75;font-size:13px">The page changed after you pressed SUBMIT &amp; NEXT, ` +
      `so what I filled is no longer on screen.</div>`
    : heading +
      `<div style="opacity:.75;font-size:13px">Filled: ${escapeHtml(filled)}</div>` +
      `<div style="opacity:.75;font-size:13px;color:#FFCC66">Left for you: ${escapeHtml(skipped)}</div>` +
      coverLetterLine +
      resumeLine;

  const skip = button("SKIP", "#2A2F36", "#fff");
  const submit = button("SUBMIT &amp; NEXT →", "#00A65A", "#fff");

  // The confirm bar. Shown when the page gave no sign either way after SUBMIT:
  // the founder says what she saw, and only her YES is written as "applied".
  const confirmSummary = document.createElement("div");
  confirmSummary.style.cssText = "flex:1;min-width:0";
  const no = button("NO, IT DID NOT", "#2A2F36", "#fff");
  const yes = button("YES, IT WENT THROUGH", "#00A65A", "#fff");
  let answered = false;

  // The manual path. When the overlay could not press the employer's button (or
  // the founder pressed it herself), she says so and only THEN is it recorded:
  // an explicit human confirmation. Offered once something has gone wrong, and
  // from the start on a bar restored after the page changed (data.manual).
  const mine = button("I SUBMITTED IT MYSELF", "#8A6D3B", "#fff");
  let showManual = !!data.manual;

  // A decision is final and both buttons are disabled the moment either is
  // pressed. A double-click on a slow form would otherwise submit twice.
  let decided = false;

  mine.onclick = async () => {
    if (decided) return;
    decided = true;
    mine.disabled = true;
    skip.disabled = true;
    submit.disabled = true;
    mine.textContent = "Recording…";
    await window.founderosDecision("applied");
  };

  skip.onclick = async () => {
    if (decided) return;
    decided = true;
    lock("Skipping…");
    await window.founderosDecision("skipped");
  };

  submit.onclick = async () => {
    if (decided) return;
    decided = true;
    lock("Submitting…");

    // A form that navigates replaces this page, and this bar with it, before the
    // checks below can report anything. So the host is told FIRST that she pressed
    // SUBMIT & NEXT: if the page is replaced it asks her on the new page, instead
    // of waiting for a decision that can no longer arrive. It only ever asks.
    await tellHost("submit-attempted");

    const target =
      document.querySelector('button[type="submit"]:not([disabled])') ||
      document.querySelector('input[type="submit"]:not([disabled])') ||
      findByText();

    if (!target) {
      // Never record an application we could not send. The founder finishes
      // this one by hand; saying so is the only honest option.
      giveBack(
        "Could not find this form's submit button. Submit it yourself, then press " +
          "I SUBMITTED IT MYSELF to record it. SKIP removes this row from your list: " +
          "it does not come back tomorrow.",
      );
      return;
    }

    // ADR-018: a form the browser itself would refuse to submit is never
    // clicked. The founder finishes it — a guessed answer here is worse than
    // no answer.
    const form = target.closest("form");
    if (form && !form.checkValidity()) {
      const invalidNames = [...form.querySelectorAll(":invalid")]
        .map((el) => el.name || el.id || el.placeholder || "a field")
        .join(", ");
      giveBack(`This form needs ${escapeHtml(invalidNames)} before it can be submitted.`);
      return;
    }

    // A submission we can neither confirm nor rule out is left unconfirmed,
    // never defaulted to "applied" (ADR-018). Two independent alarms:
    //   - a JS alert/confirm/prompt is how many forms surface "fix this field"
    //     synchronously, and would otherwise hang the automation waiting on a
    //     native dialog, so it is intercepted rather than left to block.
    //   - new page text matching an error pattern that was NOT present before
    //     the click — diffed against a pre-click snapshot so boilerplate copy
    //     that happens to contain the word "error" elsewhere on the page never
    //     produces a false alarm.
    let dialogSeen = false;
    const originalAlert = window.alert;
    const originalConfirm = window.confirm;
    const originalPrompt = window.prompt;
    window.alert = () => {
      dialogSeen = true;
    };
    window.confirm = () => {
      dialogSeen = true;
      return false;
    };
    window.prompt = () => {
      dialogSeen = true;
      return null;
    };

    const beforeText = document.body.innerText.toLowerCase();
    const startUrl = window.location.href;
    const startTime = Date.now();
    // Matches the original flat 1200ms wait in the worst case (no signal seen
    // at all) — verification must not make the common, error-free path any
    // slower than the version it replaces.
    const settleMs = 1200;

    const countOccurrences = (str, word) => {
      let count = 0;
      let pos = 0;
      while (true) {
        pos = str.indexOf(word, pos);
        if (pos >= 0) {
          count++;
          pos += word.length;
        } else break;
      }
      return count;
    };

    const failureSignal = () => {
      if (dialogSeen) return "a dialog appeared after submitting";
      
      const after = document.body.innerText.toLowerCase();
      const failWords = ["error", "required", "please fill", "please enter", "invalid", "try again", "already associated", "failed"];
      
      const hit = failWords.find((w) => countOccurrences(after, w) > countOccurrences(beforeText, w));
      return hit ? `the page said: "${escapeHtml(excerptAround(after, hit))}"` : null;
    };

    const successSignal = () => {
      if (window.location.href !== startUrl && !window.location.href.includes("#")) return true;
      
      const after = document.body.innerText.toLowerCase();
      const okWords = ["thank you", "application received", "application submitted", "successfully submitted"];
      
      if (okWords.some((w) => countOccurrences(after, w) > countOccurrences(beforeText, w))) return true;
      
      if (!document.body.contains(target)) return true;
      return false;
    };

    const restoreDialogs = () => {
      window.alert = originalAlert;
      window.confirm = originalConfirm;
      window.prompt = originalPrompt;
    };

    target.click();

    const poll = () => {
      const failed = failureSignal();
      if (failed) {
        restoreDialogs();
        giveBack(`This form was not submitted — ${failed}. Fix it and press SUBMIT again.`);
        return;
      }
      if (successSignal()) {
        restoreDialogs();
        window.founderosDecision("applied");
        return;
      }
      if (Date.now() - startTime > settleMs) {
        // No failure and no success either. That is NOT "applied": a handler
        // that ran clean and one that silently did nothing look identical from
        // here (ADR-018: never defaulted to "applied"). Ask the founder.
        restoreDialogs();
        askDidItGoThrough("The page gave no sign either way, so I cannot tell whether it was sent.");
        return;
      }
      setTimeout(poll, 100);
    };
    setTimeout(poll, 100);
  };

  function askDidItGoThrough(reason) {
    answered = false;
    yes.disabled = false;
    no.disabled = false;
    yes.innerHTML = "YES, IT WENT THROUGH";
    confirmSummary.innerHTML =
      heading +
      `<div style="font-size:13px;color:#FFCC66">${reason}</div>` +
      `<div style="font-size:14px">Did the application go through? Press YES only if you saw the site accept it.</div>`;
    bar.replaceChildren(confirmSummary, no, yes);
  }

  // The founder's own explicit confirmation: the only other place "applied" is written.
  yes.onclick = async () => {
    if (answered) return;
    answered = true;
    yes.disabled = true;
    no.disabled = true;
    yes.textContent = "Recording…";
    await window.founderosDecision("applied");
  };

  no.onclick = () => {
    if (answered) return;
    answered = true;
    tellHost("answered-no"); // so the terminal she ran this from says nothing was recorded
    giveBack(
      "Not recorded. If it did not go through, fix the form and press SUBMIT again; " +
        "SKIP removes this row from your list.",
    );
  };

  function giveBack(message) {
    decided = false;
    showManual = true;
    mine.disabled = false;
    submit.disabled = false;
    skip.disabled = false;
    submit.innerHTML = "SUBMIT &amp; NEXT →";
    summary.innerHTML += `<div style="color:#FF6B6B;font-size:13px">${message}</div>`;
    showDecisionBar();
  }

  // The decision bar: SKIP, the manual button once it applies, and SUBMIT & NEXT.
  function showDecisionBar() {
    bar.replaceChildren(...[summary, skip, showManual ? mine : null, submit].filter(Boolean));
  }

  // What the overlay tells the host app (apply.py), as opposed to what she DECIDES
  // (`founderosDecision`): these only ever lead to a question or a log line, never
  // to an outcome. Optional: the overlay works without a listener on the other end.
  async function tellHost(kind) {
    try {
      if (typeof window.founderosEvent === "function") await window.founderosEvent(kind);
    } catch (_) {
      // The host going away must not stop her pressing the employer's button.
    }
  }

  function excerptAround(text, word) {
    const idx = text.indexOf(word);
    return text.slice(Math.max(0, idx - 10), idx + word.length + 30).trim();
  }

  function lock(label) {
    submit.disabled = true;
    skip.disabled = true;
    submit.textContent = label;
    submit.style.background = "#8A6D3B";
  }

  function findByText() {
    const words = ["submit application", "submit", "apply now", "send application"];
    const clickable = [...document.querySelectorAll("button,input[type=button],a[role=button]")];
    return clickable.find((el) => {
      if (el.disabled) return false;
      const text = (el.innerText || el.value || "").trim().toLowerCase();
      return words.some((w) => text === w || text.startsWith(w));
    });
  }

  function button(label, background, colour) {
    const el = document.createElement("button");
    el.innerHTML = label;
    el.style.cssText = [
      `background:${background}`, `color:${colour}`, "border:0", "border-radius:10px",
      "padding:13px 22px", "font-size:15px", "font-weight:700", "cursor:pointer",
      "white-space:nowrap",
    ].join(";");
    return el;
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value);
    return div.innerHTML;
  }

  // On a page the host carried the bar to after a submit navigated, the first thing
  // she sees is the question; everywhere else, the decision buttons.
  if (data.ask) askDidItGoThrough(escapeHtml(data.ask));
  else showDecisionBar();
  document.body.appendChild(bar);
  // Job pages are long; the bar is fixed, but the page must not sit under it.
  // Computed from the real rendered height (not a fixed guess) so it stays
  // correct regardless of how many status lines or how long the company/title/
  // skipped-list text is — a fixed number clipped real content the moment this
  // bar grew past what it was sized for.
  document.body.style.paddingBottom = `${bar.getBoundingClientRect().height + 16}px`;
};
