import { describe, expect, it } from "vitest";
import { readOnlyGh, type GhResult } from "../../../scripts/gh-read.js";

const ok: GhResult = { code: 0, stdout: "", stderr: "" };

describe("readOnlyGh", () => {
  const seen: string[][] = [];
  const guarded = readOnlyGh(async (args) => {
    seen.push(args);
    return ok;
  });

  it("passes GET api calls and the exact required-checks read", async () => {
    expect((await guarded(["api", "repos/a/b/pulls/1"])).code).toBe(0);
    expect((await guarded(["api", "-X", "GET", "repos/a/b"])).code).toBe(0);
    expect((await guarded(["api", "--paginate", "--slurp", "repos/a/b/pulls/1/files"])).code).toBe(0);
    expect((await guarded(["pr", "checks", "7", "--repo", "a/b", "--required", "--json", "bucket,name"])).code).toBe(0);
    expect(seen).toHaveLength(4);
  });

  it("refuses every write verb, and any looser pr checks, without calling gh", async () => {
    seen.length = 0;
    const writes = [
      ["api", "-X", "POST", "repos/a/b/issues"],
      ["api", "-XPATCH", "repos/a/b/pulls/1"],
      ["api", "--method=DELETE", "repos/a/b"],
      ["api", "--method", "put", "repos/a/b"],
      ["api", "repos/a/b/issues", "-f", "title=x"],
      ["api", "repos/a/b/issues", "--input", "body.json"],
      ["api", "graphql"],
      ["pr", "merge", "1"],
      ["pr", "comment", "1"],
      ["pr", "checks", "7", "--repo", "a/b", "--required", "--json", "bucket,name", "--watch"],
      ["pr", "checks", "7", "--repo", "a/b", "--json", "bucket,name"],
      ["pr", "checks", "7;x", "--repo", "a/b", "--required", "--json", "bucket,name"],
      ["run", "download", "1"],
      ["issue", "edit", "1"],
      [],
    ];
    for (const a of writes) {
      const r = await guarded(a);
      expect(r.code, a.join(" ")).not.toBe(0);
      expect(r.stderr).toMatch(/read-only/);
    }
    expect(seen).toEqual([]);
  });
});
