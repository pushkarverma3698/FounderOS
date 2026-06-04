/**
 * LinkedIn post: "Own infrastructure — here's what I built that most skip"
 * Angle: own Postgres tables, self-correcting loops, crash-safe design.
 * Different from post #1 (architecture / HITL overview).
 *
 * Run: node --env-file=.env --import tsx/esm scripts/post-linkedin-infra.ts
 */

import { buildOffice, getPendingApproval } from "../src/agents/office.js";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

async function main() {
  console.log("🚀 Booting office for LinkedIn post (infra angle)...\n");

  const office = buildOffice(new MemorySaver());
  const config = { configurable: { thread_id: "linkedin-infra-post-002" } };

  const prompt = `Draft and publish a LinkedIn post for me.

This is post #2 in the FounderOS build-in-public series.
Post #1 (already published/pending) covered: architecture overview + HITL approval flow.
This post covers a DIFFERENT angle: the infrastructure layer most agent projects skip.

Core angle: "Most AI agent systems are API wrappers. FounderOS has its own infrastructure."

Key facts to weave in naturally (pick what makes the strongest post, not all):
- 5 own Postgres tables that most agent projects skip:
  - checkpoints: every decision persisted → crash recovery, pending approvals survive restarts
  - knowledge_entries: turicks-brain (company docs searchable by agents, keyword search)
  - founder_context: 21 business-state keys the OS reads before answering questions
  - audit_log: SHA-1 idempotency keys — same email/post CANNOT fire twice even if process restarts
  - interrupt_registry: every pending HITL approval tracked with crash recovery
- Self-correcting loops the founder never sees:
  - Brand validator: runs on every LinkedIn/email draft, checks 15+ rules, agent self-corrects silently
  - Eval harness: 13 golden routing tasks re-run at temperature=0 before every merge → EVAL.md committed
  - Per-run budget cap: if LLM spend hits $0.50 in one session, the run stops with a Telegram alert
  - Model cascade: Gemini Flash primary → Claude Haiku fallback (silent)
- Result: "fails safely, not loudly" — agent-generated content never reaches the founder without passing validation
- This is what makes it an OS, not just a chatbot

Use BUILD_LOG content pillar. Direct, no fluff, real specifics.
Hook ≤10 words, lead with something counterintuitive or a specific number.
150-300 words. Max 3 emojis. CTA at end pointing to GitHub.

You MUST call the linkedin_post tool — that triggers my Telegram approval before it goes live.`;

  console.log("📤 Sending to marketing department...\n");

  try {
    await office.invoke(
      { messages: [new HumanMessage(prompt)] },
      config,
    );

    const approval = await getPendingApproval(office, config);

    if (approval) {
      console.log("✅ HITL approval card generated!\n");
      console.log("─".repeat(60));
      console.log(`Title:   ${approval.title}`);
      console.log(`Summary: ${approval.summary}`);
      console.log("\nPost preview:");
      console.log("─".repeat(60));
      console.log(approval.preview);
      console.log("─".repeat(60));
      console.log("\n📱 Check Telegram — tap ✅ Approve to publish.");
    } else {
      console.log("⚠️  No HITL card — check if linkedin_post tool was called.");
    }
  } catch (err) {
    console.error("❌ Error:", (err as Error).message);
    process.exit(1);
  }

  process.exit(0);
}

main();
