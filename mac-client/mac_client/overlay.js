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
  summary.innerHTML =
    `<div style="font-weight:600;margin-bottom:2px">${data.position} — ` +
    `${escapeHtml(data.company)} · ${escapeHtml(data.title)}</div>` +
    `<div style="opacity:.75;font-size:13px">Filled: ${escapeHtml(filled)}</div>` +
    `<div style="opacity:.75;font-size:13px;color:#FFCC66">Left for you: ${escapeHtml(skipped)}</div>`;

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
      decided = false;
      submit.disabled = false;
      skip.disabled = false;
      submit.innerHTML = "SUBMIT &amp; NEXT →";
      summary.innerHTML +=
        '<div style="color:#FF6B6B;font-size:13px">Could not find this form\'s submit ' +
        "button — submit it yourself, then press SKIP to move on (it is recorded as " +
        "not-applied, so it will come back tomorrow).</div>";
      return;
    }

    target.click();

    // Give the page a moment to accept the submission before we navigate away.
    // Poll for a confirmation signal: URL change, success text, or form removal.
    const startUrl = window.location.href;
    const startTime = Date.now();
    const timeoutMs = 5000;
    
    const checkConfirmation = () => {
      if (Date.now() - startTime > timeoutMs) {
        decided = false;
        submit.disabled = false;
        skip.disabled = false;
        submit.innerHTML = "SUBMIT &amp; NEXT →";
        summary.innerHTML +=
          '<div style="color:#FFCC66;font-size:13px;margin-top:4px;">Submit didn\'t confirm automatically. Check the page and press SKIP or SUBMIT again.</div>';
        return;
      }
      
      const currentUrl = window.location.href;
      if (currentUrl !== startUrl && !currentUrl.includes("#")) {
        return window.founderosDecision("applied");
      }
      
      const text = document.body.innerText.toLowerCase();
      if (text.includes("thank you") || text.includes("application received") || text.includes("application submitted")) {
        return window.founderosDecision("applied");
      }
      
      // If the submit button detached from the DOM, it's a good sign the form submitted.
      if (!document.body.contains(target)) {
        return window.founderosDecision("applied");
      }
      
      setTimeout(checkConfirmation, 300);
    };
    
    setTimeout(checkConfirmation, 500);
  };

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
  document.body.style.paddingBottom = "96px";
};
