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
  summary.innerHTML =
    `<div style="font-weight:600;margin-bottom:2px">${data.position} — ` +
    `${escapeHtml(data.company)} · ${escapeHtml(data.title)}</div>` +
    `<div style="opacity:.75;font-size:13px">Filled: ${escapeHtml(filled)}</div>` +
    `<div style="opacity:.75;font-size:13px;color:#FFCC66">Left for you: ${escapeHtml(skipped)}</div>` +
    coverLetterLine;

  const skip = button("SKIP", "#2A2F36", "#fff");
  const submit = button("SUBMIT &amp; NEXT →", "#00A65A", "#fff");

  // A decision is final and both buttons are disabled the moment either is
  // pressed. A double-click on a slow form would otherwise submit twice.
  let decided = false;

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

    const target =
      document.querySelector('button[type="submit"]:not([disabled])') ||
      document.querySelector('input[type="submit"]:not([disabled])') ||
      findByText();

    if (!target) {
      // Never record an application we could not send. The founder finishes
      // this one by hand; saying so is the only honest option.
      giveBack(
        'Could not find this form\'s submit button — submit it yourself, then ' +
          "press SKIP to move on (it is recorded as not-applied, so it will come " +
          "back tomorrow).",
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
        // No failure was seen either — the safest read of a form that gave no
        // visible signal at all is that the employer's handler ran clean.
        restoreDialogs();
        window.founderosDecision("applied");
        return;
      }
      setTimeout(poll, 100);
    };
    setTimeout(poll, 100);
  };

  function giveBack(message) {
    decided = false;
    submit.disabled = false;
    skip.disabled = false;
    submit.innerHTML = "SUBMIT &amp; NEXT →";
    summary.innerHTML += `<div style="color:#FF6B6B;font-size:13px">${message}</div>`;
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

  bar.append(summary, skip, submit);
  document.body.appendChild(bar);
  // Job pages are long; the bar is fixed, but the page must not sit under it.
  // Computed from the real rendered height (not a fixed guess) so it stays
  // correct regardless of how many status lines or how long the company/title/
  // skipped-list text is — a fixed number clipped real content the moment this
  // bar grew past what it was sized for.
  document.body.style.paddingBottom = `${bar.getBoundingClientRect().height + 16}px`;
};
