/**
 * Hand-off panel HTML: every row present with a Copy button, everything escaped, the Workday line, the files.
 */

import { describe, expect, it } from "vitest";
import { renderHandoffPanel, renderHandoffShell, type HandoffModel } from "../../../src/gateway/apply-handoff-page.js";
import type { HandoffRow } from "../../../src/tools/jobhunt/handoff-rows.js";

const rows: HandoffRow[] = [
  { id: "r0", group: "About you", label: "First name", value: "Ada" },
  { id: "r1", group: "About you", label: "Email", value: "ada@example.test" },
  { id: "r2", group: "Your saved answers", label: "Why us?", value: "Line one\nLine two" },
  { id: "r3", group: "Cover letter", label: "Cover letter for Acme", value: "Dear team," },
];

const model: HandoffModel = {
  company: "Acme", title: "Support Engineer", jobUrl: "https://jobs.example.test/acme/1", rows, hasCv: true, hasLetterPdf: true,
};

describe("renderHandoffPanel", () => {
  it("leads with a big link to the company's form that opens safely", () => {
    const html = renderHandoffPanel(model);
    expect(html.indexOf("Open the company's form")).toBeGreaterThan(-1);
    expect(html.indexOf("Open the company's form")).toBeLessThan(html.indexOf("First name"));
    expect(html).toContain(`class="go" href="https://jobs.example.test/acme/1" target="_blank" rel="noopener noreferrer"`);
  });

  it("renders one row per answer, each with its value and a Copy button pointing at that value", () => {
    const html = renderHandoffPanel(model);
    for (const r of rows) {
      expect(html).toContain(`<div class="t">${r.label}</div>`);
      expect(html).toContain(`id="ho-v-${r.id}"`);
      expect(html).toContain(`data-copy="ho-v-${r.id}"`);
    }
    expect((html.match(/class="copy"/g) ?? []).length).toBe(rows.length);
    expect(html).toContain("<h2>About you</h2>");
    expect(html).toContain("<h2>Cover letter</h2>");
  });

  it("escapes every label and value, the job address and the reason", () => {
    const evil = `<img src=x onerror=alert(1)>"'&`;
    const html = renderHandoffPanel({
      ...model,
      jobUrl: `https://jobs.example.test/?q="><script>alert(1)</script>`,
      reason: evil,
      rows: [{ id: "r0", group: evil, label: evil, value: evil }],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
  });

  it("refuses to link a job address that is not http(s)", () => {
    const html = renderHandoffPanel({ ...model, jobUrl: "javascript:alert(1)" });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('id="ho-open"');
    expect(html).toContain("not a web link");
  });

  it("offers the PDFs that exist and only those", () => {
    expect(renderHandoffPanel(model)).toContain('data-file="cv"');
    expect(renderHandoffPanel(model)).toContain('data-file="letter"');
    const cvOnly = renderHandoffPanel({ ...model, hasLetterPdf: false });
    expect(cvOnly).toContain('data-file="cv"');
    expect(cvOnly).not.toContain('data-file="letter"');
    expect(renderHandoffPanel({ ...model, hasCv: false, hasLetterPdf: false })).not.toContain("data-file");
  });

  it("adds the Workday account line, with the email, only when asked", () => {
    expect(renderHandoffPanel(model)).not.toContain("Workday");
    const html = renderHandoffPanel({ ...model, workdayEmail: "ada@example.test" });
    expect(html).toContain("Workday needs an account per company: sign in or create one with ada@example.test, then paste below");
  });

  it("ends with the I applied button and never contains a form, a submit control or an input", () => {
    const html = renderHandoffPanel(model);
    expect(html).toContain('id="ho-applied"');
    expect(html).toContain("✅ I applied");
    expect(html).not.toMatch(/<form|<input|type="submit"|<textarea/);
  });
});

describe("renderHandoffShell", () => {
  it("carries no personal data, one nonce'd script and the loading line", () => {
    const html = renderHandoffShell({ rowId: "11111111-2222-4333-8444-555555555555", company: "Acme <b>", title: "T" }, "n0nce+/=");
    expect(html).toContain('nonce="n0nce+/="');
    expect(html).toContain('id="ho-body"');
    expect(html).toContain("Acme &lt;b&gt;");
    expect(html).not.toContain("Acme <b>");
    expect(html).not.toContain("ada@example.test");
  });
});
