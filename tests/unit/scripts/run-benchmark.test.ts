/**
 * Reality Benchmark runner — the runner and the verifier must agree.
 * ===================================================================
 * The whole point of the runner is to make producing REAL evidence cheaper than
 * inventing fake evidence. That only holds if a file it writes is one the
 * verifier can actually parse. If the two drift, the founder discovers it after
 * spending a session sending 34 prompts to prod — the most expensive possible
 * moment.
 *
 * So the load-bearing test here is a round trip: render a run, fill it in the
 * way a founder would, and run the REAL verifier as a subprocess over it.
 *
 * The second property: a file the runner produced must NOT pass unscored.
 * Defaulting the eight dimensions to 0 would let an unjudged run through, which
 * is the same defect as the code-inspection scorecard that made the verifier
 * necessary in the first place.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { parseTurnIns, renderBlock, renderManualBlock, normalize, fillTurnIds } from "../../../scripts/run-benchmark.js";
import { CANONICAL } from "../../../scripts/verify-benchmark-run.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "benchmark-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the real verifier over a file; returns its combined output and exit code. */
function verify(runPath: string): { code: number; out: string } {
  try {
    const out = execFileSync(
      "node",
      ["--import", "tsx/esm", "scripts/verify-benchmark-run.ts", runPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() },
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("parseTurnIns — recovers turnIds from a journald export", () => {
  it("extracts turn.in events and ignores every other seam", () => {
    const evidence = [
      JSON.stringify({ turnId: "a-1", seam: "turn.in", data: { textPreview: "find me jobs" } }),
      JSON.stringify({ turnId: "a-1", seam: "tool.call", data: { tool: "search" } }),
      JSON.stringify({ turnId: "b-2", seam: "turn.in", data: { textPreview: "how many jobs are in the pipeline" } }),
    ].join("\n");

    expect(parseTurnIns(evidence)).toEqual([
      { turnId: "a-1", preview: "find me jobs" },
      { turnId: "b-2", preview: "how many jobs are in the pipeline" },
    ]);
  });

  it("survives the non-JSON lines journald really contains", () => {
    const evidence = [
      "-- Journal begins at Tue 2026-08-12 09:00:00 UTC. --",
      "systemd[1]: Started founderos.service.",
      `Aug 13 08:00:00 host founderos[1]: ${JSON.stringify({ turnId: "c-3", seam: "turn.in", data: { textPreview: "whats going on" } })}`,
      "{ this is not json",
      "",
    ].join("\n");

    expect(parseTurnIns(evidence)).toEqual([{ turnId: "c-3", preview: "whats going on" }]);
  });

  it("returns nothing rather than guessing when the export has no turns", () => {
    expect(parseTurnIns("-- No entries --\n")).toEqual([]);
  });
});

describe("renderBlock — output the verifier can read", () => {
  const collected = {
    id: "B1",
    prompt: CANONICAL["B1"]!,
    sentAt: "2026-08-13T09:00:00Z",
    replyText: "I found 12 roles.",
  };

  it("emits the canonical prompt verbatim, so the wording check passes", () => {
    expect(renderBlock(collected)).toContain(`- **prompt sent:** \`${CANONICAL["B1"]}\``);
  });

  it("leaves every dimension unscored, so an unjudged run cannot pass", () => {
    const block = renderBlock(collected);

    expect(block).toContain("intent=_");
    expect(block).toContain("truthfulness=_");
    expect(block).toContain("**total:** _/8");
    // The defect this avoids: zeros would parse as a real, passing score.
    expect(block).not.toMatch(/intent=0/);
  });

  it("records silence as NOT RUN instead of an empty passing block", () => {
    const block = renderBlock({ ...collected, replyText: "" });

    expect(block).toContain("NOT RUN — the bot sent no reply");
    expect(block).not.toContain("**total:**");
  });

  it("records a refused send as NOT RUN, naming the transport error", () => {
    const block = renderBlock({ ...collected, replyText: "", sendError: "MESSAGE_EMPTY" });

    expect(block).toContain("NOT RUN — Telegram refused the send: MESSAGE_EMPTY");
  });
});

describe("renderManualBlock — Group D is scaffolded, never invented", () => {
  it("uses **setup:** and offers the NOT RUN escape hatch", () => {
    const block = renderManualBlock("D6");

    expect(block).toContain("### D6");
    expect(block).toContain("**setup:**");
    expect(block).toContain("NOT RUN");
    expect(block).not.toContain("**prompt sent:**");
  });
});

describe("fillTurnIds — pairs each task with the turn that carried its prompt", () => {
  /** A file shaped exactly as the runner writes it. */
  function runFile(ids: string[]): string {
    const blocks = ids.map((id) =>
      renderBlock({ id, prompt: CANONICAL[id]!, sentAt: "2026-08-13T09:00:00Z", replyText: `reply ${id}` }),
    );
    return `# run\n\n## Tasks\n\n${blocks.join("\n")}`;
  }

  const turn = (id: string, turnId: string) => ({ turnId, preview: CANONICAL[id]! });

  it("fills every FILL-ME whose prompt appears in the export", () => {
    const source = runFile(["A1", "A2", "B1"]);

    const res = fillTurnIds(source, [
      turn("A1", "11111111-1111-4111-8111-111111111111"),
      turn("A2", "22222222-2222-4222-8222-222222222222"),
      turn("B1", "33333333-3333-4333-8333-333333333333"),
    ]);

    expect(res.filled).toBe(3);
    expect(res.unmatched).toEqual([]);
    expect(res.markdown).not.toContain("FILL-ME");
    expect(res.markdown).toContain("11111111-1111-4111-8111-111111111111");
    expect(res.markdown).toContain("33333333-3333-4333-8333-333333333333");
  });

  it("reports a task with no matching turn instead of inventing one", () => {
    const source = runFile(["A1", "A5"]);

    const res = fillTurnIds(source, [turn("A1", "11111111-1111-4111-8111-111111111111")]);

    expect(res.filled).toBe(1);
    expect(res.unmatched).toEqual(["A5"]);
    // The uncorroborated task keeps its placeholder — the verifier will reject it.
    expect(res.markdown).toContain("FILL-ME");
  });

  it("never reuses one turnId for two tasks", () => {
    const source = runFile(["A1", "A2"]);

    // Only ONE turn in the export, and it matches A1.
    const res = fillTurnIds(source, [turn("A1", "11111111-1111-4111-8111-111111111111")]);

    expect(res.filled).toBe(1);
    expect(res.unmatched).toEqual(["A2"]);
    expect([...res.markdown.matchAll(/11111111-1111-4111-8111-111111111111/g)]).toHaveLength(1);
  });

  it("pairs two sends of the SAME prompt with their own turns, in file order", () => {
    // A task re-sent with --only legitimately appears twice.
    const source = `${runFile(["A1"])}\n${runFile(["A1"]).split("## Tasks\n\n")[1]}`;

    const res = fillTurnIds(source, [
      turn("A1", "11111111-1111-4111-8111-111111111111"),
      turn("A1", "44444444-4444-4444-8444-444444444444"),
    ]);

    expect(res.filled).toBe(2);
    expect(res.markdown).toContain("11111111-1111-4111-8111-111111111111");
    expect(res.markdown).toContain("44444444-4444-4444-8444-444444444444");
  });

  it("leaves a manual Group D block untouched — it has no prompt to match", () => {
    const source = `# run\n\n## Tasks\n\n${renderManualBlock("D6")}`;

    const res = fillTurnIds(source, [turn("A1", "11111111-1111-4111-8111-111111111111")]);

    expect(res.filled).toBe(0);
    expect(res.unmatched).toEqual([]);
    expect(res.markdown).toBe(source);
  });

  it("matches on a prefix, because journald truncates textPreview to 120 chars", () => {
    const source = runFile(["C2"]);
    const full = CANONICAL["C2"]!;

    const res = fillTurnIds(source, [
      { turnId: "55555555-5555-4555-8555-555555555555", preview: full.slice(0, 40) },
    ]);

    expect(res.filled).toBe(1);
  });

  it("is a no-op on an export with no turns at all", () => {
    const source = runFile(["A1"]);

    const res = fillTurnIds(source, []);

    expect(res.filled).toBe(0);
    expect(res.unmatched).toEqual(["A1"]);
    expect(res.markdown).toBe(source);
  });
});

describe("normalize — matches the verifier's own comparison", () => {
  it("ignores punctuation and case drift but keeps @ and .", () => {
    expect(normalize("Email alex@acme.com a THANK you!")).toBe("email alex@acme.com a thank you");
  });
});

describe("round trip — a runner-produced file passes only once it is real", () => {
  /** Build a complete 34-task file the way the runner does. */
  function buildRun(opts: { scored: boolean; turnIds: boolean }): string {
    const blocks = Object.keys(CANONICAL).map((id) => {
      const prompt = CANONICAL[id] ?? "";
      if (prompt === "") {
        // Group D / E4: honest non-execution, which the verifier accepts.
        return `### ${id}\n- **setup:** adversarial setup\n- NOT RUN — no staging target exists.\n`;
      }
      const block = renderBlock({
        id,
        prompt,
        sentAt: "2026-08-13T09:00:00Z",
        replyText: `reply for ${id}`,
      });
      let out = block;
      if (opts.turnIds) {
        // Real UUIDs: the verifier checks the shape, and a distinct one per task
        // is what proves it also rejects reuse.
        out = out.replace(/FILL-ME.*$/m, randomUUID());
      }
      if (opts.scored) {
        out = out
          .replace(/- \*\*scores:\*\*.*$/m, "- **scores:** intent=1 source=1 completeness=1 artifact=1 delivery=1 truthfulness=1 leakage=1 friction=1")
          .replace(/- \*\*total:\*\* _\/8/, "- **total:** 8/8");
      }
      return out;
    });
    return `# run\n\n## Tasks\n\n${blocks.join("\n")}`;
  }

  it("FAILS unscored, and says exactly what is missing", () => {
    const runPath = join(dir, "run.md");
    writeFileSync(runPath, buildRun({ scored: false, turnIds: false }));

    const { code, out } = verify(runPath);

    expect(code).toBe(1);
    expect(out).toMatch(/missing dimension scores/);
    expect(out).toMatch(/turnId. is not a UUID/);
    expect(out).toMatch(/no raw evidence export/);
  });

  it("still FAILS when scored and turnId'd but with no journald corroboration", () => {
    const runPath = join(dir, "run.md");
    writeFileSync(runPath, buildRun({ scored: true, turnIds: true }));

    const { code, out } = verify(runPath);

    expect(code).toBe(1);
    // The one check no runner can satisfy on its own — and must not be able to.
    expect(out).toMatch(/no raw evidence export/);
  });

  it("PASSES once every task is scored, turnId'd, and corroborated", () => {
    const runPath = join(dir, "run.md");
    const markdown = buildRun({ scored: true, turnIds: true });
    writeFileSync(runPath, markdown);

    // A journald export containing every turnId the file claims.
    const turnIds = [...markdown.matchAll(/\*\*turnId:\*\*\s*(\S+)/g)].map((m) => m[1]!);
    writeFileSync(
      `${runPath}.evidence.jsonl`,
      turnIds.map((t) => JSON.stringify({ turnId: t, seam: "turn.in" })).join("\n"),
    );

    const { code, out } = verify(runPath);

    expect(out).toContain("PASS — every task is corroborated by a real turn.");
    expect(code).toBe(0);
  });

  it("FAILS when one turnId is absent from the export — the forgery check", () => {
    const runPath = join(dir, "run.md");
    const markdown = buildRun({ scored: true, turnIds: true });
    writeFileSync(runPath, markdown);

    const turnIds = [...markdown.matchAll(/\*\*turnId:\*\*\s*(\S+)/g)].map((m) => m[1]!);
    writeFileSync(
      `${runPath}.evidence.jsonl`,
      turnIds.slice(1).map((t) => JSON.stringify({ turnId: t, seam: "turn.in" })).join("\n"),
    );

    const { code, out } = verify(runPath);

    expect(code).toBe(1);
    expect(out).toMatch(/is not corroborated/);
  });

  it("covers all 34 canonical ids, so the round trip is not a partial sample", () => {
    const runPath = join(dir, "run.md");
    writeFileSync(runPath, buildRun({ scored: true, turnIds: true }));

    expect(readFileSync(runPath, "utf8").match(/^### /gm)).toHaveLength(34);
    expect(verify(runPath).out).toContain("Tasks with an evidence block: 34/34");
  });
});
