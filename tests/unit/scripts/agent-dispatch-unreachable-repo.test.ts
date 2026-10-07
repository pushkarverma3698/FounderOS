/**
 * A repo the daemon's gh token cannot see — deploy/agent-dispatch.
 * ================================================================
 * 2026-10-06: the daemons' fine-grained PAT was scoped to one owner, so every OplifyMessage repo answered
 * "Could not resolve to a Repository". 600 log lines, no message to the founder, while the bot (classic token)
 * kept filing issues the daemon could never see. Now: ONE Telegram message per repo, naming the repo, gh's
 * error and the likely cause; silent while it stays unreachable; one "reachable again" message, after which a
 * relapse alerts again.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DispatchSandbox } from "./dispatch-sandbox.js";

const GOOD = "owner/founderos";
const BAD = "OplifyMessage/oplify-messaging-app";

let sb: DispatchSandbox;
const alerts = () => sb.messages().filter((m) => /cannot reach/.test(m));

beforeEach(() => {
  sb = new DispatchSandbox([GOOD, BAD]);
  sb.hideRepo(BAD);
});
afterEach(() => sb.destroy());

describe("an unreachable repo", () => {
  it("sends ONE message naming the repo, gh's error and the likely cause", () => {
    sb.tick();

    expect(alerts()).toHaveLength(1);
    const msg = alerts()[0] ?? "";
    expect(msg).toContain(BAD);
    expect(msg).toContain("Could not resolve to a Repository");
    expect(msg).toMatch(/token/i);
    expect(msg).toContain("OplifyMessage");
  });

  it("stays silent on every later tick, and the other repo is still swept", () => {
    sb.tick();
    sb.tick();
    sb.tick();

    expect(alerts()).toHaveLength(1);
    expect(sb.log()).toContain("Processing repo: owner/founderos");
    expect(sb.log()).not.toContain(`Processing repo: ${BAD}`);
  });

  it("sends one 'reachable again' message on recovery and alerts again on relapse", () => {
    const bad = { labels: [], issues: {}, prs: [] };
    sb.tick();
    sb.restoreRepo(BAD, bad);
    sb.tick();
    expect(sb.messages().filter((m) => /can reach .* again/.test(m))).toHaveLength(1);

    sb.hideRepo(BAD);
    sb.tick();
    expect(alerts()).toHaveLength(2);
  });

  it("sends nothing when every repo is reachable", () => {
    sb.restoreRepo(BAD, { labels: [], issues: {}, prs: [] });
    sb.tick();

    expect(alerts()).toHaveLength(0);
  });
});
