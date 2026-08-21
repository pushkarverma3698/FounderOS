/**
 * Unit tests — the shortlist as a CSV file.
 *
 * WHY A CSV. The Google Sheet replaced the Telegram brief on 2026-08-06 and was
 * then never configured (`JOBHUNT_SHEET_ID` unset on prod through 2026-08-21),
 * so for two weeks the ranked shortlist was built on every sweep and thrown
 * away. The founder's call on 2026-08-21: drop the Sheet, hand him a CSV when he
 * asks for one. No credential, no service account, nothing to set up.
 *
 * THE CELLS COME FROM UNTRUSTED THIRD PARTIES. Company names and job titles are
 * whatever a job board served us, and a cell that opens with `=`, `+`, `-` or
 * `@` is a formula to Excel and to Sheets — a spreadsheet the founder opens is a
 * code-execution surface unless the export neutralises it.
 */

import { describe, it, expect } from "vitest";
import { toCsv, csvField } from "../../../src/tools/jobhunt/csv-export.js";

describe("csvField", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvField("Adyen")).toBe("Adyen");
  });

  it("quotes a value containing a comma", () => {
    expect(csvField("Amsterdam, Netherlands")).toBe('"Amsterdam, Netherlands"');
  });

  it("escapes an embedded quote by doubling it", () => {
    expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes a value containing a newline, so one row stays one row", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
  });

  it("renders a number without quoting it", () => {
    expect(csvField(3)).toBe("3");
  });

  it("neutralises a leading = so Excel reads a formula as text", () => {
    expect(csvField("=1+1")).toBe("'=1+1");
  });

  it("neutralises the other three formula leaders Excel honours", () => {
    expect(csvField("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvField("-2+3")).toBe("'-2+3");
    expect(csvField("@import")).toBe("'@import");
  });

  it("does not neutralise a number that merely looks negative", () => {
    // A real number is a number, not a formula: quoting it would make every
    // negative figure in the sheet unusable in a calculation.
    expect(csvField(-5)).toBe("-5");
  });
});

describe("toCsv", () => {
  it("joins cells with commas and rows with CRLF, per RFC 4180", () => {
    expect(toCsv([["a", "b"], ["c", "d"]])).toContain("a,b\r\nc,d");
  });

  it("starts with a UTF-8 BOM so Excel renders accented company names correctly", () => {
    expect(toCsv([["Doctolib Nederland"]]).charCodeAt(0)).toBe(0xfeff);
  });

  it("survives an empty table without producing a stray row", () => {
    expect(toCsv([]).replace("﻿", "")).toBe("");
  });

  it("quotes a title with a comma so the column count never drifts", () => {
    const csv = toCsv([["Senior Engineer, Platform", "Adyen"]]);
    expect(csv).toContain('"Senior Engineer, Platform",Adyen');
  });
});
