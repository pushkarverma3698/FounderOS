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
  joinSponsorBoards,
  toBoardCsvRows,
  type AtsCorpusRow,
} from "../../../src/tools/jobhunt/board-import.js";
import type { FreeAts, FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

const corpus = (rows: readonly [string, string][]): AtsCorpusRow[] =>
  rows.map(([name, slug]) => ({ name, slug }));

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
      { name: "Mollie", slug: "mollie" },
      { name: "12Build", slug: "12build" },
    ]);
  });

  it("honours quoted names containing commas", () => {
    const csv = ['name,slug,url', '"Plaid, B.V.",plaid,https://x'].join("\n");
    expect(parseAtsCorpus(csv)).toEqual([{ name: "Plaid, B.V.", slug: "plaid" }]);
  });

  it("skips malformed rows instead of throwing", () => {
    // One bad line in a 6,000-row third-party file must not cost the other 5,999.
    const csv = ["name,slug,url", ",noname,https://x", "No Slug,,https://y", "Ok,ok,https://z"].join(
      "\n",
    );
    expect(parseAtsCorpus(csv)).toEqual([{ name: "Ok", slug: "ok" }]);
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
