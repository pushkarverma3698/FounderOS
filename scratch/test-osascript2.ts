import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

const script = `tell application "Safari"
  activate
  set URL of front document to "https://example.com"
end tell`;

async function run() {
  const args = script.split("\n").map(line => `-e ${JSON.stringify(line)}`).join(" ");
  try {
    await execAsync(`osascript ${args}`);
    console.log("Success with multiple -e flags!");
  } catch(e: any) {
    console.error("Failed:", e.message);
  }
}
run();
