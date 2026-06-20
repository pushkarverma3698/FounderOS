/**
 * Unit tests for scheduler pure helper functions.
 * These test the context-text builder without touching cron, DB, or LLM.
 */

import { describe, it, expect } from "vitest";
import { buildContextText, formatLeadNudge, formatProposalNudge, formatDemoNudge, formatDesignBriefNudge, formatSiteDeployedNudge, formatProofDropNudge, runBrainSync } from "../../../src/infra/scheduler.js";
import { buildProofDropCadenceNudge } from "../../../src/outbound/proof-drop.js";
import {
  assessDailyBudget,
  nextBudgetAlertThreshold,
  formatBudgetThresholdAlert,
} from "../../../src/infra/daily-budget.js";

describe("buildContextText", () => {
  it("formats a flat string value", () => {
    const ctx = { focus: "close Acme deal" };
    const text = buildContextText(ctx);
    expect(text).toContain("focus: close Acme deal");
  });

  it("formats an array value as comma-separated", () => {
    const ctx = { active_clients: ["Acme Corp", "Beta Ltd"] };
    const text = buildContextText(ctx);
    expect(text).toContain("active_clients: Acme Corp, Beta Ltd");
  });

  it("renders empty array as 'none'", () => {
    const ctx = { active_clients: [] as string[] };
    const text = buildContextText(ctx);
    expect(text).toContain("active_clients: none");
  });

  it("skips the last_updated key", () => {
    const ctx = { focus: "ship phase D", last_updated: "2026-06-01T00:00:00Z" };
    const text = buildContextText(ctx);
    expect(text).not.toContain("last_updated");
    expect(text).toContain("focus:");
  });

  it("returns default message when context is empty", () => {
    const text = buildContextText({});
    expect(text).toContain("No context stored yet");
    expect(text).toContain("active_clients: none");
  });

  it("returns default message when context only has last_updated", () => {
    const text = buildContextText({ last_updated: "2026-06-01T00:00:00Z" });
    expect(text).toContain("No context stored yet");
  });

  it("formats multiple keys each on its own line", () => {
    const ctx = { active_clients: ["Acme"], current_priorities: ["ship"] };
    const lines = buildContextText(ctx).split("\n");
    expect(lines).toHaveLength(2);
  });
});

describe("formatLeadNudge (dept_signals consumer)", () => {
  const sig = (payload: unknown) =>
    ({
      id: "s1",
      tenant_id: "t",
      from_dept: "research",
      to_dept: "sales",
      event_type: "lead_discovered",
      payload,
      thread_id: null,
      consumed: true,
      created_at: new Date(),
    }) as unknown as import("../../../src/db/schema.js").DeptSignal;

  it("returns empty string when there are no lead_discovered signals", () => {
    expect(formatLeadNudge([])).toBe("");
  });

  it("renders company, contact, ICP and source for a lead", () => {
    const out = formatLeadNudge([
      sig({ company: "Acme", contactName: "Sam", contactEmail: "sam@acme.com", icpScore: 88, source: "linkedin" }),
    ]);
    expect(out).toContain("Acme");
    expect(out).toContain("Sam");
    expect(out).toContain("sam@acme.com");
    expect(out).toContain("ICP 88");
    expect(out).toContain("via linkedin");
    // Surfaces work — never auto-sends.
    expect(out).toMatch(/you approve before anything sends/i);
  });

  it("pluralises and lists multiple leads", () => {
    const out = formatLeadNudge([
      sig({ company: "Acme", icpScore: 80, source: "web" }),
      sig({ company: "Beta", icpScore: 75, source: "web" }),
    ]);
    expect(out).toContain("New qualified leads");
    expect(out).toContain("Acme");
    expect(out).toContain("Beta");
  });

  it("ignores non-lead event types in the batch", () => {
    const other = { ...sig({ company: "X" }), event_type: "demo_ready" } as never;
    expect(formatLeadNudge([other])).toBe("");
  });
});

describe("formatProposalNudge", () => {
  const sig = (payload: unknown) =>
    ({
      event_type: "proposal_approved",
      payload,
    }) as unknown as import("../../../src/db/schema.js").DeptSignal;

  it("renders approved proposals for engineering", () => {
    const out = formatProposalNudge([
      sig({ company: "Acme", proposalId: "p-1", amountUsd: 5000 }),
    ]);
    expect(out).toContain("Proposal approved");
    expect(out).toContain("Acme");
    expect(out).toContain("p-1");
    expect(out).toContain("engineering");
  });
});

