import { playwrightBrowserAction, closeBrowser } from "../src/tools/browser-playwright.js";

async function main() {
  console.log("=== Testing Playwright Browser Scripts ===");

  try {
    // 1. Test open_url
    console.log("\n[1] Testing open_url (https://example.com)...");
    const openRes = await playwrightBrowserAction("open_url", { url: "https://example.com" });
    console.log("Result:", openRes);
    if (!openRes.ok) throw new Error("open_url failed");

    // 2. Test get_page_text
    console.log("\n[2] Testing get_page_text...");
    const textRes = await playwrightBrowserAction("get_page_text", {});
    console.log("Result (first 100 chars):", textRes.ok ? textRes.stdout.substring(0, 100).replace(/\n/g, ' ') : textRes.error);
    if (!textRes.ok || !textRes.stdout.includes("Example Domain")) {
        throw new Error("get_page_text failed or missing expected text");
    }

    // 3. Test run_js
    console.log("\n[3] Testing run_js (document.title)...");
    const jsRes = await playwrightBrowserAction("run_js", { js: "document.title" });
    console.log("Result:", jsRes);
    if (!jsRes.ok || jsRes.stdout !== "Example Domain") {
        throw new Error("run_js failed or returned wrong title");
    }

    console.log("\n✅ All tests passed successfully!");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
  } finally {
    console.log("\nClosing browser...");
    await closeBrowser();
    console.log("Browser closed.");
  }
}

main().catch(console.error);
