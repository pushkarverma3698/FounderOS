// tests/unit/log-review/sources.test.ts
import { describe, it, expect } from "vitest";
import { parseLogLines } from "../../../scripts/log-review/sources.js";

describe("parseLogLines", () => {
  it("parses pino JSON lines and tolerates non-JSON noise", () => {
    const raw = [
      `{"level":30,"time":100,"seam":"turn.in","turnId":"A","msg":"in"}`,
      `-- systemd noise line --`,
      `{"level":50,"time":200,"turnId":"A","msg":"boom"}`,
    ].join("\n");
    const lines = parseLogLines(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.turnId).toBe("A");
    expect(lines[1]!.level).toBe(50);
    expect(lines[0]!.raw).toContain("turn.in");
  });

  it("nests structured fields under data when present", () => {
    const raw = `{"level":30,"time":1,"seam":"turn.out","turnId":"A","inputTokens":50,"usd":0.01}`;
    const [line] = parseLogLines(raw);
    // top-level pino fields stay accessible; harvester reads turn.out via data OR top-level
    expect(line!.seam).toBe("turn.out");
  });
});
