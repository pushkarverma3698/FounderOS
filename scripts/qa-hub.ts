/**
 * qa-hub — drive the FounderOS hub over stdio exactly as a coding tool does.
 * =========================================================================
 * Starts src/mcp/hub.ts as a child (all scope, then brain scope), runs named
 * scenarios against the REAL database, Ollama, Google and connected MCP servers
 * of whatever .env it is given, and prints one line per scenario. Exit 1 if any
 * scenario fails its check.
 *
 * Read-only: brain search, Gmail/Calendar reads, bridge listing and one read
 * call. It writes nothing, sends nothing, and calls no LLM.
 *
 *   node --env-file=/opt/founderos/.env --import tsx/esm scripts/qa-hub.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

type Result = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (r: Result) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

async function hub(scope: "all" | "brain"): Promise<Client> {
  const client = new Client({ name: "qa-hub", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx/esm", "src/mcp/hub.ts"],
      env: { ...getDefaultEnvironment(), ...(process.env as Record<string, string>), LOG_STDERR: "1", HUB_SCOPE: scope },
      stderr: "ignore",
    }),
  );
  return client;
}

let failed = 0;
function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail.replace(/\s+/g, " ").slice(0, 150)}`);
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await c.callTool({ name, arguments: args })) as Result;
}

async function main(): Promise<void> {
  const all = await hub("all");
  const names = (await all.listTools()).tools.map((t) => t.name);
  report("all scope lists 9 tools", names.length === 9, names.join(", "));

  const mem = await call(all, "search_memory", { query: "pr-brain preflight on demand", project: "founderos", topK: 2 });
  report("search_memory hits the real brain", !mem.isError && /Result 1/.test(textOf(mem)), textOf(mem));

  const mail = await call(all, "gmail_search", { query: "newer_than:1d", max_results: 1 });
  const mailText = textOf(mail);
  report(
    "gmail_search answers for every account",
    ["turicks", "personal", "naggar"].every((a) => mailText.includes(`## ${a}`)),
    mail.isError ? `all accounts failed: ${mailText}` : mailText,
  );

  const cal = await call(all, "calendar_events", { account: "turicks", days: 2 });
  report("calendar_events answers", textOf(cal).length > 0, textOf(cal));

  const bogus = await call(all, "gmail_search", { query: "x", account: "someone-else" });
  report("unknown account is refused", bogus.isError === true, textOf(bogus));

  const servers = await call(all, "list_connected_tools");
  report("list_connected_tools lists the VPS servers", /- deepwiki/.test(textOf(servers)), textOf(servers));

  const wiki = await call(all, "list_connected_tools", { server: "deepwiki" });
  report("deepwiki's tools are listed", /### \w+/.test(textOf(wiki)) && !wiki.isError, textOf(wiki));

  const structure = await call(all, "call_connected_tool", {
    server: "deepwiki",
    tool: "read_wiki_structure",
    arguments: { repoName: "modelcontextprotocol/typescript-sdk" },
  });
  report("a read tool on a remote server runs", !structure.isError && textOf(structure).length > 20, textOf(structure));

  const post = await call(all, "call_connected_tool", {
    server: "slack",
    tool: "slack_post_message",
    arguments: { channel_id: "C0", text: "qa-hub must never send this" },
  });
  report("a write tool is refused", post.isError === true && /Telegram/.test(textOf(post)), textOf(post));
  await all.close();

  const brain = await hub("brain");
  const brainNames = (await brain.listTools()).tools.map((t) => t.name);
  report("brain scope lists only the 5 brain tools", brainNames.length === 5, brainNames.join(", "));
  const blocked = await call(brain, "gmail_search", { query: "x" });
  report("brain scope refuses gmail_search", blocked.isError === true, textOf(blocked));
  await brain.close();

  console.log(failed === 0 ? "\nqa-hub: all scenarios passed" : `\nqa-hub: ${failed} scenario(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("qa-hub crashed:", err);
  process.exit(1);
});
