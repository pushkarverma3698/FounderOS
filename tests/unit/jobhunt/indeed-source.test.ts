/**
 * Unit tests — Indeed source (network mocked).
 *
 * The aggregator's failure modes are different from the ATS feed's, and each one
 * is silent if unhandled: a thin body screens perfectly and produces a verdict
 * from evidence that was never fetched; an expired posting looks like supply;
 * an unpublished output schema means a field rename must degrade to "dropped"
 * rather than throw and take the whole sweep down.
 */

import { describe, it, expect } from "vitest";
import {
  buildIndeedInput,
  buildJobKeyInput,
  buildKeywordQuery,
  mapIndeedItems,
  readJobKeyStatuses,
  MIN_DESCRIPTION_CHARS,
  INDEED_SOURCE,
} from "../../../src/tools/jobhunt/indeed-source.js";

const BODY = "We use TypeScript and Kubernetes. ".repeat(20);

/**
 * The REAL dataset shape, captured from run 0HxG281hj5Ku1hR8Z on 2026-07-31.
 *
 * The first live run mapped 0 of 20 returned rows because the actor nests every
 * field we need — `title.text`, `company.name`, `description.text`,
 * `urls.indeed`, `dates.posted`, `signals.isExpired` — and the mapper was
 * written against guessed flat names while the output schema was unpublished.
 */
const REAL_ITEM = {
  id: "6a00b6bfb4199548",
  title: { text: "Data Engineer – ETL/ELT & Snowflake (Healthcare Data)", normalized: "data engineer" },
  company: { name: "WebSenor InfoTech", key: "e7381a5aff3e1904" },
  description: { text: BODY, html: `<p>${BODY}</p>` },
  // 200 chars — under MIN_DESCRIPTION_CHARS. The real body lives in description.text.
  snippet: "*Job Title:* Data Engineer".padEnd(200, " "),
  urls: {
    indeed: "https://in.indeed.com/viewjob?jk=6a00b6bfb4199548",
    external: "http://in.indeed.com/job/data-engineer-6a00b6bfb4199548",
  },
  location: { formatted: "Noida, Uttar Pradesh", formattedShort: "Noida, Uttar Pradesh" },
  dates: { posted: "2026-07-31", onIndeed: "2026-07-31T18:03:35.249Z", postedToday: true },
  signals: { isExpired: false, isSponsored: false },
};

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    company: "Acme B.V.",
    title: "AI Engineer",
    description: BODY,
    jobKey: "5e5dafc2a80c214d",
    url: "https://nl.indeed.com/viewjob?jk=5e5dafc2a80c214d",
    location: "Amsterdam",
    datePublished: "2026-07-30T09:00:00Z",
    ...overrides,
  };
}

describe("buildKeywordQuery", () => {
  it("restricts matching to the TITLE, not the whole posting", () => {
    // Indeed's plain keyword search is broad by design and returns "Sales
    // Engineer" for "AI Engineer" — which spends the budget on unsalvageable rows.
    const q = buildKeywordQuery(["ai"]);
    expect(q.startsWith("title:(")).toBe(true);
    expect(q).toContain('"AI Engineer"');
    expect(q).toContain(" or ");
  });

  it("strips the ATS prefix wildcard, which Indeed does not understand", () => {
    expect(buildKeywordQuery(["ai"])).not.toContain(":*");
  });

  it("excludes internships, which no permit basis can carry", () => {
    expect(buildKeywordQuery(["backend"])).toContain("-intern");
  });

  it("orders tracks by priority, so the query is byte-stable", () => {
    expect(buildKeywordQuery(["frontend", "ai"])).toBe(buildKeywordQuery(["ai", "frontend"]));
  });
});

