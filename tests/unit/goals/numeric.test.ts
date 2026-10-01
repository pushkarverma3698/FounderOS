/**
 * Numeric handling for goals. Postgres `numeric` reaches drizzle as a STRING, and a
 * single NaN silently poisons every comparison downstream (STANDARDS §4), so every
 * read goes through parseNumeric and is checked for finiteness.
 */

import { describe, it, expect } from "vitest";
import { MAX_GOAL_VALUE, formatNumber, parseNumeric, parseUserNumber } from "../../../src/goals/numeric.js";

describe("parseNumeric — what drizzle returns for a numeric column", () => {
  it("parses zero: a target or value of 0 is a real number, not a missing one", () => {
    expect(parseNumeric("0")).toBe(0);
    expect(parseNumeric("0.000")).toBe(0);
    expect(parseNumeric(0)).toBe(0);
  });

  it("parses integers and fractions exactly as written", () => {
    expect(parseNumeric("5")).toBe(5);
    expect(parseNumeric("2.5")).toBe(2.5);
    expect(parseNumeric("0.000001")).toBe(0.000001);
    expect(parseNumeric("-3")).toBe(-3);
    expect(parseNumeric(" 42 ")).toBe(42);
  });

  it("parses very large values without turning them into a string or NaN", () => {
    expect(parseNumeric("99999999999999999999")).toBe(1e20);
    expect(parseNumeric("1000000000000000")).toBe(MAX_GOAL_VALUE);
    expect(parseNumeric("1e21")).toBe(1e21);
  });

  it("returns null, never NaN or Infinity, for a value that is not a finite number", () => {
    for (const bad of ["abc", "NaN", "Infinity", "-Infinity", "1e400", "9".repeat(400), "12abc", "1,000", "0x10", "--3", "1.2.3"]) {
      expect(parseNumeric(bad), bad).toBeNull();
    }
    expect(parseNumeric(Number.NaN)).toBeNull();
    expect(parseNumeric(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("returns null for absent values: null, undefined, empty and blank", () => {
    for (const absent of [null, undefined, "", "   "]) expect(parseNumeric(absent)).toBeNull();
    expect(parseNumeric({})).toBeNull();
    expect(parseNumeric([])).toBeNull();
  });
});

describe("parseUserNumber — what the founder types after target= or /goal <n>", () => {
  it("accepts plain decimals, including 0 and a leading minus", () => {
    expect(parseUserNumber("5")).toBe(5);
    expect(parseUserNumber("0")).toBe(0);
    expect(parseUserNumber("2.5")).toBe(2.5);
    expect(parseUserNumber("-4")).toBe(-4);
    expect(parseUserNumber("1000000000000000")).toBe(1e15);
  });

  it("rejects everything that is not a plain decimal, so nothing is guessed", () => {
    for (const bad of ["", " ", "abc", "1,000", "1e3", "+5", ".5", "5.", "0x10", "5 6", "Infinity", "NaN", "5%", "--1"]) {
      expect(parseUserNumber(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects a value too large to be finite", () => {
    expect(parseUserNumber("9".repeat(400))).toBeNull();
  });
});

describe("formatNumber — how a value is printed to the founder", () => {
  it("prints integers and short fractions plainly", () => {
    expect(formatNumber(5)).toBe("5");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(2.5)).toBe("2.5");
    expect(formatNumber(-0)).toBe("0");
  });

  it("groups thousands and rounds noise away", () => {
    expect(formatNumber(12000)).toBe("12,000");
    expect(formatNumber(1234.5678)).toBe("1,234.57");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
  });

  it("never prints exponent notation, even for very large values", () => {
    expect(formatNumber(1e15)).toBe("1,000,000,000,000,000");
    expect(formatNumber(1e21)).toBe("1,000,000,000,000,000,000,000");
    expect(formatNumber(1e21)).not.toMatch(/e/i);
  });

  it("does not round a small non-zero value to a misleading 0", () => {
    expect(formatNumber(0.004)).toBe("0.004");
  });
});
