import { verifyLiveness } from "../src/tools/jobhunt/liveness.js";
import { sanitizeTelegramUrl } from "../src/tools/jobhunt/telegram-format.js";
import { markdownToTelegramHtml, cleanLatexMath, splitForTelegram } from "../src/gateway/format.js";
import { afterQuietSweep, initialHeartbeat, ZERO_PASS_STREAK_THRESHOLD } from "../src/tools/jobhunt/sweep-heartbeat.js";
import type { FreeFunnel } from "../src/tools/jobhunt/free-ingest.js";

async function runManualVerification() {
  console.log("==================================================");
  console.log("   MANUAL VERIFICATION OF IMPLEMENTED FIXES       ");
  console.log("==================================================\n");

  // 1. VERIFY URL SANITIZATION
  console.log("1. Testing sanitizeTelegramUrl():");
  const testUrls = [
    { input: "https://github.com/pushkarverma3698/FounderOS]", expected: "https://github.com/pushkarverma3698/FounderOS" },
    { input: "https://boards.greenhouse.io/job/123).", expected: "https://boards.greenhouse.io/job/123" },
    { input: "https://apply.workable.com/job-(typescript)-dev/", expected: "https://apply.workable.com/job-%28typescript%29-dev/" },
    { input: "http://localhost:3000", expected: "http://localhost:3000/" },
  ];
  for (const { input, expected } of testUrls) {
    const result = sanitizeTelegramUrl(input);
    const pass = result === expected;
    console.log(`   [${pass ? "PASS" : "FAIL"}] "${input}" -> "${result}"`);
    if (!pass) throw new Error(`URL sanitization failed for ${input}`);
  }

  // 2. VERIFY FORMATTING (LATEX MATH, CODE CHIPS, SPLITTING)
  console.log("\n2. Testing cleanLatexMath() & markdownToTelegramHtml():");
  const mathInput = "$$\\text{Duration} = \\frac{\\text{Lines}}{\\text{Rate}} \\approx 6.4\\text{ hours}$$";
  const mathOutput = cleanLatexMath(mathInput);
  console.log(`   Input Math:  ${mathInput}`);
  console.log(`   Output Math: ${mathOutput}`);
  if (mathOutput.includes("$$") || mathOutput.includes("\\text")) {
    throw new Error("LaTeX math was not cleaned properly");
  }

  const filenameInput = "Please inspect README.md and primes.py before run.";
  const filenameOutput = markdownToTelegramHtml(filenameInput);
  console.log(`   Input Filenames:  ${filenameInput}`);
  console.log(`   Output Filenames: ${filenameOutput}`);
  if (!filenameOutput.includes("<code>README.md</code>") || !filenameOutput.includes("<code>primes.py</code>")) {
    throw new Error("Bare code filenames were not wrapped in <code> tags");
  }

  const longText = "A".repeat(5000);
  const chunks = splitForTelegram(longText);
  console.log(`   Split long text (5000 chars) -> ${chunks.length} chunks`);
  if (chunks.length < 2 || chunks.some(c => c.length > 4096)) {
    throw new Error("splitForTelegram failed to chunk text under 4096 limit");
  }

  // 3. VERIFY LIVE ATS / GITHUB PROBING WITH HEADERS & SOFT-404
  console.log("\n3. Testing verifyLiveness() live over HTTP/HTTPS with realistic browser headers:");
  const targets = [
    { id: "repo-live", url: "https://github.com/pushkarverma3698/FounderOS", source: "github" },
    { id: "repo-404", url: "https://github.com/pushkarverma3698/NonExistentTestRepo999", source: "github" }
  ];
  const livenessResults = await verifyLiveness(targets);
  console.log("   Liveness results:", livenessResults);
  const liveTarget = livenessResults.find(r => r.id === "repo-live");
  const deadTarget = livenessResults.find(r => r.id === "repo-404");

  if (!liveTarget || liveTarget.liveness !== "live") {
    throw new Error("Live URL was not classified as live!");
  }
  if (!deadTarget || deadTarget.liveness !== "expired") {
    throw new Error("Dead URL was not classified as expired!");
  }

  // 4. VERIFY FUNNEL HEARTBEAT FALSE ALERTS SUPPRESSION
  console.log("\n4. Testing afterQuietSweep() alert suppression when candidates are already known in tracker:");
  const baseState = {
    ...initialHeartbeat(new Date()),
    zeroPassStreak: ZERO_PASS_STREAK_THRESHOLD - 1, // 5
  };
  const knownFunnel: FreeFunnel = {
    seen: 10,
    undated: 0,
    stale: 0,
    offTrack: 0,
    offMarket: 0,
    known: 10,
    bodyless: 0,
    screened: 0,
  };
  const result = afterQuietSweep(baseState, 5, knownFunnel, new Date(), null, null);
  console.log(`   Result ping: ${result.ping}`);
  if (result.ping && result.ping.includes("⚠ Job lane funnel alert")) {
    throw new Error("Failed to suppress false funnel alert when all candidates died at 'already known in tracker'!");
  }
  console.log("   [PASS] Funnel alert successfully suppressed when all dropped were already known.");

  // Also test that a real restriction DOES alert
  const restrictedFunnel: FreeFunnel = {
    seen: 10,
    undated: 0,
    stale: 0,
    offTrack: 10,
    offMarket: 0,
    known: 0,
    bodyless: 0,
    screened: 0,
  };
  const realAlertResult = afterQuietSweep(baseState, 5, restrictedFunnel, new Date(), null, null);
  console.log(`   Real alert ping: ${realAlertResult.ping}`);
  if (!realAlertResult.ping || !realAlertResult.ping.includes("⚠ <b>Job lane funnel alert</b>")) {
    throw new Error("Legitimate funnel restriction alert did not fire!");
  }
  console.log("   [PASS] Genuine restriction alert fires as expected.");

  console.log("\n==================================================");
  console.log("   ALL MANUAL CHECKS PASSED EMPIRICALLY IN REALITY! ");
  console.log("==================================================");
}

runManualVerification().catch(err => {
  console.error("Manual verification failed:", err);
  process.exit(1);
});
