/**
 * FounderOS hub — src/mcp/hub-server.ts, hub-google.ts, hub-bridge.ts, hub.ts.
 * ===========================================================================
 * One MCP server every coding tool starts on the VPS: brain + Google reads +
 * the connected MCP servers, read-only except brain writes. These pin the
 * properties the founder relies on: scope limits what an agent can call (not just
 * what it sees), nothing that sends on his behalf passes, Google reads never
 * spam Telegram alerts, and a server added on the VPS reaches every tool.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildHubServer, hubTools, parseHubScope } from "../../../src/mcp/hub-server.js";
import { callGoogleTool, type GoogleDeps } from "../../../src/mcp/hub-google.js";
import { callBridgeTool, closeBridgeConnections, type BridgeClient, type BridgeDeps } from "../../../src/mcp/hub-bridge.js";
import { bridgeManifestSchema, type BridgeManifest } from "../../../src/mcp/bridge-manifest.js";
import { formatCalendarEvents, gwsReadEmails } from "../../../src/infra/providers/google-gws.js";
import { _resetCredentialAlerts } from "../../../src/infra/provider-probes.js";
import { sendToChat } from "../../../src/infra/telegram-send.js";

// Google as it is on the VPS today: every account's grant is dead. Partial mocks,
// so everything else in these modules stays real; only the fake-deps tests above
// and the no-alert tests below reach them.
const DEAD_GRANT = "Authentication failed: Failed to get token: Server error: invalid_grant: Bad Request";
vi.mock("../../../src/infra/gws-runner.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/infra/gws-runner.js")>()),
  runGws: vi.fn(async () => ({ ok: false, error: DEAD_GRANT })),
}));
vi.mock("../../../src/infra/account-registry.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/infra/account-registry.js")>()),
  getGoogleAccount: vi.fn(async (i: { account_key?: string }) => ({
    ctx: { account_key: i.account_key ?? "turicks" },
    credentials: { gws_profile_dir: "/nonexistent" },
  })),
}));
vi.mock("../../../src/infra/telegram-send.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/infra/telegram-send.js")>()),
  sendToChat: vi.fn(async () => {}),
}));

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

async function connected(scope: "all" | "brain", google?: GoogleDeps, bridge?: BridgeDeps) {
  const server = buildHubServer({ scope, google, bridge });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("hub — scope", () => {
  it("parses HUB_SCOPE, defaulting to all, and refuses anything else", () => {
    expect(parseHubScope(undefined)).toBe("all");
    expect(parseHubScope(" Brain ")).toBe("brain");
    expect(() => parseHubScope("admin")).toThrow(/HUB_SCOPE/);
  });

  it("serves the brain only in brain scope, everything in all scope", async () => {
    const brain = (await (await connected("brain")).listTools()).tools.map((t) => t.name);
    expect(brain).toEqual(["search_memory", "get_memory", "remember", "save_decision", "save_bug"]);
    const all = (await (await connected("all")).listTools()).tools.map((t) => t.name);
    expect(all).toEqual([...brain, "gmail_search", "calendar_events", "list_connected_tools", "call_connected_tool"]);
    expect(hubTools("all")).toHaveLength(9);
  });

  it("enforces scope on calls, not only on the list", async () => {
    const readEmails = vi.fn();
    const client = await connected("brain", { readEmails, listEvents: vi.fn(), now: () => new Date() });
    const r = await client.callTool({ name: "gmail_search", arguments: { query: "x" } });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("not available in this hub (scope: brain)");
    expect(readEmails).not.toHaveBeenCalled();
  });

  it("says where sends happen, in the server instructions", async () => {
    const client = await connected("all");
    expect(client.getInstructions()).toContain("Telegram");
  });
});

describe("hub — Google reads", () => {
  const ok = (data: string) => Promise.resolve({ success: true, data });
  const fail = (error: string) => Promise.resolve({ success: false, error });
  let deps: GoogleDeps;
  beforeEach(() => {
    deps = {
      readEmails: vi.fn((i) => ok(`mail for ${i.account_key}: ${i.query}`)),
      listEvents: vi.fn((i) => ok(`events for ${i.account_key}`)),
      now: () => new Date("2026-09-28T10:00:00.000Z"),
    };
  });

  it("reads one account when asked", async () => {
    const r = await callGoogleTool("gmail_search", { query: "is:unread", account: "Personal" }, deps);
    expect(text(r)).toBe("mail for personal: is:unread");
    expect(deps.readEmails).toHaveBeenCalledTimes(1);
  });

  it("reads every account, labelled, when no account is given", async () => {
    const r = await callGoogleTool("gmail_search", { query: "x" }, deps);
    expect(text(r)).toContain("## turicks\nmail for turicks: x");
    expect(text(r)).toContain("## personal\n");
    expect(text(r)).toContain("## naggar\n");
    expect(isError(r)).toBe(false);
  });

  it("is an error only when every account failed", async () => {
    deps.readEmails = vi.fn((i) => (i.account_key === "turicks" ? ok("mail") : fail("needs re-authorization")));
    expect(isError(await callGoogleTool("gmail_search", { query: "x" }, deps))).toBe(false);
    deps.readEmails = vi.fn(() => fail("needs re-authorization"));
    const r = await callGoogleTool("gmail_search", { query: "x" }, deps);
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("Error: needs re-authorization");
  });

  it("refuses an unknown account instead of guessing one", async () => {
    const r = await callGoogleTool("gmail_search", { query: "x", account: "oplify" }, deps);
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("turicks, personal, naggar");
    expect(deps.readEmails).not.toHaveBeenCalled();
  });

  it("needs a query, and clamps max_results", async () => {
    expect(isError(await callGoogleTool("gmail_search", { query: "  " }, deps))).toBe(true);
    await callGoogleTool("gmail_search", { query: "x", account: "turicks", max_results: 500 }, deps);
    expect(vi.mocked(deps.readEmails).mock.calls[0]![0].max_results).toBe(25);
  });

  it("asks the calendar for now → now + days", async () => {
    await callGoogleTool("calendar_events", { account: "turicks", days: 3 }, deps);
    expect(vi.mocked(deps.listEvents).mock.calls[0]![0]).toMatchObject({
      account_key: "turicks",
      time_min: "2026-09-28T10:00:00.000Z",
      time_max: "2026-10-01T10:00:00.000Z",
      max_results: 20,
    });
  });

  it("formats calendar events, all-day and timed", () => {
    expect(
      formatCalendarEvents({
        items: [
          { summary: "Standup", start: { dateTime: "2026-09-29T09:00:00+05:30" }, end: { dateTime: "2026-09-29T09:15:00+05:30" }, hangoutLink: "https://meet" },
          { start: { date: "2026-09-30" }, end: { date: "2026-10-01" } },
        ],
      }),
    ).toBe(
      "2026-09-29T09:00:00+05:30 – 2026-09-29T09:15:00+05:30 · Standup · https://meet\n2026-09-30 – 2026-10-01 · (no title)",
    );
    expect(formatCalendarEvents({ items: [] })).toBe("No events in this window.");
  });
});

describe("hub — Google reads never alert on Telegram", () => {
  // Each coding-tool session is a new hub process with its own alert memory, so
  // an alert from the hub would reach the founder once per session while a grant
  // is dead. The bot keeps alerting; the hub stays silent.
  beforeEach(() => {
    _resetCredentialAlerts();
    vi.mocked(sendToChat).mockClear();
  });

  it("the bot's read path alerts (so the mock would see a send)", async () => {
    const r = await gwsReadEmails({ query: "x", max_results: 1, account_key: "turicks" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("re-authorization");
    expect(sendToChat).toHaveBeenCalledTimes(1);
  });

  it("the hub returns the same re-authorization error for mail and calendar, and sends nothing", async () => {
    const mail = await callGoogleTool("gmail_search", { query: "x" });
    expect(isError(mail)).toBe(true);
    expect(text(mail)).toContain("## naggar\nError: Google account needs re-authorization");
    const cal = await callGoogleTool("calendar_events", { account: "turicks" });
    expect(text(cal)).toContain("needs re-authorization");
    expect(sendToChat).not.toHaveBeenCalled();
  });
});

describe("hub — connected MCP servers (fake client)", () => {
  const manifestOf = (servers: Record<string, unknown>): BridgeManifest => bridgeManifestSchema.parse({ servers });
  let calls: string[];
  let connects: number;
  let manifest: BridgeManifest;
  let deps: BridgeDeps;
  const fakeClient = (): BridgeClient => ({
    listTools: async () => ({
      tools: [
        { name: "search", description: "find", inputSchema: { type: "object" } },
        { name: "post", description: "post it", inputSchema: { type: "object" } },
        { name: "drop", description: "drop it", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
      ],
    }),
    callTool: async (req) => {
      calls.push(req.name);
      return { content: [{ type: "text", text: `ran ${req.name} ${JSON.stringify(req.arguments)}` }] };
    },
    close: async () => {},
  });

  beforeEach(async () => {
    await closeBridgeConnections();
    calls = [];
    connects = 0;
    manifest = manifestOf({ wiki: { transport: "http", url: "https://example.com/mcp", department: "research", write: ["post"] } });
    deps = { manifest: () => manifest, connect: async () => (connects++, fakeClient()) };
  });

  it("lists the servers, then a server's tools with writes marked Telegram-only", async () => {
    expect(text(await callBridgeTool("list_connected_tools", {}, deps))).toContain("- wiki (https://example.com/mcp)");
    const tools = text(await callBridgeTool("list_connected_tools", { server: "wiki" }, deps));
    expect(tools).toContain("### search\nfind\ninput schema:");
    expect(tools).toContain("### post — Telegram-only");
    expect(tools).toContain("### drop — Telegram-only");
  });

  it("forwards a read tool and returns its result unchanged", async () => {
    const r = await callBridgeTool("call_connected_tool", { server: "wiki", tool: "search", arguments: { q: "a" } }, deps);
    expect(text(r)).toBe('ran search {"q":"a"}');
    expect(calls).toEqual(["search"]);
  });

  it.each(["post", "drop"])("refuses %s (manifest write / destructive annotation) without calling it", async (tool) => {
    const r = await callBridgeTool("call_connected_tool", { server: "wiki", tool }, deps);
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("Ask FounderOS in Telegram");
    expect(calls).toEqual([]);
  });

  it("refuses every unlisted tool on a gateUnlisted server", async () => {
    manifest = manifestOf({ wiki: { transport: "http", url: "https://example.com/mcp", department: "x", gateUnlisted: true } });
    expect(isError(await callBridgeTool("call_connected_tool", { server: "wiki", tool: "search" }, deps))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("connects once per server and reuses it", async () => {
    await callBridgeTool("call_connected_tool", { server: "wiki", tool: "search" }, deps);
    await callBridgeTool("call_connected_tool", { server: "wiki", tool: "search" }, deps);
    expect(connects).toBe(1);
  });

  it("retries a server whose connect failed", async () => {
    let first = true;
    deps.connect = async () => {
      connects++;
      if (first) {
        first = false;
        throw new Error("down");
      }
      return fakeClient();
    };
    expect(text(await callBridgeTool("list_connected_tools", { server: "wiki" }, deps))).toContain('Could not reach "wiki": down');
    expect(isError(await callBridgeTool("list_connected_tools", { server: "wiki" }, deps))).toBe(false);
    expect(connects).toBe(2);
  });

  it("sees a server added to the manifest without a restart", async () => {
    manifest = manifestOf({ ...manifest.servers, notion: { transport: "http", url: "https://n.example/mcp", department: "x" } });
    expect(text(await callBridgeTool("list_connected_tools", {}, deps))).toContain("- notion");
  });

  it("names the servers when asked for an unknown one, and the tools for an unknown tool", async () => {
    expect(text(await callBridgeTool("call_connected_tool", { server: "nope", tool: "x" }, deps))).toContain("- wiki");
    expect(text(await callBridgeTool("call_connected_tool", { server: "wiki", tool: "nope" }, deps))).toContain(
      "It has: search, post, drop",
    );
  });
});

describe("hub — connected MCP servers (real stdio server through the MCP SDK)", () => {
  let dir: string;
  const saved = process.env["MCP_BRIDGE_MANIFEST"];
  beforeEach(async () => {
    await closeBridgeConnections();
    dir = mkdtempSync(join(tmpdir(), "hub-bridge-"));
    process.env["ECHO_CALLS"] = join(dir, "calls");
    writeFileSync(
      join(dir, "mcp-bridge.json"),
      JSON.stringify({
        servers: {
          echo: {
            transport: "stdio",
            command: process.execPath,
            args: ["--import", "tsx/esm", join(REPO, "tests/fixtures/mcp-echo-server.ts")],
            env: ["ECHO_CALLS"],
            department: "research",
            write: ["send_note"],
          },
        },
      }),
    );
    process.env["MCP_BRIDGE_MANIFEST"] = join(dir, "mcp-bridge.json");
  });
  afterEach(async () => {
    await closeBridgeConnections();
    if (saved === undefined) delete process.env["MCP_BRIDGE_MANIFEST"];
    else process.env["MCP_BRIDGE_MANIFEST"] = saved;
    delete process.env["ECHO_CALLS"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("calls a read tool on a real child server, and refuses both kinds of write before they reach it", async () => {
    const r = await callBridgeTool("call_connected_tool", { server: "echo", tool: "echo", arguments: { text: "hi" } });
    expect(text(r)).toBe("echo:hi");
    for (const tool of ["send_note", "wipe"]) {
      expect(isError(await callBridgeTool("call_connected_tool", { server: "echo", tool }))).toBe(true);
    }
    expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n")).toEqual(["echo"]);
  }, 30_000);
});

describe("hub — stdio entry points", () => {
  const env = {
    ...getDefaultEnvironment(),
    PATH: process.env["PATH"] ?? "",
    LOG_STDERR: "1",
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    TELEGRAM_BOT_TOKEN: "unused",
    TELEGRAM_CHAT_ID: "unused",
  };
  async function toolsOf(file: string, extra: Record<string, string> = {}) {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx/esm", join(REPO, file)],
        env: { ...env, ...extra },
        cwd: REPO,
        stderr: "ignore",
      }),
    );
    try {
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }

  it("hub.ts serves everything by default and the brain in HUB_SCOPE=brain", async () => {
    expect(await toolsOf("src/mcp/hub.ts")).toHaveLength(9);
    expect(await toolsOf("src/mcp/hub.ts", { HUB_SCOPE: "brain" })).toHaveLength(5);
  }, 60_000);

  it("turicks-brain.ts still serves the five brain tools for configs that start it", async () => {
    expect(await toolsOf("src/mcp/turicks-brain.ts")).toEqual([
      "search_memory",
      "get_memory",
      "remember",
      "save_decision",
      "save_bug",
    ]);
  }, 60_000);

  it("refuses to start with an unknown HUB_SCOPE", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", join(REPO, "src/mcp/hub.ts")], {
      cwd: REPO,
      env: { ...env, HUB_SCOPE: "admin" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HUB_SCOPE must be one of");
    expect(existsSync(join(REPO, "src/mcp/hub.ts"))).toBe(true);
  }, 60_000);
});
