/**
 * Audit probe (2026-07-03): deterministic reproduction of the "refuse" class.
 * Runs the REAL execution-guard pure functions (same order as
 * needsExecutionGuardRetry in office-run.ts) against realistic founder inputs
 * and realistic GOOD model replies, to show which turns the gateway converts
 * into retries/refusals with zero LLM involvement.
 *
 * Run: npx tsx scripts/probe-guard-misfire.ts
 */
import {
  isInternalKnowledgeRequest,
  detectUnbackedMemoryClaim,
  detectUnbackedKnowledgeClaim,
  detectUnbackedWebResearchClaim,
  buildKnowledgeGroundingRefusal,
} from "../src/gateway/execution-guard.js";
import { preRouteDepartment } from "../src/gateway/pre-router.js";
import { detectTaskLedger } from "../src/gateway/task-ledger.js";

interface Case {
  label: string;
  userText: string;
  /** A plausible CORRECT reply the model could give (from thread context / synthesis). */
  goodReply: string;
  toolsCalled: string[];
}

const CASES: Case[] = [
  {
    label: "T35 (the prompt that looped in prod QA)",
    userText:
      "ok so: what does turicks do? what does naggar do? which has more revenue potential in 2026 and why? and what's 1 action i should take this week for the winner?",
    goodReply:
      "Turicks is your AI agency (automation + agent builds for SMEs); Naggar is the retreat business. Revenue potential in 2026 favors Turicks: recurring service revenue scales with delivery capacity while the retreat is seasonal and capacity-capped. One action this week: ship the Gumroad launch post and book two discovery calls.",
    toolsCalled: [],
  },
  {
    label: "Founder asks about plans just discussed in-thread",
    userText: "so what are our goals for this week then?",
    goodReply:
      "Based on what we just discussed: 1) finish the launch QA battery, 2) merge the loop-recovery PR, 3) send the two follow-up emails you drafted, 4) post the launch thread on LinkedIn Friday.",
    toolsCalled: [],
  },
  {
    label: "Casual question mentioning a client",
    userText: "did we decide anything about pricing for the naggar site?",
    goodReply:
      "Yes — earlier in this conversation you settled on the flat-fee option (one-time build plus a small monthly care plan) rather than hourly billing, so the proposal should quote the flat fee.",
    toolsCalled: [],
  },
];

for (const c of CASES) {
  const internal = isInternalKnowledgeRequest(c.userText);
  const dept = preRouteDepartment(c.userText);
  const ledger = detectTaskLedger(c.userText);
  // Same order as needsExecutionGuardRetry (web → memory → knowledge)
  const web = detectUnbackedWebResearchClaim(c.userText, [], c.goodReply, c.toolsCalled);
  const mem = detectUnbackedMemoryClaim(c.userText, [], c.goodReply, c.toolsCalled);
  const know = detectUnbackedKnowledgeClaim(c.userText, [], c.goodReply, c.toolsCalled);
  const guardKind = web ? "web" : mem ? "memory" : know ? "knowledge" : null;

  console.log("=".repeat(72));
  console.log(`CASE: ${c.label}`);
  console.log(`  user: ${c.userText.slice(0, 90)}`);
  console.log(`  isInternalKnowledgeRequest: ${internal}`);
  console.log(`  preRouteDepartment: ${dept}  ledger: ${ledger ? ledger.map((s) => s.dept).join("→") : "none"}`);
  console.log(`  guard verdict on the GOOD reply: ${guardKind ?? "clean (delivered)"}`);
  if (guardKind === "memory" || guardKind === "knowledge") {
    console.log(
      `  → gateway RETRIES the whole office invoke; if the retry also answers without a\n` +
        `    knowledge tool, the founder's reply is REPLACED with:\n` +
        `    "${buildKnowledgeGroundingRefusal().slice(0, 120)}..."`,
    );
  }
}