describe("formatDemoNudge", () => {
  const sig = (payload: unknown) =>
    ({
      event_type: "demo_ready",
      payload,
    }) as unknown as import("../../../src/db/schema.js").DeptSignal;

  it("renders demo-ready signals for sales follow-up", () => {
    const out = formatDemoNudge([
      sig({ company: "Acme", repoUrl: "https://github.com/turicks/acme-demo" }),
    ]);
    expect(out).toContain("Demo ready");
    expect(out).toContain("Acme");
    expect(out).toMatch(/you approve before anything sends/i);
  });
});

describe("formatDesignBriefNudge (web design pipeline)", () => {
  const sig = (payload: unknown) =>
    ({
      event_type: "design_brief_ready",
      payload,
    }) as unknown as import("../../../src/db/schema.js").DeptSignal;

  it("renders design brief signals for engineering build", () => {
    const out = formatDesignBriefNudge([
      sig({ client: "AgentOps", preset: "neon" }),
    ]);
    expect(out).toContain("Design brief ready");
    expect(out).toContain("AgentOps");
    expect(out).toContain("neon");
    expect(out).toMatch(/engineering build cinematic landing/i);
  });
});

describe("formatSiteDeployedNudge (web design pipeline)", () => {
  const sig = (payload: unknown) =>
    ({
      event_type: "site_deployed",
      payload,
    }) as unknown as import("../../../src/db/schema.js").DeptSignal;

  it("renders deployed site signals for sales Proof Drop follow-up", () => {
    const out = formatSiteDeployedNudge([
      sig({
        client: "AgentOps",
        siteUrl: "https://agentops.example.com",
        presetUsed: "neon",
      }),
    ]);
    expect(out).toContain("Site deployed");
    expect(out).toContain("AgentOps");
    expect(out).toContain("https://agentops.example.com");
    expect(out).toContain("neon");
    expect(out).toMatch(/you approve before anything sends/i);
  });
});

describe("formatProofDropNudge (Phase D-Bis GTM)", () => {
  const sig = (payload: unknown) =>
    ({
      event_type: "proof_drop_ready",
      payload,
    }) as unknown as import("../../../src/db/schema.js").DeptSignal;

  it("renders proof drop signals for sales follow-up", () => {
    const out = formatProofDropNudge([
      sig({
        company: "Linear",
        artifactType: "hero_redesign",
        artifactSummary: "Dark-mode hero with scroll-driven agent metrics mock.",
      }),
    ]);
    expect(out).toContain("Proof Drop ready");
    expect(out).toContain("Linear");
    expect(out).toContain("hero_redesign");
    expect(out).toMatch(/you approve before anything sends/i);
  });
});

describe("buildProofDropCadenceNudge (scheduler import)", () => {
  it("nudges when below weekly target", () => {
    const nudge = buildProofDropCadenceNudge({
      countThisWeek: 0,
      target: 2,
      remaining: 2,
      recent: [],
    });
    expect(nudge).toContain("/proofdrop");
  });
});

describe("runBrainSync (auto brain:sync)", () => {
  it("runBrainSync is exported as an async function", () => {
    expect(typeof runBrainSync).toBe("function");
    // Returns a Promise (async).
    const result = runBrainSync();
    expect(result).toBeInstanceOf(Promise);
    // Don't await — we can't spawn the real sync in unit tests without the DB.
    // Just confirm it's callable and returns a Promise.
    result.catch(() => {}); // suppress unhandled rejection
  });
});

describe("daily budget alert helpers (scheduler import)", () => {
  it("fires 80% alert once per day semantics", () => {
    const status = assessDailyBudget(4, 5);
    expect(nextBudgetAlertThreshold(status, [])).toBe(80);
    expect(nextBudgetAlertThreshold(status, [80])).toBeNull();
  });

  it("formats cap-reached alert at 100%", () => {
    const msg = formatBudgetThresholdAlert(assessDailyBudget(5, 5), 100);
    expect(msg).toContain("blocked");
  });
});
