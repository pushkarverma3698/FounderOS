import { describe, expect, it, vi } from "vitest";
import { createGoogleAdapter, type GoogleLoginDeps } from "../../../../src/gateway/login/adapters/google.js";
import { parseClientSecret } from "../../../../src/gateway/login/google-oauth.js";

const client = parseClientSecret(JSON.stringify({ installed: { client_id: "cid", client_secret: "csec", redirect_uris: ["http://localhost"] } }));

function deps(over: Partial<GoogleLoginDeps> = {}): GoogleLoginDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readClient: async () => client,
    mailboxes: () => ["turicks", "personal", "naggar", ...[...files.keys()].flatMap((p) => /^\/acc\/([a-z-]+)\/gws\/credentials\.json$/.exec(p)?.[1] ?? []).filter((n) => !["turicks", "personal", "naggar"].includes(n))],
    profileDir: (a) => `/acc/${a}/gws`,
    runGws: async () => ({ ok: true, stdout: "", parsed: { emailAddress: "me@example.com" } }),
    doFetch: (async () => new Response(JSON.stringify({ refresh_token: "REFRESH-SECRET" }), { status: 200 })) as unknown as typeof fetch,
    fileExists: (p) => files.has(p),
    writeCredentials: async (p, b) => void files.set(p, b),
    backup: async (p) => files.has(p) && (files.set(`${p}.bak`, files.get(p)!), true),
    restore: async (p, had) => void (had ? files.set(p, files.get(`${p}.bak`)!) : files.delete(p)),
    clearAlerts: vi.fn(),
    forget: vi.fn(async (a: string) => void files.delete(`/acc/${a}/gws/credentials.json`)),
    ...over,
  };
}

async function started(d: GoogleLoginDeps, target = "personal") {
  const a = createGoogleAdapter(d);
  const s = await a.start(target);
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

  it("adds a new account under a chosen name, and lists it afterwards", async () => {
    const d = deps();
    const { a, s, pasteUrl } = await started(d, "wife");
    expect(s.html).toContain('Add Google account "wife"');
    expect(a.targets).not.toContain("wife");
    const r = await a.finish("wife", pasteUrl, s.state);
    expect(r.ok).toBe(true);
    expect(r.html).toContain("/login google remove wife");
    expect(a.targets).toContain("wife");
    expect((await a.status()).map((x) => x.target)).toEqual(["turicks", "personal", "naggar", "wife"]);
  });

  it("refuses bad new names, and treats a built-in name as a renewal", () => {
    const a = createGoogleAdapter(deps());
    expect(a.addProblem!("Bad/Name")).toBeDefined();
    expect(a.addProblem!("all")).toBeDefined();
    expect(a.addProblem!("personal")).toBeUndefined();
  });

  it("removes an added account but never a built-in one", async () => {
    const d = deps();
    d.files.set("/acc/wife/gws/credentials.json", "{}");
    const a = createGoogleAdapter(d);
    expect((await a.remove!("turicks")).ok).toBe(false);
    expect(d.forget).not.toHaveBeenCalled();
    const r = await a.remove!("wife");
    expect(r.ok).toBe(true);
    expect(d.forget).toHaveBeenCalledWith("wife");
    expect(a.targets).not.toContain("wife");
  });
});
