/**
 * AG-042: FounderOS's own read tools in the hub (src/mcp/hub-native.ts).
 * The hub serves the bot's read-only tools, the very objects the bot binds, under a `fos_` name.
 * These tests fail the build if anything able to send, write, dispatch or ask for approval gets in.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { z } from "zod";
import { DEPARTMENT_TOOLS } from "../../../src/agents/capabilities.js";
import { HITL_GATED_TOOLS } from "../../../src/infra/hitl.js";
import { READ_ONLY_TOOLS } from "../../../src/kernel/step-budget.js";
import { toolFailure } from "../../../src/agents/tool-result.js";
import { BRAIN_TOOLS } from "../../../src/mcp/brain-tools.js";
import { GOOGLE_TOOLS } from "../../../src/mcp/hub-google.js";
import { BRIDGE_TOOLS } from "../../../src/mcp/hub-bridge.js";
import { buildHubServer, hubTools } from "../../../src/mcp/hub-server.js";
import {
  HUB_NATIVE_TOOL_NAMES,
  NATIVE_PREFIX,
  buildNativeHubTools,
  loadNativeHubTools,
  type NativeSource,
} from "../../../src/mcp/hub-native.js";

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

const allBotSources = (): NativeSource[] => [...new Map(Object.values(DEPARTMENT_TOOLS).flat().map((t) => [t.name as string, t as unknown as NativeSource])).values()];

const sourceFiles = (dir: string): string[] =>
  (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));

/** A stand-in tool with the bot tool's shape. */
function one(name: string, body: (a: unknown) => unknown = () => "ok"): NativeSource {
  return { name, description: "stand-in " + name, schema: z.object({ q: z.string().optional() }), invoke: async (a: unknown) => body(a) };
}

describe("which tools the hub exposes", () => {
  it("serves the bot's read tools by their fos_ names, including ops_state and github_read", async () => {
    const native = await loadNativeHubTools();
    const names = native.tools.map((t) => t.name);
    expect(names).toContain("fos_ops_state");
    expect(names).toContain("fos_github_read");
    expect(names.every((n) => n.startsWith(NATIVE_PREFIX))).toBe(true);
    expect(names).toHaveLength(HUB_NATIVE_TOOL_NAMES.length);
  });

  it("never collides with a brain, Google or bridge tool name", async () => {
    const native = await loadNativeHubTools();
    const taken = new Set([...BRAIN_TOOLS, ...GOOGLE_TOOLS, ...BRIDGE_TOOLS].map((t) => t.name));
    for (const t of native.tools) expect(taken.has(t.name), t.name).toBe(false);
    expect(new Set(native.tools.map((t) => t.name)).size).toBe(native.tools.length);
  });

  it("does not expose files, chats, mail or the founder's social accounts", () => {
    for (const banned of ["read_file", "list_dir", "recall_conversation", "read_emails", "linkedin_get_my_posts", "linkedin_analytics", "linkedin_read_comments"]) {
      expect(HUB_NATIVE_TOOL_NAMES as readonly string[], banned).not.toContain(banned);
    }
  });
});

