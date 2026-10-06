import { describe, expect, it } from "vitest";
import {
  hintDayKey,
  hintText,
  maybeSendHint,
  pickHint,
  type HintDeps,
} from "../../../src/gateway/capability-hint.js";
import type { CapabilityRegistry } from "../../../src/gateway/capabilities-screen.js";

const registry = (over: Partial<CapabilityRegistry> = {}): CapabilityRegistry => ({
  departments: {
    research: [
      { name: "web_search", description: "Search the web. Returns links." },
      { name: "read_url", description: "Read a page. Returns text." },
    ],
    engineering: [
      { name: "run_shell", description: "Run a shell command." },
      { name: "vps_run", description: "Run on the VPS." },
      { name: "dispatch_task", description: "Hand a coding task to Antigravity." },
      { name: "no_description" },
    ],
  },
  gated: new Set(["dispatch_task"]),
  isAvailable: () => true,
  ...over,
});

describe("pickHint", () => {
  it("picks the first tool of the turn's department that was neither used nor hinted", () => {
    const pick = pickHint({ registry: registry(), departments: ["research"], used: new Set(["web_search"]), hinted: new Set() });
    expect(pick?.tool).toBe("read_url");
    expect(pick?.department).toBe("research");
  });

  it("skips tools already hinted before", () => {
    const pick = pickHint({ registry: registry(), departments: ["research"], used: new Set(), hinted: new Set(["web_search"]) });
    expect(pick?.tool).toBe("read_url");
  });

  it("never suggests run_shell or vps_run, tools without a description, or tools the server withholds", () => {
    const r = registry({ isAvailable: (n) => n !== "dispatch_task" });
    expect(pickHint({ registry: r, departments: ["engineering"], used: new Set(), hinted: new Set() })).toBeNull();
  });

  it("returns null when the turn has no department", () => {
    expect(pickHint({ registry: registry(), departments: [], used: new Set(), hinted: new Set() })).toBeNull();
  });

  it("is deterministic", () => {
    const a = pickHint({ registry: registry(), departments: ["research", "engineering"], used: new Set(), hinted: new Set() });
    const b = pickHint({ registry: registry(), departments: ["research", "engineering"], used: new Set(), hinted: new Set() });
    expect(a).toEqual(b);
  });
});

describe("hintText", () => {
  it("names the tool in plain words, says it asks first when gated, and never asks him to type a tool name", () => {
    const text = hintText({ tool: "dispatch_task", department: "engineering", description: "Hand a coding task to Antigravity." }, true);
    expect(text).toContain("Dispatch task");
    expect(text).toContain("Hand a coding task to Antigravity.");
    expect(text).toContain("asks first");
  });
});

describe("hintDayKey", () => {
  it("is the UTC calendar day", () => {
    expect(hintDayKey(new Date("2026-10-06T23:59:00Z"))).toBe("2026-10-06");
  });
});

function harness(over: Partial<HintDeps> = {}) {
  const sent: string[] = [];
  const claims: Array<{ tool: string; day: string }> = [];
  const deps: HintDeps = {
    registry: async () => registry(),
    hintedBefore: async () => new Set(),
    claimToday: async (tool, _dept, day) => {
      claims.push({ tool, day });
      return true;
    },
    now: () => new Date("2026-10-06T10:00:00Z"),
    ...over,
  };
  const send = async (t: string) => {
    sent.push(t);
  };
  return { deps, send, sent, claims };
}

describe("maybeSendHint", () => {
  const turn = { departments: ["research"], used: ["web_search"], ok: true };

  it("sends one hint and records it", async () => {
    const h = harness();
    await maybeSendHint(turn, h.send, h.deps);
    expect(h.sent).toHaveLength(1);
    expect(h.claims).toEqual([{ tool: "read_url", day: "2026-10-06" }]);
  });

  it("sends nothing when today's hint was already claimed", async () => {
    const h = harness({ claimToday: async () => false });
    await maybeSendHint(turn, h.send, h.deps);
    expect(h.sent).toEqual([]);
  });

  it("sends nothing on a failed turn", async () => {
    const h = harness();
    await maybeSendHint({ ...turn, ok: false }, h.send, h.deps);
    expect(h.sent).toEqual([]);
    expect(h.claims).toEqual([]);
  });

  it("never throws into the reply path", async () => {
    const h = harness({ registry: async () => Promise.reject(new Error("boom")) });
    await expect(maybeSendHint(turn, h.send, h.deps)).resolves.toBeUndefined();
    expect(h.sent).toEqual([]);
  });

  it("does not claim the day if there is nothing to suggest", async () => {
    const h = harness({ registry: async () => registry({ departments: {} }) });
    await maybeSendHint(turn, h.send, h.deps);
    expect(h.claims).toEqual([]);
  });
});

describe("hintTurnFrom", () => {
  it("reads departments from the plan, used tools from receipts, and failure from the state", async () => {
    const { hintTurnFrom } = await import("../../../src/gateway/capability-hint.js");
    const turn = hintTurnFrom({
      mission: { plan: { steps: [{ worker: "research" }, { worker: "comms" }] } },
      results: [{ tool_receipts: [{ tool: "web_search" }] }, {}],
      failure: null,
    });
    expect(turn).toEqual({ departments: ["research", "comms"], used: ["web_search"], ok: true });
    expect(hintTurnFrom({ failure: { stage: "x" } }).ok).toBe(false);
    expect(hintTurnFrom({}).departments).toEqual([]);
  });
});
