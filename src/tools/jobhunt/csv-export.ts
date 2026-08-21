/**
 * FounderOS — the shortlist as a CSV file
 * =======================================
 * Pure serialisation. No database, no network, no credential — the rows come
 * from `sheet-rows.ts`, which already decides what the founder reads and in what
 * words, so this file only decides how those cells survive a trip through a
 * spreadsheet.
 *
 * WHY THIS EXISTS. The Google Sheet replaced the Telegram brief on 2026-08-06
 * and was then never configured: `JOBHUNT_SHEET_ID` was unset on prod for at
 * least two weeks, so `exportJobSheet` returned "not set up" on all 48 sweeps a
 * day and the ranked shortlist was built and discarded. Founder's call,
 * 2026-08-21: "when i ask i want csv directly". A file costs no service account,
 * no OAuth consent and no setup step he has to remember — which is precisely why
 * the Sheet never happened.
 *
 * THE CELLS ARE UNTRUSTED INPUT. Company names and job titles are whatever a
 * third-party board served us. Excel and Sheets both execute a cell that opens
 * with `=`, `+`, `-` or `@`, so a CSV the founder double-clicks is a code path
 * unless this file closes it. `csvField` closes it.
 */

import type { Cell } from "./sheet-rows.js";

/**
 * Characters that make Excel and Google Sheets treat a cell as a formula.
 *
 * All four, not just `=`. `@` is the legacy Lotus intersection operator and
 * Excel still honours it, and `+`/`-` open a formula just as `=` does — which
 * matters because "-" is a plausible first character of a real job title
 * ("- Senior Engineer" from a badly formatted board) and a plausible first
 * character of an attack.
 */
const FORMULA_LEADERS = new Set(["=", "+", "-", "@"]);

/**
 * One CSV field, quoted and escaped per RFC 4180.
 *
 * Numbers pass through untouched, INCLUDING negative ones. A leading `-` only
 * needs neutralising when it arrived as text from a job board; neutralising a
 * real number would make every negative figure in the file unusable in a
 * calculation, which is a self-inflicted version of the problem.
 */
export function csvField(value: Cell): string {
  if (typeof value === "number") return String(value);

  const guarded = FORMULA_LEADERS.has(value.charAt(0)) ? `'${value}` : value;
  if (!/[",\r\n]/.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * A whole table as CSV text.
 *
 * CRLF line endings and a UTF-8 BOM, both for Excel: without the BOM it reads
 * the file as the local codepage and "Doctolib Nederland" or "Société Générale"
 * arrives mangled, which reads to the founder as a broken export rather than a
 * missing byte.
 */
export function toCsv(rows: readonly (readonly Cell[])[]): string {
  const body = rows.map((row) => row.map(csvField).join(",")).join("\r\n");
  return `﻿${body}`;
}
