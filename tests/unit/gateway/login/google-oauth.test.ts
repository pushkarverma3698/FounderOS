import { describe, expect, it, vi } from "vitest";
import { buildAuthAttempt, credentialsFileBody, exchangeCode, parseClientSecret, parsePaste } from "../../../../src/gateway/login/google-oauth.js";

const SECRET_JSON = JSON.stringify({
  installed: { client_id: "cid", client_secret: "csec", redirect_uris: ["http://localhost"], auth_uri: "https://a/auth", token_uri: "https://t/token" },
});
const client = parseClientSecret(SECRET_JSON);

describe("google-oauth", () => {
  it("rejects a client file that is not a Desktop app", () => {
    expect(() => parseClientSecret(JSON.stringify({ web: { client_id: "x" } }))).toThrow(/Desktop-app/);
  });

  it("builds a PKCE consent link that forces a refresh token", () => {
    const a = buildAuthAttempt(client);
    const u = new URL(a.url);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(a.state);
    expect(u.searchParams.get("scope")).toContain("gmail.modify");
  });

  it("takes the code from the pasted redirect URL when state matches", () => {
    expect(parsePaste("http://localhost/?state=S1&code=4%2Fabc&scope=x", "S1")).toEqual({ ok: true, code: "4/abc" });
  });

  it("refuses a URL from another attempt, a denied consent and garbage", () => {
    expect(parsePaste("http://localhost/?state=OLD&code=c", "S1")).toMatchObject({ ok: false });
    expect(parsePaste("http://localhost/?error=access_denied&state=S1", "S1")).toMatchObject({ ok: false, reason: expect.stringContaining("access_denied") });
    expect(parsePaste("hello there", "S1")).toMatchObject({ ok: false });
  });

  it("exchanges the code and returns only the refresh token", async () => {
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ refresh_token: "rt", access_token: "at" }), { status: 200 }));
    const r = await exchangeCode(client, "code", "ver", doFetch as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, grant: { refresh_token: "rt" } });
    const body = String((doFetch.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1].body);
    expect(body).toContain("code_verifier=ver");
  });

  it("explains an invalid_grant as a spent or expired code", async () => {
    const doFetch = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const r = await exchangeCode(client, "c", "v", doFetch as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("already used or expired") });
  });

  it("writes the authorized_user file gws reads", () => {
    expect(JSON.parse(credentialsFileBody(client, { refresh_token: "rt" }))).toEqual({ type: "authorized_user", client_id: "cid", client_secret: "csec", refresh_token: "rt" });
  });
});
