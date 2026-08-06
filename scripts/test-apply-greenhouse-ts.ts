import { playwrightBrowserAction, closeBrowser } from "../src/tools/browser-playwright.js";
import path from "path";

async function main() {
  console.log("=== Testing Greenhouse Application via Playwright Backend ===");

  try {
    const fixturePath = path.resolve(process.cwd(), "mac-client/tests/fixtures/greenhouse.html");
    const fileUrl = `file://${fixturePath}`;

    console.log(`\n[1] Opening Greenhouse fixture: ${fileUrl}`);
    const openRes = await playwrightBrowserAction("open_url", { url: fileUrl });
    if (!openRes.ok) throw new Error(`open_url failed: ${openRes.error}`);

    console.log("\n[2] Filling form via run_js...");
    const fillJs = `
      document.getElementById('first_name').value = 'Pushkar';
      document.getElementById('last_name').value = 'Verma';
      document.getElementById('email').value = 'p@example.com';
      document.getElementById('phone').value = '+31600000000';
      'Form Filled';
    `;
    const fillRes = await playwrightBrowserAction("run_js", { js: fillJs });
    console.log("Fill Result:", fillRes);
    if (!fillRes.ok) throw new Error("run_js failed to fill form");

    console.log("\n[3] Submitting the form...");
    const submitJs = `
      document.getElementById('real-submit').click();
      'Clicked Submit';
    `;
    const submitRes = await playwrightBrowserAction("run_js", { js: submitJs });
    console.log("Submit Result:", submitRes);

    console.log("\n[4] Verifying submission state...");
    const verifyJs = `window.__SUBMITTED__ === true`;
    const verifyRes = await playwrightBrowserAction("run_js", { js: verifyJs });
    console.log("Verify Result (window.__SUBMITTED__):", verifyRes);

    if (verifyRes.ok && verifyRes.stdout === 'true') {
        console.log("\n✅ Greenhouse apply workflow test PASSED successfully!");
    } else {
        console.log("\n❌ Submission state check failed!");
    }

  } catch (error) {
    console.error("\n❌ Test failed:", error);
  } finally {
    await closeBrowser();
  }
}

main().catch(console.error);
