/**
 * Gateway contract test for the global-halt gate (kill switch).
 *
 * Both gateway entry points — runOfficeText and resumeOffice (src/gateway/office-run.ts)
 * — read the halt flag at turn entry and, if engaged, MUST:
 *   1. reply with formatHaltNotice(...)
 *   2. NOT call office.invoke (no side effect, no action_log row)
 *
 * Wiring a full grammy Context + compiled office in a unit test is heavy and
 * flaky, so — exactly like resume-office-guard.test.ts — we test the gate's
 * decision logic directly against the REAL readHalt(), proving the invariant
 * that protects the run-loop. The live MTProto path is verified separately
 * (CLAUDE.md rule #19).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engageHalt, releaseHalt, readHalt, formatHaltNotice } from "../../../src/infra/halt.js";

/**
 * Mirror of the gateway gate: read halt; if engaged, record a reply + skip invoke.
 * Returns what the real run-loop would do so we can assert the invariant.
 */
async function simulateGateEntry(): Promise<{ replied: string | null; invoked: boolean }> {
  const halt = await readHalt();
  if (halt) {
    return { replied: formatHaltNotice(halt), invoked: false };
  }
  // not halted → the run-loop would proceed to office.invoke
  return { replied: null, invoked: true };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "founderos-haltgate-"));
  process.env["HALT_FLAG_PATH"] = join(dir, "HALT");
});

afterEach(() => {
  delete process.env["HALT_FLAG_PATH"];
  rmSync(dir, { recursive: true, force: true });
});

describe("halt gate — refuses turns when engaged", () => {
  it("when NOT halted: gate lets the turn proceed to invoke", async () => {
    const r = await simulateGateEntry();
    expect(r.invoked).toBe(true);
    expect(r.replied).toBeNull();
  });

  it("when halted: gate replies with the halt notice and does NOT invoke", async () => {
    await engageHalt("deploying", "founder");
    const r = await simulateGateEntry();
    expect(r.invoked).toBe(false); // no office.invoke → no side effect → no action_log row
    expect(r.replied).toContain("halted");
    expect(r.replied).toContain("deploying");
    expect(r.replied).toContain("/resume");
  });

  it("after /resume: gate lets turns proceed again", async () => {
    await engageHalt("freeze");
    expect((await simulateGateEntry()).invoked).toBe(false);
    await releaseHalt();
    expect((await simulateGateEntry()).invoked).toBe(true);
  });

  it("a corrupt flag still blocks (fail-safe, never fail-open)", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "HALT"), "not json");
    const r = await simulateGateEntry();
    expect(r.invoked).toBe(false);
  });
});
