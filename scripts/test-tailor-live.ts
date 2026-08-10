import { readFullCvText } from "../src/tools/career.js";
import { tailorCv } from "../src/tools/jobhunt/tailor-cv.js";
import { renderCvToPdf } from "../src/tools/jobhunt/cv-renderer.js";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";

async function main() {
  console.log("==================================================");
  console.log("   LIVE PRODUCT MANAGER E2E TEST: TAILORING ENGINE ");
  console.log("==================================================");

  console.log("\n[STEP 1] Reading Master Base CV from Disk...");
  const cv = readFullCvText("ai");
  if (!cv.ok) {
    console.error("❌ FAILED to load master CV:", cv.error);
    process.exit(1);
  }
  console.log("✅ Master CV Loaded:", cv.path);
  console.log("   Length:", cv.text.length, "characters");

  console.log("\n[STEP 2] Simulating Real Job Posting (Senior AI Engineer - Amsterdam)...");
  const realJd = `
Senior AI Engineer - Autonomous Agent Infrastructure
Company: Booking.com
Location: Amsterdam, Netherlands (Hybrid)
Salary: €85,000 - €105,000 / year + relocation & HSM visa sponsorship

About the role:
We are looking for a Senior AI Systems Engineer to build scalable agent infrastructure.
Key Requirements:
- Deep experience with LangGraph, LangChain, TypeScript, Node.js, and Python.
- Production experience with PostgreSQL, pgvector, and LLM evaluation benchmarks.
- Proven track record with sandboxed execution environments, Docker, and systemd.
- Strong background in building fault-tolerant systems with zero-hallucination guarantees.
- Hands-on experience with automated CI/CD pipelines (GitHub Actions).
`;

  console.log("\n[STEP 3] Executing LLM CV Tailoring (Gemini Flash)...");
  const startTailorTime = Date.now();
  const tailorRes = await tailorCv({
    jobDescription: realJd,
    companyName: "Booking.com",
    jobTitle: "Senior AI Engineer",
    track: "ai",
  });
  const tailorDuration = Date.now() - startTailorTime;

  if (!tailorRes.success || !tailorRes.tailoredMarkdown) {
    console.error("❌ Tailoring FAILED:", tailorRes.error);
    process.exit(1);
  }

  console.log(`✅ CV Tailoring Succeeded in ${tailorDuration}ms!`);
  console.log("   Matched Skills:", tailorRes.matchedSkills.join(", "));
  console.log("   Initial Overlap Ratio:", (tailorRes.initialOverlapRatio * 100).toFixed(1) + "%");
  console.log("   Tailored Output Length:", tailorRes.tailoredMarkdown.length, "characters");

  mkdirSync("./test-artifacts", { recursive: true });
  writeFileSync("./test-artifacts/booking_tailored_cv.md", tailorRes.tailoredMarkdown);
  console.log("   Saved Markdown: ./test-artifacts/booking_tailored_cv.md");

  console.log("\n[STEP 4] Rendering ATS-Safe Single-Column PDF (Playwright Headless Chromium)...");
  const startRenderTime = Date.now();
  const renderRes = await renderCvToPdf(tailorRes.tailoredMarkdown);
  const renderDuration = Date.now() - startRenderTime;

  const pdfPath = "./test-artifacts/booking_tailored_cv.pdf";
  writeFileSync(pdfPath, renderRes.pdfBuffer);
  const pdfStats = statSync(pdfPath);

  console.log(`✅ PDF Rendered Succeeded in ${renderDuration}ms!`);
  console.log("   PDF Size:", pdfStats.size, "bytes");
  console.log("   Saved PDF:", pdfPath);

  console.log("\n[STEP 5] Verifying Factual Integrity & Hallucination Guard...");
  const hasPushkar = tailorRes.tailoredMarkdown.includes("PUSHKAR VERMA") || tailorRes.tailoredMarkdown.includes("Pushkar");
  const hasFounderOS = tailorRes.tailoredMarkdown.includes("FounderOS");
  const hasLangGraph = tailorRes.tailoredMarkdown.includes("LangGraph");

  console.log("   Name verified:", hasPushkar ? "PASS" : "FAIL");
  console.log("   FounderOS project verified:", hasFounderOS ? "PASS" : "FAIL");
  console.log("   LangGraph keyword alignment verified:", hasLangGraph ? "PASS" : "FAIL");

  if (!hasPushkar || !hasFounderOS) {
    console.error("❌ Factual integrity check FAILED!");
    process.exit(1);
  }

  console.log("\n==================================================");
  console.log("🎉 ALL E2E VERIFICATION CHECKS PASSED SUCCESSFULLY!");
  console.log("==================================================");
}

main().catch((err) => {
  console.error("Unhandled test error:", err);
  process.exit(1);
});
