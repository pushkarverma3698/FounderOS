import { describe, it, expect, vi } from "vitest";
import { observeHttp, type FetchLike } from "../../../src/tools/oracle-http.js";
import type { Oracle } from "../../../src/tools/oracle.js";

const oracle = (target?: string, kind: Oracle["kind"] = "http"): Oracle => ({
  id: "o1",
  kind,
  target,
  before: { status: 500 },
  expected_after: { status: 200 },
});

const reply = (status: number, body: string): FetchLike =>
  vi.fn(async () => ({ status, text: async () => body })) as unknown as FetchLike;

const ALLOW = ["app.example.com"];

describe("observeHttp", () => {
  it("GETs an allowlisted https target and parses a JSON body", async () => {
    const f = reply(200, '{"payment_status":"completed"}');
    const r = await observeHttp(oracle("https://app.example.com/pay"), f, 1000, ALLOW);
    expect(r).toEqual({ actual: { status: 200, body: { payment_status: "completed" } } });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://app.example.com/pay");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
  });

  it("keeps a non-JSON body as text", async () => {
    const r = await observeHttp(oracle("https://app.example.com/"), reply(200, "ok"), 1000, ALLOW);
    expect(r).toEqual({ actual: { status: 200, body: "ok" } });
  });

  it("never fetches a host that is not on the allowlist", async () => {
    const f = reply(200, "{}");
    const r = await observeHttp(oracle("https://evil.example.net/x"), f, 1000, ALLOW);
    expect(r).toEqual({ error: expect.stringContaining("evil.example.net") });
    expect(f).not.toHaveBeenCalled();
  });

  it("never fetches over http, with embedded credentials, an odd port, or an empty allowlist", async () => {
    const f = reply(200, "{}");
    for (const t of [
      "http://app.example.com/",
      "https://user:pw@app.example.com/",
      "https://app.example.com:8443/",
      "https://app.example.com.evil.net/",
      "ftp://app.example.com/",
      "not a url",
    ]) {
      const r = await observeHttp(oracle(t), f, 1000, ALLOW);
      expect(r).toHaveProperty("error");
    }
    expect(await observeHttp(oracle("https://app.example.com/"), f, 1000, [])).toHaveProperty("error");
    expect(f).not.toHaveBeenCalled();
  });

  it("matches the allowlist case-insensitively", async () => {
    const f = reply(200, "{}");
    const r = await observeHttp(oracle("https://APP.Example.com/"), f, 1000, [" App.Example.COM "]);
    expect(r).toHaveProperty("actual");
    expect(f).toHaveBeenCalledOnce();
  });

  it("errors without a request for a non-http oracle or a missing target", async () => {
    const f = reply(200, "{}");
    expect(await observeHttp(oracle("https://app.example.com/", "telegram"), f, 1000, ALLOW)).toHaveProperty("error");
    expect(await observeHttp(oracle(undefined), f, 1000, ALLOW)).toHaveProperty("error");
    expect(f).not.toHaveBeenCalled();
  });

  it("returns the error when fetch rejects", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;
    const r = await observeHttp(oracle("https://app.example.com/"), f, 1000, ALLOW);
    expect(r).toEqual({ error: expect.stringContaining("ECONNREFUSED") });
  });

  it("aborts on timeout and reports it", async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    const r = await observeHttp(oracle("https://app.example.com/"), f, 20, ALLOW);
    expect(r).toEqual({ error: expect.stringContaining("timed out after 20ms") });
  });

  it("reports a redirect status as-is instead of following it", async () => {
    const r = await observeHttp(oracle("https://app.example.com/"), reply(302, ""), 1000, ALLOW);
    expect(r).toEqual({ actual: { status: 302, body: "" } });
  });
});
