/**
 * Phase D — outbound batch prompt unit tests
 *
 * buildBatchPrompt / splitBatch / parseCompanyArgs are pure functions — no model,
 * no DB. We assert the prompt encodes the ICP, the per-line format, and the
 * companies; that the batch is capped; and that arg parsing handles commas.
 */

import { describe, it, expect } from "vitest";
import {
  buildBatchPrompt,
  splitBatch,
  parseCompanyArgs,
  MAX_BATCH,
} from "../../../src/outbound/batch.js";

describe("buildBatchPrompt", () => {
  it("numbers every company in the list", () => {
    const p = buildBatchPrompt(["Stripe", "Linear", "Acme Corp"]);
    expect(p).toContain("1. Stripe");
    expect(p).toContain("2. Linear");
    expect(p).toContain("3. Acme Corp");
  });

  it("encodes the Turicks ICP and the per-line output format", () => {
    const p = buildBatchPrompt(["Stripe"]);
    expect(p).toMatch(/ICP/);
    expect(p).toMatch(/\$50K.?500K ARR/);
    expect(p).toContain("Disqualify");
    expect(p).toContain("ICP <score>/10");
    expect(p).toContain("Shortlist:");
  });

  it("instructs scoring only — never drafts", () => {
    const p = buildBatchPrompt(["Stripe"]);
    expect(p.toLowerCase()).toContain("do not draft");
  });

  it("instructs publish_signal for high ICP scores (8–10)", () => {
    const p = buildBatchPrompt(["Stripe"]);
    expect(p).toContain('publish_signal(event_type:"lead_discovered"');
    expect(p).toMatch(/8.?10/);
    expect(p).toContain("outbound_batch");
  });
});

describe("splitBatch", () => {
  it("caps the scored batch at MAX_BATCH and returns overflow", () => {
    const targets = Array.from({ length: MAX_BATCH + 3 }, (_, i) => `Co${i}`);
    const { batch, overflow } = splitBatch(targets);
    expect(batch).toHaveLength(MAX_BATCH);
    expect(overflow).toHaveLength(3);
  });

  it("no overflow when within the cap", () => {
    const { batch, overflow } = splitBatch(["A", "B"]);
    expect(batch).toEqual(["A", "B"]);
    expect(overflow).toEqual([]);
  });
});

describe("parseCompanyArgs", () => {
  it("splits comma-separated companies and trims", () => {
    expect(parseCompanyArgs("Acme Corp, Beta Ltd ,  Gamma")).toEqual([
      "Acme Corp",
      "Beta Ltd",
      "Gamma",
    ]);
  });

  it("treats a single no-comma value as one company (names may have spaces)", () => {
    expect(parseCompanyArgs("Acme Corp")).toEqual(["Acme Corp"]);
  });

  it("drops empty fragments", () => {
    expect(parseCompanyArgs("Acme,, ,Beta")).toEqual(["Acme", "Beta"]);
  });
});
