import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApplySnapshot } from "../../../src/tools/jobhunt/apply-link.js";
import {
  APPLY_PAGE_HEADERS,
  applyPageHeaders,
  applyFieldName,
  renderApplyPage,
  renderNoticePage,
} from "../../../src/gateway/apply-page.js";

const ROW = "11111111-2222-4333-8444-555555555555";
const SQ = String.fromCharCode(39);

type Summary = ApplySnapshot["summary"];
type Filled = Summary["filledAnswers"][number];

function filled(over: Partial<Filled> & Pick<Filled, "label" | "value">): Filled {
  return { fieldType: "text", editable: true, ...over };
}

function snap(over: Partial<Summary> = {}, top: Partial<ApplySnapshot> = {}): ApplySnapshot {
  return {
    rowId: ROW,
    chatId: "4242",
    profileId: "fixture-profile",
    company: "Acme BV",
    title: "Finance Analyst",
    candidateName: "Fixture Person",
    targetUrl: "https://jobs.example.com/acme/123",
    platform: "lever",
    resumePath: "/tmp/fixture-resume.pdf",
    summary: {
      filled: 2,
      total: 5,
      hasCaptcha: false,
      filledLabels: ["Full name", "Email"],
      filledAnswers: [
        { label: "Full name", value: "Fixture Person", fieldType: "text", editable: true },
        { label: "Email", value: "fixture@example.com", fieldType: "text", editable: true },
      ],
      unanswered: [
        { label: "Optional note", required: false, fieldType: "text" },
        { label: "Why Acme?", required: true, fieldType: "textarea" },
        { label: "Work permit", required: true, fieldType: "radio-group", options: ["Yes", "No"] },
      ],
      ...over,
    },
    createdAt: 0,
    ...top,
  };
}

describe("renderApplyPage", () => {
  it("shows company, title, platform and the counts", () => {
    const html = renderApplyPage(snap());
    expect(html).toContain("Acme BV");
    expect(html).toContain("Finance Analyst");
    expect(html).toContain("lever");
    expect(html).toContain("viewport");
    expect(html).toContain("Needs your answer (3)");
    expect(html).toContain("Already filled (2)");
  });

  it("lists required questions before optional ones", () => {
    const html = renderApplyPage(snap());
    expect(html.indexOf("Why Acme?")).toBeGreaterThan(-1);
    expect(html.indexOf("Why Acme?")).toBeLessThan(html.indexOf("Optional note"));
    expect(html.indexOf("Work permit")).toBeLessThan(html.indexOf("Optional note"));
  });

  it("escapes every snapshot string", () => {
    const LT = String.fromCharCode(60);
    const GT = String.fromCharCode(62);
    const evil = `${LT}script${GT}alert(1)${LT}/script${GT}`;
    const evilTitle = `"${GT}${LT}img src=x onerror=1${GT}`;
    const html = renderApplyPage(
      snap(
        {
          filledLabels: [evil],
          filledAnswers: [{ label: evil, value: evil, fieldType: "text", editable: true }],
          unanswered: [
            { label: evil, required: true, fieldType: "select", options: [evil, "a", "b", "c", "d"], triedAnswer: evil },
          ],
        },
        { company: evil, title: evilTitle, platform: evil },
      ),
    );
    expect(html).not.toContain(`${LT}script${GT}alert(1)`);
    expect(html).not.toContain(`${LT}img src=x`);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(`value="&lt;script&gt;alert(1)&lt;/script&gt;"`);
    expect(html.toLowerCase()).not.toContain(`${LT}script`);
  });

  it("picks the input type from the field type and options", () => {
    const many = ["a", "b", "c", "d", "e"];
    const html = renderApplyPage(
      snap({
        unanswered: [
          { label: "Q radio", required: true, fieldType: "radio-group", options: ["Yes", "No"] },
          { label: "Q select", required: true, fieldType: "select", options: many },
          { label: "Q area", required: true, fieldType: "textarea" },
          { label: "Q text", required: true, fieldType: "text" },
          { label: "Q file", required: true, fieldType: "file" },
        ],
      }),
    );
    expect(html).toContain(`type="radio"`);
    expect(html).toContain("select name=");
    expect(html).toContain("textarea name=");
    expect(html).toContain(`type="text"`);
    expect(html).not.toContain(applyFieldName("Q file"));
    expect(html).toContain("cannot be answered here");
  });

  it("names fields by a hash, never by the label or its position", () => {
    const a = applyFieldName("Why Acme?");
    expect(a).toMatch(/^q_[0-9a-f]{16}$/);
    expect(a).toBe(applyFieldName("Why Acme?"));
    expect(a).not.toBe(applyFieldName("Why not?"));
    expect(renderApplyPage(snap())).toContain(`name="${a}"`);
  });

  it("shows the last answer the bot could not fill", () => {
    const html = renderApplyPage(
      snap({ unanswered: [{ label: "Based in NL or IE?", required: true, fieldType: "text", triedAnswer: "Netherlands" }] }),
    );
    expect(html).toContain("could not fill");
    expect(html).toContain("Netherlands");
  });

  it("renders a nothing-left page when every question is answered", () => {
    const html = renderApplyPage(snap({ unanswered: [], filledAnswers: [] }));
    expect(html).toContain("Nothing left to answer");
    expect(html).toContain("tap Submit application at the bottom of the screen");
    expect(html).not.toContain("press Submit in Telegram");
    expect(html).not.toContain("button type=");
  });

  it("has no script, no external resource, no form action, and says it never submits", () => {
    const LT = String.fromCharCode(60);
    const html = renderApplyPage(snap()).toLowerCase();
    for (const tag of ["script", "link", "img", "iframe"]) expect(html).not.toContain(`${LT}${tag}`);
    expect(html).not.toContain("src=");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("action=");
    expect(html).toContain("never submits");
    expect(html).toContain(`method="post"`);
  });
});

