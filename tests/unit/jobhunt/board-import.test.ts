/**
 * Unit tests — joining the IND register to published ATS corpora.
 *
 * THE FAILURE THIS GUARDS AGAINST, above all others. `free-ats-mappers.ts` sets
 * `company: candidate.board.name`, so the registry's `name` column IS what
 * `matchSponsor` screens. If the import wrote the IND REGISTERED name there, every
 * posting on a joined board would be an exact register match by construction — a
 * confident `sponsor` verdict manufactured by our own CSV, on a board we matched
 * with a deliberately loose key. That is a manufactured application that cannot
 * lawfully succeed, and it would fail silently. The corpus-name assertion below is
 * the guard; do not relax it.
 */

import { describe, it, expect } from "vitest";
import {
  boardMatchKey,
  buildBoardMatchIndex,
  parseAtsCorpus,
  parseEmployerList,
  joinSponsorBoards,
  joinEmployerBoards,
  isOffMarketToken,
  stripSiteSuffix,
  toBoardCsvRows,
  type AtsCorpusRow,
} from "../../../src/tools/jobhunt/board-import.js";
import type { FreeAts, FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

const corpus = (rows: readonly [string, string][]): AtsCorpusRow[] =>
  rows.map(([name, slug]) => ({ name, slug, url: "" }));

const board = (ats: FreeAts, token: string): FreeBoard => ({
  name: token,
  ats,
  token,
  markets: ["NL"],
});

describe("boardMatchKey", () => {
  it("strips trailing Dutch legal forms", () => {
    expect(boardMatchKey("Mollie B.V.")).toBe("mollie");
    expect(boardMatchKey("Backbase N.V.")).toBe("backbase");
  });

  it("strips foreign legal forms the job feeds actually carry", () => {
    expect(boardMatchKey("SumUp Limited")).toBe("sumup");
    expect(boardMatchKey("Reaktor Ltd")).toBe("reaktor");
    expect(boardMatchKey("Pliant GmbH")).toBe("pliant");
    expect(boardMatchKey("Verkada Inc.")).toBe("verkada");
  });

  it("strips the country and holding words a national register adds", () => {
    // The whole reason this key exists: nine of the highest-value sponsors are
    // lost to a country word alone under the strict sponsor normaliser.
    expect(boardMatchKey("Deliveroo Netherlands B.V.")).toBe("deliveroo");
    expect(boardMatchKey("Samsara Netherlands B.V.")).toBe("samsara");
    expect(boardMatchKey("Flux Groep B.V.")).toBe("flux");
    expect(boardMatchKey("Atlas International B.V.")).toBe("atlas");
  });

  it("strips noise from anywhere in the name, not only the end", () => {
    expect(boardMatchKey("Aleph The Netherlands Corporation B.V.")).toBe("aleph");
  });

  it("keeps a multi-word identity intact", () => {
    expect(boardMatchKey("Brain Corporation B.V.")).toBe("brain");
    expect(boardMatchKey("Beyond Sports B.V.")).toBe("beyond sports");
  });

  it("never reduces an all-noise name to the empty string", () => {
    // Otherwise every all-noise name would collide on "" and match each other.
    expect(boardMatchKey("The Company B.V.")).toBe("the company b v");
    expect(boardMatchKey("Holding Group")).toBe("holding group");
  });

  it("is idempotent", () => {
    const once = boardMatchKey("Deliveroo Netherlands B.V.");
    expect(boardMatchKey(once)).toBe(once);
  });
});

describe("buildBoardMatchIndex", () => {
  it("keeps the first registered name on a key collision", () => {
    const index = buildBoardMatchIndex(["Atlas B.V.", "Atlas International B.V."]);
    expect(index.get("atlas")).toBe("Atlas B.V.");
  });
});

describe("parseAtsCorpus", () => {
  it("parses name,slug,url and drops the header", () => {
    const csv = [
      "name,slug,url",
      "Mollie,mollie,https://jobs.ashbyhq.com/mollie",
      "12Build,12build,https://12build.recruitee.com",
    ].join("\n");

    expect(parseAtsCorpus(csv)).toEqual([
      { name: "Mollie", slug: "mollie", url: "https://jobs.ashbyhq.com/mollie" },
      { name: "12Build", slug: "12build", url: "https://12build.recruitee.com" },
    ]);
  });

  it("honours quoted names containing commas", () => {
    const csv = ['name,slug,url', '"Plaid, B.V.",plaid,https://x'].join("\n");
    expect(parseAtsCorpus(csv)).toEqual([{ name: "Plaid, B.V.", slug: "plaid", url: "https://x" }]);
  });

  it("skips malformed rows instead of throwing", () => {
    // One bad line in a 6,000-row third-party file must not cost the other 5,999.
    const csv = ["name,slug,url", ",noname,https://x", "No Slug,,https://y", "Ok,ok,https://z"].join(
      "\n",
    );
    expect(parseAtsCorpus(csv)).toEqual([{ name: "Ok", slug: "ok", url: "https://z" }]);
  });
});

describe("joinSponsorBoards", () => {
  const sponsors = ["Mollie B.V.", "Deliveroo Netherlands B.V.", "Adyen B.V."];

  it("matches a sponsor whose registered name carries a country word", () => {
    const found = joinSponsorBoards(
      sponsors,
      new Map([["ashby", corpus([["Deliveroo", "deliveroo"]])]]),
      [],
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ats: "ashby",
      token: "deliveroo",
      matchedSponsor: "Deliveroo Netherlands B.V.",
    });
  });

  it("writes the CORPUS company name, never the registered one", () => {
    // The guard described in this file's header. `name` becomes the screened
    // company; the registered name must stay out of it so matchSponsor can reach
    // `uncertain` on its own rather than being handed an exact match.
    const found = joinSponsorBoards(
      sponsors,
      new Map([["ashby", corpus([["Deliveroo", "deliveroo"]])]]),
      [],
    );

    expect(found[0]?.name).toBe("Deliveroo");
    expect(found[0]?.name).not.toBe("Deliveroo Netherlands B.V.");
  });

  it("does not match a longer name that merely contains a sponsor", () => {
    const found = joinSponsorBoards(
      sponsors,
      new Map([["lever", corpus([["Adyen Consulting Group", "adyenconsulting"]])]]),
      [],
    );
    expect(found).toEqual([]);
  });

  it("excludes boards already in the registry, case-insensitively", () => {
    const found = joinSponsorBoards(
      sponsors,
      new Map([["ashby", corpus([["Mollie", "Mollie"]])]]),
      [board("ashby", "mollie")],
    );
    expect(found).toEqual([]);
  });

  it("keeps the same token on two different platforms", () => {
    const found = joinSponsorBoards(
      sponsors,
      new Map<FreeAts, AtsCorpusRow[]>([
        ["ashby", corpus([["Mollie", "mollie"]])],
        ["lever", corpus([["Mollie", "mollie"]])],
      ]),
      [],
    );
    expect(found.map((f) => f.ats)).toEqual(["ashby", "lever"]);
  });

  it("dedupes a token repeated inside one corpus", () => {
    const found = joinSponsorBoards(
      sponsors,
      new Map([["ashby", corpus([["Mollie", "mollie"], ["Mollie B.V.", "mollie"]])]]),
      [],
    );
    expect(found).toHaveLength(1);
  });

  it("returns nothing when no sponsor appears in the corpus", () => {
    const found = joinSponsorBoards(
      sponsors,
      new Map([["ashby", corpus([["Unrelated Startup", "unrelated"]])]]),
      [],
    );
    expect(found).toEqual([]);
  });

  it("derives the Workday token from the URL, not the lossy slug", () => {
    // The corpus's own `slug` column reads "mollie/mollie" and never says which
    // Workday datacenter (wd1, wd3, wd5, wd12 …) the tenant lives on — only the
    // URL does. See board-import.ts:tokenForCorpusRow.
    const found = joinSponsorBoards(
      sponsors,
      new Map([
        [
          "workday",
          [{ name: "Mollie", slug: "mollie/mollie", url: "https://mollie.wd3.myworkdayjobs.com/mollie" }],
        ],
      ]),
      [],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.token).toBe("mollie/wd3/mollie");
  });

  it("drops a Workday row whose URL will not parse, rather than writing a dead token", () => {
    const found = joinSponsorBoards(
      sponsors,
      new Map([["workday", [{ name: "Mollie", slug: "mollie/mollie", url: "not-a-url" }]]]),
      [],
    );
    expect(found).toEqual([]);
  });
});

