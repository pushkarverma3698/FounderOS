/**
 * One-shot script: invoke the office to draft + send the FounderOS launch post.
 * The marketing agent will draft in Turicks brand voice and call linkedin_post().
 * interrupt() fires → HITL approval card appears in Telegram.
 * Founder taps ✅ Approve → post goes live on LinkedIn.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/post-linkedin-launch.ts
 */

import { buildOffice, getPendingApproval } from "../src/agents/office.js";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

async function main() {
  console.log("🚀 Booting office for LinkedIn post...\n");

  const office = buildOffice(new MemorySaver());
  const config = { configurable: { thread_id: "linkedin-launch-post-001" } };

  const prompt = `Draft and publish a LinkedIn post for me.

Topic: FounderOS went public today on GitHub.

Key facts to weave in naturally (pick what makes the strongest post, don't list them all):
- Production LangGraph JS multi-agent system: 7 departments (research, comms, engineering, marketing, sales, prospecting, personal)
- Every write action (email, LinkedIn, GitHub push, shell commands) pauses for founder approval via HITL — nothing fires without approval
- Eval harness: 13/13 routing accuracy, 10/10 tool selection, 12/12 HITL coverage — deterministic, committed to the repo as EVAL.md
- Path-guarded laptop operator: blocks ~/.ssh, .env, *.pem even on read (secrets protected at OS level)
- Per-run budget cap just shipped: stops runaway LLM spend mid-run with a friendly Telegram message
- 289 tests passing, TypeScript strict, tsc clean
- Built with LangGraph JS, Gemini Flash, Postgres checkpointing, Composio, grammY, Drizzle, LangSmith
- Repo: github.com/pushkarverma3698/FounderOS

Use the BUILD_LOG content pillar. Hook must be ≤10 words, lead with a specific number or counterintuitive claim. 150-300 words. Max 3 emojis. One CTA at end.

You MUST call the linkedin_post tool — that is how I review and approve it before it goes live.`;

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
      console.log(`Title: ${approval.title}`);
      console.log(`Summary: ${approval.summary}`);
      console.log("\nPost preview:");
      console.log("─".repeat(60));
      console.log(approval.preview);
      console.log("─".repeat(60));
      console.log("\n📱 Check Telegram — tap ✅ Approve to publish to LinkedIn.");
      console.log("   Or ❌ Reject to cancel.\n");
    } else {
      console.log("⚠️  No HITL card generated — check if linkedin_post tool was called.");
    }
  } catch (err) {
    console.error("❌ Error:", (err as Error).message);
    process.exit(1);
  }

  process.exit(0);
}

main();
