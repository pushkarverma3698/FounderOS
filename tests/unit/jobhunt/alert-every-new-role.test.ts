/**
 * Every new role interrupts, not only the ones that cleared every check
 * =====================================================================
 * Founder, 2026-09-08: "the roles should be alerted every time we pass them,
 * whenever we find new roles."
 *
 * The alert fired only on `outcome === "pass"`. For the NL-finance lane that is
 * close to nothing: her employers are largely not IND-recognised sponsors and
 * Dutch ads routinely state no salary, so most of her rows carry a `flag` and
 * land in the ASK section — ranked into her brief, and never announced. Measured
 * 2026-09-07: Thales and Michael Kors were ranked and the founder was told
 * nothing, while the 3-hourly liveness ping said "nothing new that cleared
 * screening" above two roles that were sitting in her brief.
 *
 * A REJECT still stays silent. Those are legally void — not pending, not a
 * question, nothing to act on.
 */

import { describe, it, expect } from "vitest";
import { formatNewRowsAlert } from "../../../src/tools/jobhunt/sweep-heartbeat.js";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest-batch.js";

const line = (over: Partial<IngestLine> = {}): IngestLine => ({
  company: "ING",
  title: "Financial Risk Officer",
  outcome: "pass",
  detail: "",
  isNew: true,
  ...over,
});

describe("the alert names flagged roles as well as clean passes", () => {
  it("counts both, and says how many of each", () => {
    const msg = formatNewRowsAlert(
      [line(), line({ outcome: "flag", company: "Thales", title: "Financial Accountant" })],
      null,
      "Tashi Goyal",
    );
    expect(msg).toContain("2 new role");
    expect(msg).toContain("Tashi Goyal");
    // The split is the actionable part: one is ready to apply to, one needs a
    // question first, and they carry different commands.
    expect(msg).toMatch(/1 cleared/i);
    expect(msg).toMatch(/1 need/i);
  });

  it("names a flagged company, which it never used to", () => {
    const msg = formatNewRowsAlert([line({ outcome: "flag", company: "Thales" })], null, "Tashi Goyal");
    expect(msg).toContain("Thales");
  });

  it("does not claim a flagged role passed screening", () => {
    const msg = formatNewRowsAlert([line({ outcome: "flag" })], null, "Tashi Goyal");
    expect(msg).not.toMatch(/passed screening/i);
  });

  it("still reads correctly when every role did clear", () => {
    const msg = formatNewRowsAlert([line(), line()], null, "Pushkar Verma");
    expect(msg).toContain("2 new role");
    expect(msg).toMatch(/2 cleared/i);
  });
});

describe("her Indian pay line is declared and does not hide anything", () => {
  it("is the ₹20 LPA the founder stated", () => {
    expect(getProfile("wife-nl-finance").minInrLpaFloor).toBe(20);
  });

  it("leaves the founder's own line untouched", () => {
    expect(getProfile("pushkar-nl-tech").minInrLpaFloor).toBe(15);
  });
});
