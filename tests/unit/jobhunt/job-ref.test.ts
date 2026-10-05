/**
 * A role's short id is derived from its database id, so it cannot move.
 *
 * The failure this guards: `/draft 4` named Bosch, DiligenceVault, Vinmar and MLH on four different alerts,
 * because a row number is a position in a list that is re-ranked every sweep. An id is the role.
 */

import { describe, it, expect } from "vitest";
import {
  JOB_ID_HEX_CHARS,
  JOB_ID_MIN_HEX_CHARS,
  idPrefixRange,
  parseJobId,
  shortJobId,
} from "../../../src/tools/jobhunt/job-ref.js";
import { parseRowArg } from "../../../src/gateway/jobhunt-commands.js";

const UUID = "3a9f2c1d-8b47-4e60-9d15-7c2e0a6b41f8";
const OTHER = "81e2aa40-1111-4222-8333-444455556666";

describe("shortJobId", () => {
  it("is the letter j plus the first hex characters of the row id", () => {
    expect(shortJobId(UUID)).toBe("j3a9f2c1");
    expect(shortJobId(UUID)).toHaveLength(1 + JOB_ID_HEX_CHARS);
  });

  it("depends on the row id and on nothing else, so a re-rank cannot change it", () => {
    expect(shortJobId(UUID)).toBe(shortJobId(UUID.toUpperCase()));
    expect(shortJobId(UUID)).not.toBe(shortJobId(OTHER));
  });

  it("can never be read as a row number, even when the hex part is all digits", () => {
    const digitsOnly = "12345678-0000-4000-8000-000000000000";
    expect(shortJobId(digitsOnly)).toBe("j1234567");
    expect(parseRowArg(shortJobId(digitsOnly))).toBeNull();
  });
});

describe("parseJobId", () => {
  it("reads a printed id back to its hex prefix", () => {
    expect(parseJobId(shortJobId(UUID))).toBe("3a9f2c1");
  });

  it("accepts capitals and a longer prefix, which is how an ambiguous id is disambiguated", () => {
    expect(parseJobId("J3A9F2C1D8B")).toBe("3a9f2c1d8b");
  });

  it("refuses a row number, a word, a prefix that is too short and non-hex characters", () => {
    expect(parseJobId("12")).toBeNull();
    expect(parseJobId("jobs")).toBeNull();
    expect(parseJobId("tashi")).toBeNull();
    expect(parseJobId("j" + "a".repeat(JOB_ID_MIN_HEX_CHARS - 1))).toBeNull();
    expect(parseJobId("j3a9f2cz")).toBeNull();
    expect(parseJobId("3a9f2c1")).toBeNull();
    expect(parseJobId("")).toBeNull();
  });
});

describe("idPrefixRange", () => {
  it("brackets exactly the ids that start with the prefix", () => {
    const { lo, hi } = idPrefixRange("3a9f2c1");
    expect(lo).toBe("3a9f2c10-0000-0000-0000-000000000000");
    expect(hi).toBe("3a9f2c1f-ffff-ffff-ffff-ffffffffffff");
    expect(UUID >= lo && UUID <= hi).toBe(true);
    expect(OTHER >= lo && OTHER <= hi).toBe(false);
  });

  it("spans the dash when the prefix is longer than the first group", () => {
    const { lo, hi } = idPrefixRange("3a9f2c1d8b47");
    expect(lo).toBe("3a9f2c1d-8b47-0000-0000-000000000000");
    expect(hi).toBe("3a9f2c1d-8b47-ffff-ffff-ffffffffffff");
  });
});