describe("read-only guard", () => {
  const exposed = [...HUB_NATIVE_TOOL_NAMES] as string[];

  it("every exposed tool is classed read-only by the AG-035 list", () => {
    for (const name of exposed) {
      expect(READ_ONLY_TOOLS.has(name), name).toBe(true);
    }
  });

  it("no exposed tool is on the gated list", () => {
    for (const name of exposed) {
      expect(HITL_GATED_TOOLS.has(name), name).toBe(false);
    }
  });

  it("no exposed tool source uses the gate function", () => {
    const offenders: string[] = [];
    const dirs = ["src/agents/agent-tools", "src/tools"];
    for (const path of dirs.flatMap((d) => sourceFiles(d))) {
      const body = slurp(path);
      let prev = 0;
      for (const m of body.matchAll(NAME_RE)) {
        const segment = body.slice(prev, m.index);
        prev = m.index ?? prev;
        if (exposed.includes(m[1]!) && segment.includes("hitlGate(")) offenders.push(path + ":" + m[1]);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the advertised input schema is derived from the bot tool schema", async () => {
    const native = await loadNativeHubTools();
    for (const t of native.tools) {
      const origin = native.sourceOf(t.name)!;
      const want = { ...(toJsonSchema(origin.schema as never) as Record<string, unknown>) };
      delete want.$schema;
      expect(t.inputSchema).toEqual(want);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("every exposed tool is the same object the bot binds", async () => {
    const native = await loadNativeHubTools();
    const bound = new Set<unknown>(Object.values(DEPARTMENT_TOOLS).flat());
    for (const name of exposed) {
      const origin = native.sourceOf(NATIVE_PREFIX + name);
      expect(origin, name).toBeDefined();
      expect(bound.has(origin), name).toBe(true);
    }
  });

  it("refuses to build when any gated tool is added to the list", () => {
    const sources = allBotSources();
    for (const extra of HITL_GATED_TOOLS) {
      const attempt = () => buildNativeHubTools(sources, [...exposed, extra]);
      expect(attempt, extra).toThrowError(REJECT);
    }
  });

  it("refuses an unlisted tool", () => {
    const sources = allBotSources();
    const extra = "UNLISTED";
    const attempt = () => buildNativeHubTools(sources, [...exposed, extra]);
    expect(attempt).toThrowError(REJECT);
  });

  it("refuses a name the bot does not have", () => {
    const only = [one("elsewhere")];
    const attempt = () => buildNativeHubTools(only, ["ops_state"]);
    expect(attempt).toThrowError(NOT_BOUND);
  });
});

describe("invocation", () => {
  const names = ["ops_state", "list_scheduled", "github_read"];
  const build = (ops?: (a: unknown) => unknown) => buildNativeHubTools([one("ops_state", ops), one("list_scheduled"), one("github_read")], names);

  it("returns the tool text", async () => {
    const tools = build(() => "payload");
    const out = await tools.run("fos_ops_state", {});
    expect(text(out)).toBe("payload");
  });

  it("turns the bot failure envelope into an MCP error carrying the message", async () => {
    const tools = build(() => toolFailure("db", "backend is down"));
    const out = await tools.run("fos_ops_state", {});
    expect(isError(out)).toBe(true);
    expect(text(out)).toContain("backend is down");
  });

  it("reports a failing tool as an MCP error with its message", async () => {
    const tools = build(BOOM);
    const out = await tools.run("fos_ops_state", {});
    expect(isError(out)).toBe(true);
    expect(text(out)).toContain("JSON");
  });

  it("caps a very large result and says so", async () => {
    const tools = build(HUGE);
    const out = text(await tools.run("fos_ops_state", {}));
    expect(out.length).toBeLessThan(100000);
    expect(out).toContain("truncated");
  });

  it("returns null for a name that is not a native tool", async () => {
    const tools = build();
    expect(await tools.run("fos_other", {})).toBeNull();
    expect(await tools.run("search_memory", {})).toBeNull();
  });
});

describe("the hub", () => {
  type Native = ReturnType<typeof buildNativeHubTools>;
  async function connected(scope: "all" | "brain", native?: Native) {
    const opts = native ? { scope, native } : { scope };
    const server = buildHubServer(opts);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client(CLIENTINFO);
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }
  const LISTED = ["ops_state", "list_scheduled", "github_read"];
  const small = () => buildNativeHubTools([one("ops_state", () => "deployed abc123"), one("list_scheduled"), one("github_read")], LISTED);

  it("lists the native tools in scope all and invokes one", async () => {
    const client = await connected("all", small());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["fos_ops_state", "fos_list_scheduled", "fos_github_read", "search_memory", "gmail_search"]));
    const out = await client.callTool(CALLREQ);
    expect(text(out)).toBe("deployed abc123");
  });

  it("leaves scope brain unchanged", async () => {
    const client = await connected("brain", small());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["search_memory", "get_memory", "remember", "save_decision", "save_bug"]);
    const out = await client.callTool(CALLREQ);
    expect(isError(out)).toBe(true);
    expect(text(out)).toContain("not available in this hub (scope: brain)");
    expect(hubTools("brain", small())).toHaveLength(5);
  });

  it("adds no native tool unless supplied", () => {
    expect(hubTools("all")).toHaveLength(9);
  });

  it("names the read-only tools and Telegram in its instructions", async () => {
    const client = await connected("all", small());
    const guide = client.getInstructions() ?? "";
    expect(guide).toContain("fos_");
    expect(guide).toContain("Telegram");
  });
});

const REJECT = new RegExp("read-only");
const NOT_BOUND = new RegExp("binds no tool");
const NAME_RE = new RegExp('name:\\s*"([a-z_]+)"', "g");
const slurp = (p: string): string => readFileSync(p, "utf8");
const CLIENTINFO = Object.fromEntries([["name", "test"], ["version", "1"]]) as { name: string; version: string };
const CALLREQ = Object.fromEntries([["name", "fos_ops_state"], ["arguments", {}]]);
const HUGE = (): string => "x".repeat(500000);
const BOOM = (): string => JSON.parse("{");