describe("renderApplyPage filled answers", () => {
  const LT = String.fromCharCode(60);
  const GT = String.fromCharCode(62);
  const countOf = (html: string, needle: string): number => html.split(needle).length - 1;

  it("shows each filled value as an editable input, in the same form as the questions", () => {
    const html = renderApplyPage(snap());
    const name = applyFieldName("Full name");
    expect(html).toMatch(new RegExp(`${LT}input type="text" name="${name}"[^${GT}]*value="Fixture Person"`));
    expect(html).toContain("Already filled (2)");
    expect(countOf(html, `${LT}form`)).toBe(1);
    expect(html.indexOf("Needs your answer")).toBeLessThan(html.indexOf("Already filled"));
    expect(html.indexOf("Already filled")).toBeLessThan(html.indexOf(`${LT}/form${GT}`));
    expect(html).toContain(`${LT}button type="submit"${GT}`);
  });

  it("escapes a filled label and value in element text, a textarea body and the value attribute", () => {
    const evil = `${LT}script${GT}alert(1)${LT}/script${GT}`;
    const quoteBreak = `" autofocus onfocus="alert(2)`;
    const html = renderApplyPage(
      snap({
        unanswered: [],
        filledAnswers: [
          filled({ label: evil, value: quoteBreak }),
          filled({ label: "Bio", value: evil, fieldType: "textarea" }),
        ],
      }),
    );
    expect(html.toLowerCase()).not.toContain(`${LT}script`);
    expect(html).toContain(`value="&quot; autofocus onfocus=&quot;alert(2)"`);
    expect(html).not.toContain(`" autofocus`);
    expect(html).toContain(`${GT}&lt;script&gt;alert(1)&lt;/script&gt;${LT}/textarea${GT}`);
  });

  it("preselects the current option on radios and on selects", () => {
    const many = ["a", "b", "c", "d", "e"];
    const html = renderApplyPage(
      snap({
        unanswered: [],
        filledAnswers: [
          filled({ label: "Relocate", value: "No", fieldType: "radio-group", options: ["Yes", "No"] }),
          filled({ label: "Region", value: "c", fieldType: "select", options: many }),
        ],
      }),
    );
    expect(html).toMatch(/<input type="radio" name="q_[0-9a-f]{16}" value="No" checked>/);
    expect(html).not.toMatch(/value="Yes" checked/);
    expect(html).toContain(`<option value="c" selected>c</option>`);
    expect(html).not.toContain(`<option value="">Choose</option>`);
  });

  it("shows a file as attached and a non-editable value as plain text, with no input for either", () => {
    const html = renderApplyPage(
      snap({
        unanswered: [],
        filledAnswers: [
          filled({ label: "Resume/CV *", value: "cv-fixture.pdf", fieldType: "file", editable: false }),
          filled({ label: "Passport scan", value: "scan.pdf", fieldType: "file", editable: true }),
          filled({ label: "I agree", value: "Yes", fieldType: "checkbox", editable: false }),
        ],
      }),
    );
    expect(html).toContain("CV attached: cv-fixture.pdf");
    expect(html).toContain("File attached: scan.pdf");
    expect(html).toContain("I agree");
    for (const label of ["Resume/CV *", "Passport scan", "I agree"]) expect(html).not.toContain(applyFieldName(label));
    expect(html).not.toContain(`${LT}form`);
    expect(html).not.toContain("button type=");
  });

  it("offers Save when the only editable things are filled values", () => {
    const html = renderApplyPage(snap({ unanswered: [] }));
    expect(html).toContain("Nothing left to answer");
    expect(html).toContain(`${LT}button type="submit"${GT}`);
    expect(html).toContain(`method="post"`);
  });

  it("lists a label once, and lets an unanswered question keep a name both would use", () => {
    const html = renderApplyPage(
      snap({
        unanswered: [{ label: "Phone", required: true, fieldType: "text" }],
        filledAnswers: [
          filled({ label: "Email", value: "a@example.com" }),
          filled({ label: "Email", value: "b@example.com" }),
          filled({ label: "Phone", value: "+31 6 11111111" }),
        ],
      }),
    );
    expect(countOf(html, `name="${applyFieldName("Email")}"`)).toBe(1);
    expect(html).toContain("a@example.com");
    expect(html).not.toContain("b@example.com");
    expect(countOf(html, `name="${applyFieldName("Phone")}"`)).toBe(1);
    expect(html).not.toContain("+31 6 11111111");
    expect(html).toContain("Already filled (1)");
  });

  it("falls back to the label list for a snapshot saved before filled values existed", () => {
    const html = renderApplyPage(snap({ filledAnswers: [] }));
    expect(html).toContain("Already filled (2)");
    expect(html).toContain("Full name");
    expect(html).not.toContain(`value="Fixture Person"`);
  });

  it("says an edit is remembered for every form that asks the same question", () => {
    expect(renderApplyPage(snap())).toContain("every form that asks the same question");
  });
});

