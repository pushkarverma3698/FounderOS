import { describe, expect, it } from "vitest";
import { markdownToAtsHtml } from "../../../src/tools/jobhunt/cv-renderer.js";

describe("markdownToAtsHtml", () => {
  it("converts headings, paragraphs, and list items to clean ATS-safe HTML", () => {
    const md = `# PUSHKAR VERMA
**AI Engineer**
## SUMMARY
Experienced in **LangGraph** and *TypeScript*.
## SKILLS
- LangGraph
- TypeScript
- PostgreSQL
`;

    const html = markdownToAtsHtml(md);

    expect(html).toContain("<h1>PUSHKAR VERMA</h1>");
    expect(html).toContain("<h2>SUMMARY</h2>");
    expect(html).toContain("<h2>SKILLS</h2>");
    expect(html).toContain("<strong>LangGraph</strong>");
    expect(html).toContain("<em>TypeScript</em>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>LangGraph</li>");
    expect(html).toContain("<li>TypeScript</li>");
    expect(html).toContain("<li>PostgreSQL</li>");
    expect(html).toContain("</ul>");
  });

  it("produces valid single-column HTML document shell", () => {
    const html = markdownToAtsHtml("# TEST");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("font-family: Arial");
    expect(html).toContain("<h1>TEST</h1>");
  });
});
