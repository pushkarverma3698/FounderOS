import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

const script = `tell application "Safari"
  activate
  set URL of front document to "https://example.com"
end tell`;

async function run() {
  console.log("Running with JSON.stringify (original):");
  try {
    await execAsync(`osascript -e ${JSON.stringify(script)}`);
  } catch (e: any) {
    console.error("Failed:", e.message);
  }

  console.log("\nRunning by piping to osascript:");
  try {
    const { execSync } = await import("child_process");
    execSync("osascript", { input: script, encoding: "utf8" });
    console.log("Success with piping!");
  } catch(e: any) {
    console.error("Failed pipe:", e.message);
  }
}
run();
