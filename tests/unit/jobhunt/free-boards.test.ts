/**
 * Unit tests — the free board registry loader.
 *
 * THE FAILURE THIS GUARDS AGAINST. A registry that loads but yields a handful of
 * rows looks exactly like an empty market at the far end: the sweep runs,
 * reports success, and polls almost nothing. `getFreeBoards()` must fail loudly
 * on a thin parse rather than fail open — that guard is `MIN_EXPECTED_BOARDS`,
 * and it has to be proven to actually throw, not just documented as throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBoardRegistry,
  getFreeBoards,
  resetFreeBoardsCache,
  boardsPathFrom,
  FREE_BOARDS_PATH,
  FREE_ATS_PLATFORMS,
  MIN_EXPECTED_BOARDS,
} from "../../../src/tools/jobhunt/free-boards.js";

const HEADER = "name,ats,board_token,markets";

beforeEach(() => {
  resetFreeBoardsCache();
});

describe("parseBoardRegistry", () => {
  it("parses a well-formed registry and skips the header row", () => {
    const csv = [
      HEADER,
      "Acme B.V.,greenhouse,acme,NL",
      "Bharat Corp,lever,bharat,IN",
    ].join("\n");

    const boards = parseBoardRegistry(csv);

    expect(boards).toHaveLength(2);
    expect(boards[0]).toEqual({
      name: "Acme B.V.",
      ats: "greenhouse",
      token: "acme",
      markets: ["NL"],
    });
    expect(boards[1]).toEqual({
      name: "Bharat Corp",
      ats: "lever",
      token: "bharat",
      markets: ["IN"],
    });
  });

  it("parses a quoted company name containing a comma — a real shipped row", () => {
    const csv = `${HEADER}\n"Zeeco, Inc.",lever,zeeco,3\n`;

    const [board] = parseBoardRegistry(csv);

    expect(board).toBeDefined();
    expect(board!.name).toBe("Zeeco, Inc.");
    expect(board!.ats).toBe("lever");
    expect(board!.token).toBe("zeeco");
  });

  it("skips a row naming an unknown ATS platform without throwing, and keeps the surrounding rows", () => {
    const csv = [
      HEADER,
      "Alpha,greenhouse,alpha,NL",
      "Weird Co,workday,weird,NL",
      "Beta,lever,beta,IN",
    ].join("\n");

    const boards = parseBoardRegistry(csv);

    expect(boards.map((b) => b.token)).toEqual(["alpha", "beta"]);
  });

  it("skips a row with an empty board_token", () => {
    const csv = [HEADER, "No Token Co,greenhouse,,NL", "Alpha,greenhouse,alpha,NL"].join("\n");

    const boards = parseBoardRegistry(csv);

    expect(boards).toHaveLength(1);
    expect(boards[0]!.token).toBe("alpha");
  });

  it("collapses duplicate (ats, token) pairs to one entry", () => {
    const csv = [
      HEADER,
      "Alpha,greenhouse,alpha,NL",
      "Alpha Again,greenhouse,alpha,IN",
    ].join("\n");

    const boards = parseBoardRegistry(csv);

    expect(boards).toHaveLength(1);
    // First occurrence wins.
    expect(boards[0]!.name).toBe("Alpha");
    expect(boards[0]!.markets).toEqual(["NL"]);
  });

  it("does NOT collapse the same token under a different platform", () => {
    const csv = [
      HEADER,
      "Alpha GH,greenhouse,alpha,NL",
      "Alpha Lever,lever,alpha,NL",
    ].join("\n");

    const boards = parseBoardRegistry(csv);

    expect(boards).toHaveLength(2);
    expect(boards.map((b) => b.ats)).toEqual(["greenhouse", "lever"]);
  });

  it("parses NL, IN and the pipe form IN|NL as markets", () => {
    const csv = [
      HEADER,
      "OnlyNL,greenhouse,onlynl,NL",
      "OnlyIN,greenhouse,onlyin,IN",
      "Both,greenhouse,both,IN|NL",
    ].join("\n");

    const boards = parseBoardRegistry(csv);

    expect(boards.find((b) => b.token === "onlynl")!.markets).toEqual(["NL"]);
    expect(boards.find((b) => b.token === "onlyin")!.markets).toEqual(["IN"]);
    expect(boards.find((b) => b.token === "both")!.markets).toEqual(["IN", "NL"]);
  });

  it("drops an unrecognised market value without killing the row", () => {
    const csv = `${HEADER}\nGlobalCo,greenhouse,globalco,US|NL\n`;

    const [board] = parseBoardRegistry(csv);

    expect(board).toBeDefined();
    expect(board!.markets).toEqual(["NL"]);
  });

  it("falls back to the token when the name is empty", () => {
    const csv = `${HEADER}\n,greenhouse,noname,NL\n`;

    const [board] = parseBoardRegistry(csv);

    expect(board!.name).toBe("noname");
  });
});

describe("getFreeBoards", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "free-boards-test-"));
  });

  afterEach(() => {
    delete process.env["FREE_ATS_BOARDS_PATH"];
    resetFreeBoardsCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when the parsed registry is under MIN_EXPECTED_BOARDS", () => {
    const thinPath = join(dir, "thin.csv");
    const rows = Array.from(
      { length: MIN_EXPECTED_BOARDS - 1 },
      (_, i) => `Board${i},greenhouse,board${i},NL`,
    );
    writeFileSync(thinPath, [HEADER, ...rows].join("\n"));
    process.env["FREE_ATS_BOARDS_PATH"] = thinPath;

    expect(() => getFreeBoards()).toThrow(/registry/i);
  });

  it("does not fail open — the thrown error names the shortfall, not a silent empty list", () => {
    const emptyPath = join(dir, "empty.csv");
    writeFileSync(emptyPath, `${HEADER}\n`);
    process.env["FREE_ATS_BOARDS_PATH"] = emptyPath;

    expect(() => getFreeBoards()).toThrow(/parsed only 0 boards/i);
  });

  it("loads and caches a registry that clears the floor", () => {
    const okPath = join(dir, "ok.csv");
    const rows = Array.from(
      { length: MIN_EXPECTED_BOARDS + 5 },
      (_, i) => `Board${i},greenhouse,board${i},NL`,
    );
    writeFileSync(okPath, [HEADER, ...rows].join("\n"));
    process.env["FREE_ATS_BOARDS_PATH"] = okPath;

    const boards = getFreeBoards();

    expect(boards.length).toBe(MIN_EXPECTED_BOARDS + 5);
    // Cached: a second call returns the same array without re-reading.
    expect(getFreeBoards()).toBe(boards);
  });

  it("resetFreeBoardsCache forces a re-read on the next call", () => {
    const okPath = join(dir, "ok.csv");
    const rows = Array.from(
      { length: MIN_EXPECTED_BOARDS + 1 },
      (_, i) => `Board${i},greenhouse,board${i},NL`,
    );
    writeFileSync(okPath, [HEADER, ...rows].join("\n"));
    process.env["FREE_ATS_BOARDS_PATH"] = okPath;

    const first = getFreeBoards();
    resetFreeBoardsCache();
    const second = getFreeBoards();

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe("boardsPathFrom", () => {
  it("honours the FREE_ATS_BOARDS_PATH override", () => {
    expect(boardsPathFrom({ FREE_ATS_BOARDS_PATH: "/tmp/boards.csv" })).toBe("/tmp/boards.csv");
  });

  it("falls back to the repo-relative registry when no override is set", () => {
    expect(boardsPathFrom({})).toBe(FREE_BOARDS_PATH);
  });
});

describe("the real shipped registry", () => {
  afterEach(() => {
    resetFreeBoardsCache();
  });

  it("holds at least MIN_EXPECTED_BOARDS boards, and every row's ats is a supported platform", () => {
    const boards = getFreeBoards();

    expect(boards.length).toBeGreaterThanOrEqual(MIN_EXPECTED_BOARDS);
    for (const board of boards) {
      expect(FREE_ATS_PLATFORMS).toContain(board.ats);
    }
  });
});
