import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApplySnapshot } from "../../../src/tools/jobhunt/apply-link.js";
import {
  APPLY_PAGE_HEADERS,
  applyFieldName,
  renderApplyPage,
  renderNoticePage,
} from "../../../src/gateway/apply-page.js";

const ROW = "11111111-2222-4333-8444-555555555555";
const SQ = String.fromCharCode(39);

type Summary = ApplySnapshot["summary"];

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
    const html = renderApplyPage(snap({ unanswered: [] }));
    expect(html).toContain("Nothing left to answer");
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
    expect(csp).not.toMatch(/https?:/);
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
