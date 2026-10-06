/**
 * agent-dispatch must leave the executor time to finish — deploy/agent-dispatch.
 * ==============================================================================
 * 2026-10-03, PR #803: one feature-sized task ran 26m43s of a 30m cap because the executor ran the FULL
 * `pnpm test` itself (6m36s). CI and pr-brain already run the full suite; a bigger task would be killed by
 * the timeout with nothing pushed. The executor is now told to run only the tests it touched, and the
 * lease (stale-claim release) must stay strictly longer than the per-run timeout or a live run is stolen.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DispatchSandbox } from "./dispatch-sandbox.js";

const SCRIPT = readFileSync(join(process.cwd(), "deploy/agent-dispatch"), "utf8");
const num = (name: string): number => {
  const m = SCRIPT.match(new RegExp(`^${name}="\\$\\{[A-Z_]+:-(\\d+)\\}"`, "m"));
  if (!m) throw new Error(`${name} default not found`);
  return Number(m[1]);
};

let sb: DispatchSandbox | undefined;
afterEach(() => sb?.destroy());

describe("agent-dispatch — time budget", () => {
  it("keeps the lease at least 10 minutes longer than the per-run timeout", () => {
    expect(num("LEASE_MIN") * 60 - num("TIMEOUT_SEC")).toBeGreaterThanOrEqual(600);
  });

  it("gives the executor at least 40 minutes", () => {
    expect(num("TIMEOUT_SEC")).toBeGreaterThanOrEqual(2400);
  });

  it("tells the legacy executor to run only the tests it touched, not the full suite", () => {
    sb = new DispatchSandbox(["owner/founderos"]);
    sb.addIssue({ number: 810, title: "test(docs): add visible test comment" });
    sb.tick({ agyOut: "done" });
    const prompt = sb.agyPrompts()[0] ?? "";
    expect(prompt).toMatch(/only the test files you added or changed/i);
    expect(prompt).toMatch(/do not run the full\s+`?pnpm test`?/i);
  });
});
