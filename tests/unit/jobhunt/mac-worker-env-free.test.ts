import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Mac worker runs on the laptop without the server's .env; reaching src/core/config.ts crashes it at import (#1324).
function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']/gms)) {
      if (/^\s*import\s+type\s/m.test(m[0])) continue;
      const ts = resolve(dirname(file), m[1]!).replace(/\.js$/, ".ts");
      if (existsSync(ts)) stack.push(ts);
    }
  }
  return seen;
}

describe("mac worker import graph", () => {
  it("never loads src/core/config.ts", () => {
    const hits = [...staticGraph("scripts/mac-worker.ts")].filter((f) => f.endsWith("src/core/config.ts"));
    expect(hits).toEqual([]);
  });
});