describe("toBoardCsvRows", () => {
  it("emits registry rows sourced to the NL market", () => {
    const rows = toBoardCsvRows([
      { name: "Mollie", ats: "ashby", token: "mollie", matchedSponsor: "Mollie B.V." },
    ]);
    expect(rows).toEqual(["Mollie,ashby,mollie,NL"]);
  });

  it("quotes a company name containing a comma so the row still parses", () => {
    const rows = toBoardCsvRows([
      { name: "Plaid, B.V.", ats: "ashby", token: "plaid", matchedSponsor: "Plaid, B.V." },
    ]);
    expect(rows).toEqual(['"Plaid, B.V.",ashby,plaid,NL']);
  });

  it("never leaks the matched register entry into the row", () => {
    const rows = toBoardCsvRows([
      {
        name: "Deliveroo",
        ats: "ashby",
        token: "deliveroo",
        matchedSponsor: "Deliveroo Netherlands B.V.",
      },
    ]);
    expect(rows[0]).not.toContain("Netherlands");
  });
});

/**
 * The curated NL finance-employer join.
 *
 * Its whole reason to exist is that the register join above cannot see Dutch
 * finance: the employers who hire FP&A, audit and KYC at 0-4 years are registered
 * under names no ATS board ever writes. These tests pin the two decisions that
 * make the looser source safe — the key stays EXACT, and a tenant's country sites
 * stay distinguishable.
 */
