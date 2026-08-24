import { browserAction } from "../src/tools/personal.js";

async function main() {
  console.log("Testing AppleScript Safari driver...");
  
  // Test 1: Open URL
  const res1 = await browserAction("open_url", { url: "https://example.com" });
  console.log("open_url result:", res1);
  
  // Wait a moment for page to load
  await new Promise(r => setTimeout(r, 2000));
  
  // Test 2: Get text
  const res2 = await browserAction("get_page_text", {});
  console.log("get_page_text result:", res2.ok ? (res2 as any).stdout.trim().slice(0, 100) + "..." : (res2 as any).error);
}

main().catch(console.error);
