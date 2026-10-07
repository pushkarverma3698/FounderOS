/**
 * AG-035: github_read get_file / search_code, with a stubbed Octokit (no live API).
 */

import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import { getFile, searchCode, findHitLine } from "../../../src/tools/github-code.js";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

function client(getContent: ReturnType<typeof vi.fn>, code?: ReturnType<typeof vi.fn>): Octokit {
  return { rest: { repos: { getContent }, search: { code: code ?? vi.fn() } } } as unknown as Octokit;
}

describe("get_file", () => {
  it("returns numbered lines and no truncation marker for a short file", async () => {
    const getContent = vi.fn().mockResolvedValue({ data: { type: "file", content: b64("a\nb\nc") } });
    const res = await getFile(client(getContent), "o", "r", "src/x.ts");
    expect(res.success).toBe(true);
    const data = res.data as { truncated: boolean; total_lines: number; content: string };
    expect(data.truncated).toBe(false);
    expect(data.total_lines).toBe(3);
    expect(data.content).toBe("1: a\n2: b\n3: c");
    expect(res.truncated).toBeUndefined();
  });

  it("caps at 400 lines and says so", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => "line" + i).join("\n");
    const getContent = vi.fn().mockResolvedValue({ data: { type: "file", content: b64(big) } });
    const res = await getFile(client(getContent), "o", "r", "big.ts", "beta");
    const data = res.data as { truncated: boolean; total_lines: number; content: string };
    expect(data.truncated).toBe(true);
    expect(data.total_lines).toBe(1000);
    expect(data.content.split("\n")).toHaveLength(400);
    expect(res.truncated).toBe(true);
    expect(res.note).toBe("truncated: showing lines 1-400 of 1000");
    expect(getContent).toHaveBeenCalledWith({ owner: "o", repo: "r", path: "big.ts", ref: "beta" });
  });

  it("explains a directory instead of failing opaquely", async () => {
    const getContent = vi.fn().mockResolvedValue({ data: [{ name: "a.ts" }, { name: "b.ts" }] });
    const res = await getFile(client(getContent), "o", "r", "src");
    expect(res.success).toBe(false);
    expect(res.error).toContain("is a directory");
    expect(res.error).toContain("a.ts, b.ts");
  });
});

describe("search_code", () => {
  it("returns path:line hits parsed from the matched files", async () => {
    const code = vi.fn().mockResolvedValue({ data: { total_count: 2, items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
    const getContent = vi
      .fn()
      .mockResolvedValueOnce({ data: { type: "file", content: b64("x\nconst clampStep = 1;\n") } })
      .mockRejectedValueOnce(new Error("rate limited"));
    const res = await searchCode(client(getContent, code), "o", "r", "clampStep");
    expect(code).toHaveBeenCalledWith({ q: "clampStep repo:o/r", per_page: 20 });
    const data = res.data as { total_count: number; hits: Array<Record<string, unknown>> };
    expect(data.total_count).toBe(2);
    expect(data.hits[0]).toMatchObject({ path: "src/a.ts", line: 2, ref: "src/a.ts:2" });
    expect(data.hits[1]).toEqual({ path: "src/b.ts" });
  });

  it("never returns more than 20 hits", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ path: "f" + i + ".ts" }));
    const code = vi.fn().mockResolvedValue({ data: { total_count: 30, items } });
    const getContent = vi.fn().mockResolvedValue({ data: { type: "file", content: b64("needle") } });
    const res = await searchCode(client(getContent, code), "o", "r", "needle");
    expect((res.data as { hits: unknown[] }).hits).toHaveLength(20);
  });
});

describe("findHitLine", () => {
  it("matches the longest term, case-insensitively", () => {
    expect(findHitLine("a\nFooBar here", "foo foobar")).toEqual({ line: 2, text: "FooBar here" });
    expect(findHitLine("nothing", "zzz")).toBeNull();
  });
});
