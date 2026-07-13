/**
 * Unit tests for the /connect command logic (ADR-041 Tier 3). The registry,
 * manifest writer and bridge reload are injected, so the branching is tested
 * with no network, no disk, and no live bot.
 */

import { describe, it, expect, vi } from "vitest";
import { runConnect, type ConnectDeps } from "../../../src/gateway/commands.js";
import type { RegistrySuggestion } from "../../../src/mcp/registry.js";

const httpNotion: RegistrySuggestion = {
  name: "com.notion/mcp",
  description: "Official Notion MCP",
  key: "notion",
  proposed: { transport: "http", url: "https://mcp.notion.com/mcp", headerEnv: { Authorization: "NOTION_TOKEN" } },
  requiredSecrets: ["NOTION_TOKEN"],
};
const stdioThing: RegistrySuggestion = {
  name: "org/thing",
  description: "A thing",
  key: "thing",
  proposed: { transport: "stdio", command: "uvx", args: ["thing"] },
  requiredSecrets: [],
};

function deps(over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    search: vi.fn(async () => [httpNotion]),
    addToManifest: vi.fn(() => ({ added: true })),
    reload: vi.fn(async () => {}),
    bridgeEnabled: true,
    envHas: () => true,
    ...over,
  };
}

describe("runConnect — search", () => {
  it("lists matches with per-server install hints", async () => {
    const out = await runConnect("notion", deps({ search: vi.fn(async () => [httpNotion, stdioThing]) }));
    expect(out).toContain("Registry matches");
    expect(out).toContain("/connect add notion");
    expect(out).toContain("[http]");
    expect(out).toContain("[stdio]");
  });

  it("reports when nothing matches", async () => {
    const out = await runConnect("zzz", deps({ search: vi.fn(async () => []) }));
    expect(out).toMatch(/No registry servers found/);
  });

  it("shows usage on a bare /connect", async () => {
    expect(await runConnect("", deps())).toMatch(/add &lt;name&gt; &lt;department&gt;/);
  });

  it("surfaces a registry error instead of throwing", async () => {
    const out = await runConnect("notion", deps({ search: vi.fn(async () => { throw new Error("503 down"); }) }));
    expect(out).toMatch(/Registry search failed.*503/);
  });
});

describe("runConnect — add", () => {
  it("rejects an unknown department without touching the manifest", async () => {
    const d = deps();
    const out = await runConnect("add notion nope", d);
    expect(out).toMatch(/Unknown department/);
    expect(d.addToManifest).not.toHaveBeenCalled();
  });

  it("installs and live-reloads when the bridge is on and no secret is missing", async () => {
    const d = deps({ search: vi.fn(async () => [stdioThing]), envHas: () => true });
    const out = await runConnect("add thing research", d);
    expect(d.addToManifest).toHaveBeenCalledOnce();
    expect(d.reload).toHaveBeenCalledOnce();
    expect(out).toMatch(/Added .*thing.* → research/);
    expect(out).toMatch(/live now/);
  });

  it("installs but does NOT reload when a required secret is unset", async () => {
    const d = deps({ envHas: () => false }); // NOTION_TOKEN missing
    const out = await runConnect("add notion research", d);
    expect(d.addToManifest).toHaveBeenCalledOnce();
    expect(d.reload).not.toHaveBeenCalled();
    expect(out).toMatch(/Set env var/);
    expect(out).toContain("NOTION_TOKEN");
  });

  it("saves to the manifest only, with a restart note, when the bridge is off", async () => {
    const d = deps({ search: vi.fn(async () => [stdioThing]), bridgeEnabled: false });
    const out = await runConnect("add thing research", d);
    expect(d.addToManifest).toHaveBeenCalledOnce();
    expect(d.reload).not.toHaveBeenCalled();
    expect(out).toMatch(/MCP_BRIDGE_ENABLED=true/);
  });

  it("refuses to auto-wire an unsupported (docker-only) server", async () => {
    const docker: RegistrySuggestion = { name: "x/y", description: "", key: "y", proposed: null, unsupported: "container-only (needs Docker)", requiredSecrets: [] };
    const d = deps({ search: vi.fn(async () => [docker]) });
    const out = await runConnect("add y research", d);
    expect(out).toMatch(/Can't auto-wire/);
    expect(d.addToManifest).not.toHaveBeenCalled();
  });

  it("passes a duplicate-key refusal from the manifest writer through to the founder", async () => {
    const d = deps({ addToManifest: vi.fn(() => ({ added: false, reason: 'a server named "notion" is already in the manifest' })) });
    const out = await runConnect("add notion research", d);
    expect(out).toMatch(/already in the manifest/);
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("shows usage when add is missing arguments", async () => {
    expect(await runConnect("add", deps())).toMatch(/Usage/);
    expect(await runConnect("add notion", deps())).toMatch(/Usage/);
  });
});
