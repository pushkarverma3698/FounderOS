import { describe, expect, it, vi } from "vitest";
import { createGoogleAdapter, type GoogleLoginDeps } from "../../../../src/gateway/login/adapters/google.js";
import { parseClientSecret } from "../../../../src/gateway/login/google-oauth.js";

const client = parseClientSecret(JSON.stringify({ installed: { client_id: "cid", client_secret: "csec", redirect_uris: ["http://localhost"] } }));

function deps(over: Partial<GoogleLoginDeps> = {}): GoogleLoginDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readClient: async () => client,
    profileDir: (a) => `/acc/${a}/gws`,
    runGws: async () => ({ ok: true, stdout: "", parsed: { emailAddress: "me@example.com" } }),
    doFetch: (async () => new Response(JSON.stringify({ refresh_token: "REFRESH-SECRET" }), { status: 200 })) as unknown as typeof fetch,
    fileExists: (p) => files.has(p),
    writeCredentials: async (p, b) => void files.set(p, b),
    backup: async (p) => files.has(p) && (files.set(`${p}.bak`, files.get(p)!), true),
    restore: async (p, had) => void (had ? files.set(p, files.get(`${p}.bak`)!) : files.delete(p)),
    clearAlerts: vi.fn(),
    ...over,
  };
}

async function started(d: GoogleLoginDeps) {
  const a = createGoogleAdapter(d);
  const s = await a.start("personal");
  const state = new URL(/href="([^"]+)"/.exec(s.html)![1]!.replace(/&amp;/g, "&")).searchParams.get("state");
  return { a, s, pasteUrl: `http://localhost/?state=${state}&code=thecode` };
}

describe("google login adapter", () => {
  it("signs an account in, verifies with Gmail, and never prints the token", async () => {
    const d = deps();
    const { a, s, pasteUrl } = await started(d);
    const r = await a.finish("personal", pasteUrl, s.state);
    expect(r.ok).toBe(true);
    expect(r.html).toContain("me@example.com");
    expect(r.html + s.html).not.toContain("REFRESH-SECRET");
    expect(JSON.parse(d.files.get("/acc/personal/gws/credentials.json")!).refresh_token).toBe("REFRESH-SECRET");
    expect(d.clearAlerts).toHaveBeenCalledWith("personal");
  });

  it("keeps the previous login when the new one fails the Gmail check", async () => {
    const d = deps({ runGws: async () => ({ ok: false, error: "invalid_grant" }) });
    d.files.set("/acc/personal/gws/credentials.json", "OLD");
    const { a, s, pasteUrl } = await started(d);
    const r = await a.finish("personal", pasteUrl, s.state);
    expect(r.ok).toBe(false);
    expect(d.files.get("/acc/personal/gws/credentials.json")).toBe("OLD");
  });

  it("removes a half-written first login when the check fails", async () => {
    const d = deps({ runGws: async () => ({ ok: false, error: "boom" }) });
    const { a, s, pasteUrl } = await started(d);
    await a.finish("personal", pasteUrl, s.state);
    expect(d.files.has("/acc/personal/gws/credentials.json")).toBe(false);
  });

  it("status says which account is signed in, expired, or missing", async () => {
    const d = deps({
      runGws: async (_a, dir) => (dir.includes("personal") ? { ok: false, error: "invalid_grant: Bad Request" } : { ok: true, stdout: "", parsed: { emailAddress: "x@y.z" } }),
    });
    d.files.set("/acc/turicks/gws/credentials.json", "{}");
    d.files.set("/acc/personal/gws/credentials.json", "{}");
    const rows = await createGoogleAdapter(d).status();
    const by = Object.fromEntries(rows.map((r) => [r.target, r]));
    expect(by["turicks"]).toMatchObject({ ok: true, detail: "x@y.z" });
    expect(by["personal"]).toMatchObject({ ok: false, detail: expect.stringContaining("expired") });
    expect(by["naggar"]).toMatchObject({ ok: false, detail: expect.stringContaining("not signed in") });
  });
});