describe("page headers", () => {
  it("sets no-store, no-referrer, noindex and a CSP that matches the inline style", () => {
    const LT = String.fromCharCode(60);
    const GT = String.fromCharCode(62);
    expect(APPLY_PAGE_HEADERS["Cache-Control"]).toBe("no-store");
    expect(APPLY_PAGE_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(APPLY_PAGE_HEADERS["X-Robots-Tag"]).toContain("noindex");
    const csp = APPLY_PAGE_HEADERS["Content-Security-Policy"]!;
    const html = renderApplyPage(snap());
    const open = `${LT}style${GT}`;
    const css = html.slice(html.indexOf(open) + open.length, html.indexOf(`${LT}/style${GT}`));
    const hash = createHash("sha256").update(css).digest("base64");
    expect(csp).toContain(`default-src ${SQ}none${SQ}`);
    expect(csp).toContain(`style-src ${SQ}sha256-${hash}${SQ}`);
    expect(csp).toContain(`form-action ${SQ}self${SQ}`);
    // The card opens this page as a Telegram Mini App; Telegram Web shows it in an iframe on web.telegram.org.
    expect(csp).toContain("frame-ancestors https://web.telegram.org;");
    expect(csp.replace("frame-ancestors https://web.telegram.org;", "")).not.toMatch(/https?:/);
  });

  it("renders a notice page with the same shell and escapes the message", () => {
    const LT = String.fromCharCode(60);
    const GT = String.fromCharCode(62);
    const html = renderNoticePage("Saved", `Saved 2 answers ${LT}b${GT}`);
    expect(html).toContain("Saved");
    expect(html).toContain("Saved 2 answers &lt;b&gt;");
    expect(html.toLowerCase()).not.toContain(`${LT}script`);
  });
});

describe("Mini App panel (nonce variant)", () => {
  const LT = String.fromCharCode(60);
  const NONCE = "abc123nonce==";
  const SCRIPT_SRC = `script-src 'nonce-${NONCE}' https://telegram.org; connect-src 'self'; `;

  it("adds the Telegram script, one inline script with the nonce, the status panel and the page stamp", () => {
    const html = renderApplyPage(snap({}, { createdAt: 1234 }), { nonce: NONCE });
    expect(html).toContain(`${LT}script nonce="${NONCE}" src="https://telegram.org/js/telegram-web-app.js">`);
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).toContain(`data-created="1234"`);
    for (const id of ["mini-status", "mini-confirm", "mini-yes", "mini-cancel", "mini-save", "mini-code", "mini-code-input", "mini-code-send"]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain("alert(");
    expect(html).not.toContain("confirm(");
    expect(html).not.toContain("innerHTML");
  });

  it("the CSP adds only script-src with the nonce and telegram.org, and connect-src self", () => {
    const base = applyPageHeaders()["Content-Security-Policy"]!;
    const withNonce = applyPageHeaders(NONCE)["Content-Security-Policy"]!;
    expect(withNonce).toContain(SCRIPT_SRC);
    expect(withNonce.replace(SCRIPT_SRC, "")).toBe(base);
    expect(base).not.toContain("script-src");
  });

  it("keeps the no-nonce page free of script", () => {
    expect(renderApplyPage(snap()).toLowerCase()).not.toContain(`${LT}script`);
  });
});
