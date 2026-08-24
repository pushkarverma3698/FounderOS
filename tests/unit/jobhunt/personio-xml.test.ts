/**
 * Unit tests — the Personio XML feed reader.
 *
 * Fixtures are hand-cut from the live `1komma5grad` feed (2026-08-22) so the
 * suite stays offline and $0. The shapes that matter are the two that can
 * silently produce a WRONG row rather than no row: the `<name>` collision
 * between a job title and a description heading, and CDATA bodies whose content
 * contains markup and ampersands.
 */

import { describe, it, expect } from "vitest";

import {
  parsePersonioPositions,
  unescapeXml,
} from "../../../src/tools/jobhunt/personio-xml.js";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>2749999</id>
    <subcompany>Heartbeat AI GmbH</subcompany>
    <office>Hamburg</office>
    <additionalOffices>
      <office>Remote</office>
      <office>Berlin</office>
    </additionalOffices>
    <department>Customer Service</department>
    <name>Conversational AI Specialist (m/w/d) &amp; Knowledge</name>
    <jobDescriptions>
      <jobDescription>
        <name>Your responsibilities</name>
        <value><![CDATA[<p>Own the <b>bot</b> &amp; its quality.</p>]]></value>
      </jobDescription>
      <jobDescription>
        <name>Your profile</name>
        <value><![CDATA[<ul><li>3+ years of experience</li></ul>]]></value>
      </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>entry-level</seniority>
    <schedule>full-time</schedule>
    <yearsOfExperience>1-2</yearsOfExperience>
    <createdAt>2026-08-11T12:53:30+00:00</createdAt>
  </position>
</workzag-jobs>`;

describe("parsePersonioPositions", () => {
  it("reads the position's own name, not a description heading", () => {
    // The trap: <name> is both the job title and every section's heading. A
    // single regex over the block can title the row "Your responsibilities".
    const [job] = parsePersonioPositions(FEED);
    expect(job?.name).toBe("Conversational AI Specialist (m/w/d) & Knowledge");
  });

  it("reads the position's own office, not one from additionalOffices", () => {
    const [job] = parsePersonioPositions(FEED);
    expect(job?.office).toBe("Hamburg");
    expect(job?.department).toBe("Customer Service");
  });

  it("does not depend on additionalOffices coming after the real office", () => {
    // Today Personio emits <office> before <additionalOffices>. If that order
    // ever flips, taking "the first match" would silently retitle a Hamburg
    // role as Remote — a wrong value, which beats a missing one only in the
    // sense that nothing downstream can detect it.
    const flipped = FEED.replace(
      "<office>Hamburg</office>",
      "",
    ).replace("<department>Customer Service</department>", "<office>Hamburg</office>\n    <department>Customer Service</department>");
    expect(parsePersonioPositions(flipped)[0]?.office).toBe("Hamburg");
  });

  it("carries the fields the gates and the freshness filter read", () => {
    const [job] = parsePersonioPositions(FEED);
    expect(job?.id).toBe("2749999");
    expect(job?.createdAt).toBe("2026-08-11T12:53:30+00:00");
    expect(job?.yearsOfExperience).toBe("1-2");
    expect(job?.seniority).toBe("entry-level");
    expect(job?.employmentType).toBe("permanent");
  });

  it("keeps section headings in the body", () => {
    // Dropping "Your profile" runs responsibilities into qualifications, and the
    // years bar the gates read lives in the second half.
    const [job] = parsePersonioPositions(FEED);
    expect(job?.body).toContain("Your responsibilities");
    expect(job?.body).toContain("Your profile");
    expect(job?.body).toContain("3+ years of experience");
  });

  it("unwraps CDATA without leaking the wrapper", () => {
    const [job] = parsePersonioPositions(FEED);
    expect(job?.body).not.toContain("CDATA");
    expect(job?.body).toContain("<b>bot</b>");
    // Entities inside CDATA are decoded along with everything else — see
    // unescapeXml's note on why that deliberate looseness is safe here.
    expect(job?.body).toContain("Own the <b>bot</b> & its quality.");
  });

  it("skips a position with no id rather than emitting an unlinkable row", () => {
    const noId = FEED.replace("<id>2749999</id>", "");
    expect(parsePersonioPositions(noId)).toHaveLength(0);
  });

  it("is total — malformed or empty input yields fewer rows, never a throw", () => {
    expect(parsePersonioPositions("")).toEqual([]);
    expect(parsePersonioPositions("<workzag-jobs><position>truncated")).toEqual([]);
    expect(parsePersonioPositions("not xml at all")).toEqual([]);
    expect(parsePersonioPositions(undefined as unknown as string)).toEqual([]);
  });

  it("reads every position in a multi-position feed", () => {
    const two = FEED.replace(
      "</workzag-jobs>",
      "<position><id>7</id><name>Second</name></position></workzag-jobs>",
    );
    const rows = parsePersonioPositions(two);
    expect(rows.map((r) => r.id)).toEqual(["2749999", "7"]);
    expect(rows[1]?.name).toBe("Second");
  });
});

describe("unescapeXml", () => {
  it("resolves the predefined entities and numeric references", () => {
    expect(unescapeXml("a &lt;b&gt; &quot;c&quot; &apos;d&apos; &#39;e&#39;")).toBe(
      "a <b> \"c\" 'd' 'e'",
    );
  });

  it("decodes &amp; last so &amp;lt; does not become a real tag", () => {
    expect(unescapeXml("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  });

  it("unwraps CDATA and then decodes what was inside it", () => {
    expect(unescapeXml("<![CDATA[5 &amp; 6 < 7]]>")).toBe("5 & 6 < 7");
  });
});
