/**
 * Unit tests — writing a tab into a spreadsheet the founder just created.
 *
 * THE FAILURE THIS GUARDS AGAINST. A blank Google Sheet has exactly one tab,
 * called "Sheet1". Both of ours are therefore missing on the day he creates it,
 * and `values:clear` on a range whose tab does not exist is a 400 — so the very
 * first sweep after setup failed, and would have gone on failing every thirty
 * minutes, against a spreadsheet that existed and was correctly shared. It was
 * found live on 2026-08-06 ("Unable to parse range: Queue!A1:ZZ") and only
 * because the write was tried against the real sheet rather than a mock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: "test-token" }) };
    }
  },
}));

const { writeTab } = await import("../../../src/tools/jobhunt/sheet-client.js");

const TARGET = { spreadsheetId: "sheet-1", credentialsPath: "/tmp/key.json" };

/** Records every call and answers as Google would for the given tab list. */
function stubFetch(existingTabs: string[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchStub = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("fields=sheets.properties.title")) {
      return new Response(
        JSON.stringify({ sheets: existingTabs.map((title) => ({ properties: { title } })) }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
}

describe("writeTab", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("creates the tab when the spreadsheet does not have it yet", async () => {
    const calls = stubFetch(["Sheet1"]);
    await writeTab(TARGET, "Queue", [["#", "Company"]]);

    const created = calls.find((c) => c.url.endsWith(":batchUpdate"));
    expect(created).toBeDefined();
    expect(created?.body).toEqual({
      requests: [{ addSheet: { properties: { title: "Queue" } } }],
    });
  });

  it("does not recreate a tab that already exists", async () => {
    // addSheet on an existing title is itself a 400, so a create-always version
    // would break every sweep after the first one instead of the first one.
    const calls = stubFetch(["Sheet1", "Queue"]);
    await writeTab(TARGET, "Queue", [["#", "Company"]]);

    expect(calls.some((c) => c.url.endsWith(":batchUpdate"))).toBe(false);
  });

  it("clears before it writes, in that order", async () => {
    // Reversed, a sweep returning fewer rows leaves the tail of the previous
    // queue on screen under a heading that says these are the ones to do next.
    const calls = stubFetch(["Queue"]);
    await writeTab(TARGET, "Queue", [["#", "Company"]]);

    const clearAt = calls.findIndex((c) => c.url.includes(":clear"));
    const writeAt = calls.findIndex((c) => c.method === "PUT");
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(clearAt);
  });

  it("sends the rows it was given", async () => {
    const calls = stubFetch(["Queue"]);
    await writeTab(TARGET, "Queue", [["#", "Company"], [1, "Adyen"]]);

    const write = calls.find((c) => c.method === "PUT");
    expect(write?.body).toEqual({ values: [["#", "Company"], [1, "Adyen"]] });
  });

  it("throws with Google's own diagnosis rather than a bare status", async () => {
    // "The caller does not have permission" and "Unable to parse range" need
    // opposite fixes; a status code alone cannot tell them apart.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("The caller does not have permission", { status: 403 })),
    );
    await expect(writeTab(TARGET, "Queue", [["#"]])).rejects.toThrow(
      /403.*does not have permission/,
    );
  });
});
