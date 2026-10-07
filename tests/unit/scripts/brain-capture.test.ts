/**
 * Mac collector (AG-027). Fixture home directory, no database, no network. Secret-shaped strings are assembled at
 * run time so no contiguous fake key sits in this file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, buildManifests, toJsonl, parseArgs, summaryLine } from "../../../scripts/brain-capture.js";
import { planRun, EMPTY_STATE } from "../../../src/lib/brain-capture-run.js";
import { memorySourceId, parseDigestInput, type AgyConversation, type CaptureContext } from "../../../src/lib/brain-digest.js";

let home: string;
const ctx = (): CaptureContext => ({ home, machine: "test-mac", timeZone: "Asia/Kolkata" });
const FAKE_KEY = ["sk", "ant", "A".repeat(30)].join("-");

const session = (cwd: string, prompt: string) =>
  [
    { type: "user", sessionId: "s", cwd, gitBranch: "b", timestamp: "2026-10-06T04:10:00Z", message: { role: "user", content: prompt } },
    { type: "assistant", sessionId: "s", cwd, timestamp: "2026-10-06T04:20:00Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
  ].map((o) => JSON.stringify(o)).join("\n");

function put(path: string, text: string, mtimeSec?: number): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (mtimeSec) utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

const agyRow = (id: string): AgyConversation => ({
  conversation_id: id, title: "Plan the capture", preview: "p", step_count: 3,
  last_modified_time: "2026-10-06T05:00:00Z", workspace_uris: JSON.stringify([`file://${home}/Projects/founderos`]),
});

const run = (rows: AgyConversation[] = []) =>
  collect({ ctx: ctx(), claudeProjectsDir: join(home, ".claude", "projects"), agyBrainDir: join(home, "agy-brain"), agyRows: () => rows });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "brain-capture-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("collect + planRun", () => {
  it("captures sessions, memory files and Antigravity conversations with the right project", () => {
    const slug = join(home, ".claude", "projects", "-Users-tester-Projects-founderos");
    put(join(slug, "s1.jsonl"), session(`${home}/Projects/founderos`, "fix the capture"));
    put(join(slug, "memory", "one.md"), "A durable fact.");
    put(join(home, "agy-brain", "c1", "walkthrough.md"), "Walkthrough text.");

    const collected = run([agyRow("c1")]);
    const plan = planRun(collected.candidates, EMPTY_STATE, 200);

    const bySource = Object.fromEntries(plan.records.map((r) => [`${r.source}:${r.memory_type}`, r]));
    expect(bySource["mac-claude:session"]!.project).toBe("founderos");
    expect(bySource["mac-claude:claude_memory"]!.project).toBe("founderos");
    expect(bySource["mac-agy:session"]!.content).toContain("Walkthrough text.");
    expect(bySource["mac-agy:session"]!.project).toBe("founderos");
    for (const r of plan.records) expect(r.metadata.visibility).toBe("founder");
  });

  it("a second run with the saved state emits nothing but still emits the manifest", () => {
    const slug = join(home, ".claude", "projects", "p");
    put(join(slug, "s1.jsonl"), session(`${home}/Projects/x`, "hello there, please summarise"));
    put(join(slug, "memory", "one.md"), "fact");

    const first = planRun(run().candidates, EMPTY_STATE, 200);
    const second = planRun(run().candidates, first.nextState, 200);
    expect(second.records).toHaveLength(0);
    expect(second.unchanged).toBe(2);
    expect(buildManifests(run(), second.droppedKeys)).toHaveLength(1);
  });

  it("drops a memory file containing a secret, reports its path only, and leaves it out of the manifest", () => {
    const slug = join(home, ".claude", "projects", "p");
    const bad = put(join(slug, "memory", "bad.md"), `token ${FAKE_KEY}`);
    const good = put(join(slug, "memory", "good.md"), "fine");

    const collected = run();
    const plan = planRun(collected.candidates, EMPTY_STATE, 200);
    expect(plan.dropped.map((d) => d.label)).toEqual([bad]);
    expect(JSON.stringify(plan.dropped)).not.toContain(FAKE_KEY);
    expect(toJsonl(plan.records)).not.toContain(FAKE_KEY);

    const [manifest] = buildManifests(collected, plan.droppedKeys);
    expect(manifest!.metadata.source_ids).toEqual([memorySourceId(good)]);
  });

  it("the Mac output parses cleanly on the VPS side", () => {
    const slug = join(home, ".claude", "projects", "p");
    put(join(slug, "s1.jsonl"), session(`${home}/Projects/x`, "hello there, please summarise"));
    put(join(slug, "memory", "one.md"), "fact");
    const collected = run([agyRow("c2")]);
    const plan = planRun(collected.candidates, EMPTY_STATE, 200);

    const parsed = parseDigestInput(toJsonl([...plan.records, ...buildManifests(collected, plan.droppedKeys)]));
    expect(parsed.records).toHaveLength(3);
    expect(parsed.manifests).toHaveLength(1);
    expect(parsed.invalid).toBe(0);
  });

  it("honours the cap and reports the deferred count", () => {
    const slug = join(home, ".claude", "projects", "p");
    for (let i = 0; i < 5; i++) put(join(slug, `s${i}.jsonl`), session(`${home}/Projects/x`, `please do task number ${i}`), 1_700_000_000 + i);
    const plan = planRun(run().candidates, EMPTY_STATE, 2);
    expect(plan.records).toHaveLength(2);
    expect(plan.deferred).toBe(3);
    expect(summaryLine(plan, 0, false)).toContain("deferred 3");
  });

  it("skips a missing Claude projects dir without error", () => {
    expect(run().candidates).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("defaults the state file under ~/.claude and clamps --limit to the VPS cap", () => {
    expect(parseArgs([], "/h").state).toBe("/h/.claude/brain-capture-state.json");
    expect(parseArgs(["--limit", "9999"], "/h").limit).toBe(200);
    expect(parseArgs(["--dry-run", "--since-state", "--state-out", "/t/n.json"], "/h")).toMatchObject({ dryRun: true, stateOut: "/t/n.json" });
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    expect(() => parseArgs(["--nope"], "/h")).toThrow(/unknown argument/);
  });
});