describe("parseEmployerList", () => {
  it("skips the provenance comment block and the header", () => {
    const brands = parseEmployerList(
      "# why this file exists\n# second comment line\nname,sector\nRabobank,bank\nBDO,accountancy\n",
    );
    expect(brands).toEqual([
      { name: "Rabobank", sector: "bank" },
      { name: "BDO", sector: "accountancy" },
    ]);
  });

  it("keeps the first employer when the file has no header at all", () => {
    expect(parseEmployerList("Rabobank,bank\n")).toEqual([{ name: "Rabobank", sector: "bank" }]);
  });

  it("defaults a missing sector rather than dropping the brand", () => {
    expect(parseEmployerList("name,sector\nOhpen\n")).toEqual([
      { name: "Ohpen", sector: "unknown" },
    ]);
  });
});

describe("stripSiteSuffix", () => {
  it("drops the site label Workday appends to a tenant's second board", () => {
    // Measured 2026-09-07: `nngroup/wd3/external` answers with zero postings and
    // `nngroup/wd3/wdexternal` — the labelled row — is NN Group's real Dutch board.
    expect(stripSiteSuffix("Nn Group (Wdexternal)")).toBe("Nn Group");
    expect(stripSiteSuffix("Pwc (Nonpublic Postings)")).toBe("Pwc");
  });

  it("leaves an unlabelled name alone", () => {
    expect(stripSiteSuffix("Rabobank")).toBe("Rabobank");
  });

  it("never reduces a name to nothing", () => {
    expect(stripSiteSuffix("(Careers)")).toBe("(Careers)");
  });
});

describe("isOffMarketToken", () => {
  it("rejects a country site on a shared tenant", () => {
    expect(isOffMarketToken("pwc/wd3/us_experienced_careers")).toBe(true);
    expect(isOffMarketToken("acme/wd3/careers-india")).toBe(true);
  });

  it("matches whole words only, so ordinary tokens survive", () => {
    // The reason this is not a substring test: "campus" ends in "us" and
    // "causeway" contains "aus". Both are boards we want.
    expect(isOffMarketToken("pwc/wd3/global_campus_careers")).toBe(false);
    expect(isOffMarketToken("causeway/wd1/careers")).toBe(false);
    expect(isOffMarketToken("industries/wd5/jobs")).toBe(false);
  });
});

describe("joinEmployerBoards", () => {
  const brands = [
    { name: "Deloitte", sector: "accountancy" },
    { name: "Rabobank", sector: "bank" },
  ];

  it("matches a brand through the corpus's own country wording", () => {
    const corpora = new Map<FreeAts, readonly AtsCorpusRow[]>([
      ["smartrecruiters", corpus([["Deloitte Netherlands", "deloittenetherlands"]])],
    ]);
    const candidates = joinEmployerBoards(brands, corpora, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.token).toBe("deloittenetherlands");
    expect(candidates[0]?.matchedSponsor).toBe("Deloitte");
  });

  it("refuses a prefix match, so another country's board cannot ride in", () => {
    const corpora = new Map<FreeAts, readonly AtsCorpusRow[]>([
      ["smartrecruiters", corpus([["Deloitte NZ", "deloittenz"], ["Deloitte East Africa", "dea"]])],
    ]);
    expect(joinEmployerBoards(brands, corpora, [])).toEqual([]);
  });

  it("writes the corpus name, never the curated brand", () => {
    const corpora = new Map<FreeAts, readonly AtsCorpusRow[]>([
      ["workday", [{ name: "Rabobank", slug: "rabobank/jobs", url: "https://rabobank.wd3.myworkdayjobs.com/jobs" }]],
    ]);
    const candidates = joinEmployerBoards(brands, corpora, []);
    expect(candidates[0]?.name).toBe("Rabobank");
    expect(candidates[0]?.token).toBe("rabobank/wd3/jobs");
  });

  it("skips a token the registry already polls", () => {
    const corpora = new Map<FreeAts, readonly AtsCorpusRow[]>([
      ["smartrecruiters", corpus([["Deloitte Netherlands", "deloittenetherlands"]])],
    ]);
    const existing = [board("smartrecruiters", "deloittenetherlands")];
    expect(joinEmployerBoards(brands, corpora, existing)).toEqual([]);
  });
});
