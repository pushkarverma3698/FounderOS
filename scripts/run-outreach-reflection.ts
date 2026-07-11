/**
 * Live-path smoke for the outreach reflection loop.
 * Usage: pnpm outreach:reflect
 *
 * Requires GOOGLE_GENERATIVE_AI_API_KEY (generator).
 * Reflector uses OpenRouter free tier (OPENROUTER_API_KEY) when validation triggers a rewrite.
 * Exits 0 when a draft is queued, 1 on failure. Prints JSON accountability report.
 */

import { runOutreachReflection } from "../src/outreach/index.js";
import {
  buildGeneratorModel,
  buildReflectorModel,
  describeGeneratorModel,
  describeReflectorModel,
} from "../src/outreach/models.js";
import type { LeadContext } from "../src/outreach/contracts.js";

async function main(): Promise<void> {
  const geminiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim();
  if (!geminiKey) {
    console.error("GOOGLE_GENERATIVE_AI_API_KEY not set — live outreach smoke cannot run.");
    console.error("Offline proof: pnpm test tests/unit/outreach/reflection-e2e.test.ts");
    process.exit(1);
  }

  const orKey = process.env["OPENROUTER_API_KEY"]?.trim();
  if (!orKey) {
    console.warn(
      "OPENROUTER_API_KEY not set — reflector rewrites will fail if the first draft does not pass validation.",
    );
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
  const reflectorModel = buildReflectorModel();

  console.log(
    JSON.stringify({
      phase: "start",
      generator: describeGeneratorModel().id,
      reflector: describeReflectorModel().id,
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
