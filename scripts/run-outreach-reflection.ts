/**
 * Live-path smoke for the outreach reflection loop.
 * Usage: pnpm outreach:reflect
 *
 * Requires GOOGLE_GENERATIVE_AI_API_KEY (generator). Reflector uses LM Studio when
 * LM_STUDIO_URL is set; otherwise falls back to the same cloud model.
 * Exits 0 when a draft is queued, 1 on failure. Prints JSON accountability report.
 */

import { runOutreachReflection } from "../src/outreach/index.js";
import { buildGeneratorModel, buildReflectorModel } from "../src/outreach/models.js";
import type { LeadContext } from "../src/outreach/contracts.js";

function hasLocalReflector(): boolean {
  const url = process.env["LM_STUDIO_URL"] ?? process.env["OUTREACH_REFLECTOR_BASE_URL"] ?? "";
  return url.trim().length > 0;
}

async function main(): Promise<void> {
  const key = process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim();
  if (!key) {
    console.error("GOOGLE_GENERATIVE_AI_API_KEY not set — live outreach smoke cannot run.");
    console.error("Offline proof: pnpm test tests/unit/outreach/reflection-e2e.test.ts");
    process.exit(1);
  }

  const lead: LeadContext = {
    profile_id: "urn:li:person:smoke-test",
    full_name: "Alex Chen",
    headline: "Head of AI at NovaStack",
    company: "NovaStack",
    icp_match_score: 78,
    personalization_hooks: [
      "Posted about agent eval harnesses last week",
      "Series A AI dev-tools company — matches Turicks ICP",
    ],
    notes: "Smoke test lead — not a real send (queue only, ADR-009).",
  };

  const generatorModel = buildGeneratorModel();
  const reflectorModel = hasLocalReflector() ? buildReflectorModel() : buildGeneratorModel();

  console.log(
    JSON.stringify({
      phase: "start",
      generator: process.env["OUTREACH_GENERATOR_MODEL"] ?? process.env["AGENT_MODEL"] ?? "default",
      reflector: hasLocalReflector() ? "local" : "cloud-fallback",
    }),
  );

  const result = await runOutreachReflection(lead, {
    generatorModel,
    reflectorModel,
    accountId: "smoke_li",
  });

  const report = {
    status: result.status,
    draft: result.draft,
    draft_length: result.draft.length,
    retry_count: result.retry_count,
    queue_id: result.queue_id,
    scheduled_at: result.queue_entry?.scheduled_at,
    pacing_jitter_ms: result.queue_entry?.pacing_jitter_ms,
    failure_reason: result.failure_reason,
  };

  console.log(JSON.stringify({ phase: "done", report }, null, 2));

  if (result.status !== "queued") {
    process.exit(1);
  }
  if (result.draft.length > 300) {
    console.error("Draft exceeded 300 chars after validation — graph bug.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Outreach reflection smoke failed:", err);
  process.exit(1);
});