describe("buildIndeedInput", () => {
  it("asks for detailed mode — the gates parse the body", () => {
    expect(buildIndeedInput({ country: "NL" })["searchMode"]).toBe("detailed");
  });

  it("sorts by date whenever the remote filter is set", () => {
    // The actor cannot combine `fromDays` with `remote`, so date order plus a
    // client-side age cut is the only way a remote query stays recent.
    const input = buildIndeedInput({ country: "IN", remote: "remote" });
    expect(input["sort"]).toBe("date");
    expect(input["remote"]).toBe("remote");
    expect(input).not.toHaveProperty("fromDays");
  });

  it("is byte-identical for the same query twice", () => {
    const a = buildIndeedInput({ country: "NL", limit: 10, remote: "remote" });
    const b = buildIndeedInput({ country: "NL", limit: 10, remote: "remote" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildJobKeyInput", () => {
  it("passes the keys through and skips the search entirely", () => {
    const input = buildJobKeyInput(["abc", "def"]);
    expect(input["jobKeys"]).toEqual(["abc", "def"]);
    expect(input).not.toHaveProperty("keyword");
  });
});

describe("mapIndeedItems", () => {
  it("maps a well-formed row and keeps the job key for liveness", () => {
    const { postings } = mapIndeedItems([item()]);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.jobKey).toBe("5e5dafc2a80c214d");
    expect(postings[0]!.externalId).toBe("5e5dafc2a80c214d");
    expect(postings[0]!.source).toBe(INDEED_SOURCE);
  });

  it("DROPS a thin body and counts the drop", () => {
    // The failure this exists to prevent: a 200-char teaser screens cleanly and
    // yields "no salary stated" + "language unstated" from text never fetched.
    const { postings, droppedThin } = mapIndeedItems([item({ description: "Great role!" })]);
    expect(postings).toHaveLength(0);
    expect(droppedThin).toBe(1);
  });

  it("keeps a body exactly at the threshold", () => {
    const { postings } = mapIndeedItems([item({ description: "x".repeat(MIN_DESCRIPTION_CHARS) })]);
    expect(postings).toHaveLength(1);
  });

  it("skips a posting the feed already marks expired", () => {
    const { postings, droppedThin } = mapIndeedItems([item({ expired: true })]);
    expect(postings).toHaveLength(0);
    // Not a thin-body drop — an expired row is a different finding.
    expect(droppedThin).toBe(0);
  });

  it("skips malformed rows without throwing", () => {
    const { postings } = mapIndeedItems([null, 42, "nope", {}, { title: "AI Engineer" }, item()]);
    expect(postings).toHaveLength(1);
  });

  it("requires a job key, because without one the row can never be verified", () => {
    const { postings } = mapIndeedItems([item({ jobKey: "", id: "", jobId: "" })]);
    expect(postings).toHaveLength(0);
  });

  it("drops a posting older than maxAgeDays", () => {
    const now = new Date("2026-07-31T00:00:00Z");
    const { postings } = mapIndeedItems(
      [item({ datePublished: "2026-07-01T00:00:00Z" })],
      { maxAgeDays: 3, now },
    );
    expect(postings).toHaveLength(0);
  });

  it("KEEPS a posting with no date at all", () => {
    // An unknown date is not evidence of an old one. Dropping it would be the
    // silent direction — the row disappears and nothing records why.
    const now = new Date("2026-07-31T00:00:00Z");
    const { postings } = mapIndeedItems(
      [item({ datePublished: null, date: null, postedAt: null, pubDate: null })],
      { maxAgeDays: 3, now },
    );
    expect(postings).toHaveLength(1);
    expect(postings[0]!.postedAt).toBeNull();
  });

  it("reads epoch seconds and milliseconds alike", () => {
    const ms = mapIndeedItems([item({ datePublished: 1_785_000_000_000 })]).postings[0]!;
    const s = mapIndeedItems([item({ datePublished: 1_785_000_000 })]).postings[0]!;
    expect(ms.postedAt?.getTime()).toBe(s.postedAt?.getTime());
  });
});

describe("mapIndeedItems — the REAL nested dataset shape", () => {
  it("maps the actor's actual output", () => {
    // Regression for the 2026-07-31 live run: 20 rows returned, 0 mapped.
    const { postings } = mapIndeedItems([REAL_ITEM]);
    expect(postings).toHaveLength(1);
    const p = postings[0]!;
    expect(p.company).toBe("WebSenor InfoTech");
    expect(p.title).toBe("Data Engineer – ETL/ELT & Snowflake (Healthcare Data)");
    expect(p.url).toBe("https://in.indeed.com/viewjob?jk=6a00b6bfb4199548");
    expect(p.location).toBe("Noida, Uttar Pradesh");
    expect(p.jobKey).toBe("6a00b6bfb4199548");
    expect(p.postedAt?.toISOString().slice(0, 10)).toBe("2026-07-31");
  });

  it("reads the FULL body, never the 200-char snippet", () => {
    // snippet passes a naive lookup and is 200 chars — under the threshold. If
    // the mapper preferred it, every Indeed row would drop as thin and the
    // aggregator would look like an empty market instead of a mapping bug.
    const { postings } = mapIndeedItems([REAL_ITEM]);
    expect(postings[0]!.description).toBe(BODY.trim());
    expect(postings[0]!.description.length).toBeGreaterThan(MIN_DESCRIPTION_CHARS);
  });

  it("reads expiry from signals.isExpired", () => {
    const expired = { ...REAL_ITEM, signals: { ...REAL_ITEM.signals, isExpired: true } };
    expect(mapIndeedItems([expired]).postings).toHaveLength(0);
  });

  it("applies the age cut to dates.posted", () => {
    const now = new Date("2026-08-10T00:00:00Z");
    expect(mapIndeedItems([REAL_ITEM], { maxAgeDays: 3, now }).postings).toHaveLength(0);
  });

  it("counts rows it could not map at all, separately from thin ones", () => {
    // returned > 0 with usable == 0 is the shape of a schema change. It must be
    // a reported number, not an empty list that reads as "no jobs today".
    const { postings, droppedThin, droppedUnmappable } = mapIndeedItems([
      { id: "x", title: { text: "" }, company: {} },
      REAL_ITEM,
    ]);
    expect(postings).toHaveLength(1);
    expect(droppedThin).toBe(0);
    expect(droppedUnmappable).toBe(1);
  });
});

describe("readJobKeyStatuses", () => {
  it("reads an explicit expired flag both ways", () => {
    const statuses = readJobKeyStatuses([
      { jobKey: "a", expired: true },
      { jobKey: "b", expired: false },
    ]);
    expect(statuses.get("a")).toBe("expired");
    expect(statuses.get("b")).toBe("live");
  });

  it("treats a MISSING expired field as unverifiable, not as open", () => {
    // "The actor did not report on it" and "the actor reported it is open" are
    // different facts. Only one of them is safe to put in DO TODAY.
    expect(readJobKeyStatuses([{ jobKey: "c" }]).get("c")).toBe("unverifiable");
  });

  it("ignores rows with no key rather than throwing", () => {
    expect(readJobKeyStatuses([{ expired: true }]).size).toBe(0);
  });
});
