import { describe, it, expect } from "vitest";
import {
  buildSessionRecord, buildMemoryRecord, buildManifestRecord, buildAgyRecord, projectFromPath, formatLocal,
  parseDigestInput, digestRecordSchema, SESSION_CONTENT_MAX, MAX_PROMPTS, PROMPT_MAX, FINAL_MESSAGE_MAX, TITLE_MAX,
  type CaptureContext, type AgyConversation,
} from "../../../src/lib/brain-digest.js";

const HOME = "/Users/tester";
const CTX: CaptureContext = { home: HOME, machine: "test-mac", timeZone: "Asia/Kolkata" };
const FALLBACK = new Date("2026-10-01T00:00:00Z");
const TOOL_RESULT_MARKER = "TOOL-RESULT-PAYLOAD-MUST-NOT-APPEAR";
const THINKING_MARKER = "THINKING-MUST-NOT-APPEAR";

const line = (o: unknown) => JSON.stringify(o);
const base = { sessionId: "s1", cwd: `${HOME}/Projects/founderos/.claude/worktrees/x`, gitBranch: "feat/demo" };

function fixture(opts: { promptCount?: number; title?: string } = {}): string {
  const prompts = Array.from({ length: opts.promptCount ?? 2 }, (_, i) =>
    line({ ...base, type: "user", timestamp: `2026-10-06T04:${String(10 + i).padStart(2, "0")}:00Z`,
      message: { role: "user", content: `founder prompt number ${i} ${"x".repeat(500)}` } }));
  return [
    ...(opts.title ? [line({ type: "custom-title", customTitle: opts.title, sessionId: "s1" })] : []),
    line({ type: "pr-link", sessionId: "s1", prUrl: "https://github.com/o/r/pull/9", prNumber: 9 }),
    ...prompts,
    line({ ...base, type: "assistant", timestamp: "2026-10-06T04:20:00Z", message: { role: "assistant", content: [
      { type: "thinking", thinking: THINKING_MARKER },
      { type: "text", text: "I will edit the file now." },
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: `${HOME}/Projects/founderos/src/a.ts`, old_string: "SECRET-BODY-OLD", new_string: "SECRET-BODY-NEW" } },
    ] } }),
    line({ ...base, type: "user", timestamp: "2026-10-06T04:21:00Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: TOOL_RESULT_MARKER },
    ] } }),
    line({ ...base, type: "assistant", timestamp: "2026-10-06T05:30:00Z", message: { role: "assistant", content: [
      { type: "text", text: `Done. ${"y".repeat(2000)}` },
    ] } }),
  ].join("\n");
}

describe("projectFromPath", () => {
  it("maps ~/Projects/<name>, worktrees under it, ~/Oplify.in and others", () => {
    expect(projectFromPath(`${HOME}/Projects/founderos/src`, HOME)).toBe("founderos");
    expect(projectFromPath(`${HOME}/Projects/founderos/.claude/worktrees/x`, HOME)).toBe("founderos");
    expect(projectFromPath(`${HOME}/Oplify.in`, HOME)).toBe("oplify");
    expect(projectFromPath(`${HOME}/Oplify.in/api`, HOME)).toBe("oplify");
    expect(projectFromPath(`${HOME}/Documents/x`, HOME)).toBeNull();
    expect(projectFromPath(`${HOME}/Oplify.industries`, HOME)).toBeNull();
  });
});

describe("formatLocal", () => {
  it("renders in the given zone", () => {
    expect(formatLocal(new Date("2026-10-06T04:30:00Z"), "Asia/Kolkata")).toBe("2026-10-06 10:00");
  });
});

describe("buildSessionRecord", () => {
  it("builds a capped digest with provenance and visibility founder", () => {
    const r = buildSessionRecord(fixture({ title: "Capture the Mac" }), "s1", FALLBACK, CTX)!;
    expect(r.source).toBe("mac-claude");
    expect(r.memory_type).toBe("session");
    expect(r.project).toBe("founderos");
    expect(r.metadata).toMatchObject({
      origin: "mac-claude", visibility: "founder", machine: "test-mac", session_id: "s1", repo: "founderos",
      occurred_at: "2026-10-06T05:30:00.000Z", branch: "feat/demo",
    });
    expect(r.content).toContain("Capture the Mac");
    expect(r.content).toContain("https://github.com/o/r/pull/9");
    expect(r.content).toContain("~/Projects/founderos/src/a.ts");
    expect(r.content).toContain("2026-10-06 09:40 to 2026-10-06 11:00 (Asia/Kolkata)");
    expect(r.content.length).toBeLessThanOrEqual(SESSION_CONTENT_MAX);
    expect(digestRecordSchema.safeParse(r).success).toBe(true);
  });

  it("never includes tool results, thinking, or tool input bodies", () => {
    const r = buildSessionRecord(fixture(), "s1", FALLBACK, CTX)!;
    for (const marker of [TOOL_RESULT_MARKER, THINKING_MARKER, "SECRET-BODY-OLD", "SECRET-BODY-NEW"]) {
      expect(r.content).not.toContain(marker);
    }
  });

  it("caps prompts, prompt length, title and final message", () => {
    const r = buildSessionRecord(fixture({ promptCount: 15 }), "s1", FALLBACK, CTX)!;
    const promptLines = r.content.split("\n").filter((l) => l.startsWith("- founder prompt"));
    expect(promptLines).toHaveLength(MAX_PROMPTS);
    expect(Math.max(...promptLines.map((l) => l.length))).toBeLessThanOrEqual(PROMPT_MAX + 2);
    expect(String(r.metadata["title"]).length).toBeLessThanOrEqual(TITLE_MAX);
    const final = r.content.split("\n").find((l) => l.startsWith("Final message: "))!;
    expect(final.length).toBeLessThanOrEqual("Final message: ".length + FINAL_MESSAGE_MAX);
  });

  it("returns null when the session has no founder prompt", () => {
    const onlyAssistant = line({ ...base, type: "assistant", timestamp: "2026-10-06T04:20:00Z",
      message: { role: "assistant", content: [{ type: "text", text: "Hello there, nothing asked." }] } });
    expect(buildSessionRecord(onlyAssistant, "s2", FALLBACK, CTX)).toBeNull();
  });

  it("tags project null for a cwd outside ~/Projects and ~/Oplify.in", () => {
    const text = fixture().replaceAll(`${HOME}/Projects/founderos/.claude/worktrees/x`, `${HOME}/Documents/scratch`);
    expect(buildSessionRecord(text, "s1", FALLBACK, CTX)!.project).toBeNull();
  });
});

describe("buildMemoryRecord and manifest", () => {
  const file = { path: `${HOME}/.claude/projects/-p/memory/a.md`, text: "  a durable fact  ", mtime: new Date("2026-10-05T00:00:00Z"), slug: "-p" };

  it("keys on the sha256 of the path and is founder-only", () => {
    const r = buildMemoryRecord(file, "founderos", CTX)!;
    expect(r.source_id).toMatch(/^[0-9a-f]{64}$/);
    expect(r.memory_type).toBe("claude_memory");
    expect(r.content).toBe("a durable fact");
    expect(r.metadata).toMatchObject({ visibility: "founder", origin: "mac-claude", slug: "-p" });
  });

  it("skips an empty file", () => {
    expect(buildMemoryRecord({ ...file, text: "   " }, null, CTX)).toBeNull();
  });

  it("builds a manifest that carries only ids", () => {
    const m = buildManifestRecord("-p", "founderos", ["a", "b"]);
    expect(m).toMatchObject({ memory_type: "claude_manifest", content: "", metadata: { slug: "-p", source_ids: ["a", "b"] } });
  });
});

describe("buildAgyRecord", () => {
  const row: AgyConversation = {
    conversation_id: "c-1", title: "", preview: "Wire the dispatcher", step_count: 24,
    last_modified_time: "2026-09-13 17:45:00.777407+00:00", workspace_uris: JSON.stringify([`file://${HOME}/Projects/founderos`]),
  };

  it("builds a mac-agy digest with the walkthrough, project from workspace", () => {
    const r = buildAgyRecord(row, "Walkthrough: changed the dispatcher.", CTX)!;
    expect(r.source).toBe("mac-agy");
    expect(r.project).toBe("founderos");
    expect(r.metadata).toMatchObject({ origin: "mac-agy", visibility: "founder", session_id: "c-1" });
    expect(r.content).toContain("Wire the dispatcher");
    expect(r.content).toContain("Steps: 24");
    expect(r.content).toContain("Walkthrough: changed the dispatcher.");
  });

  it("returns null for a conversation with no title, preview or a valid time", () => {
    expect(buildAgyRecord({ ...row, preview: "" }, null, CTX)).toBeNull();
    expect(buildAgyRecord({ ...row, last_modified_time: "nope" }, null, CTX)).toBeNull();
  });
});

describe("parseDigestInput (VPS side)", () => {
  const good = (id: string, content = "ok content") => JSON.stringify({
    source: "mac-claude", source_id: id, memory_type: "session", project: "founderos", content,
    metadata: { origin: "mac-claude", occurred_at: "2026-10-06T00:00:00.000Z", visibility: "founder" },
  });

  it("accepts valid records and manifests, counts invalid lines", () => {
    const text = [good("a"), "not json", JSON.stringify({ nope: 1 }), JSON.stringify(buildManifestRecord("-p", null, ["x"]))].join("\n");
    const p = parseDigestInput(text);
    expect(p.records.map((r) => r.source_id)).toEqual(["a"]);
    expect(p.manifests).toHaveLength(1);
    expect(p.invalid).toBe(2);
  });

  it("rejects a record that is not visibility founder", () => {
    const bad = good("a").replace('"founder"', '"all"');
    expect(parseDigestInput(bad).invalid).toBe(1);
  });

  it("re-scrubs and drops a record with a secret, reporting id only", () => {
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const p = parseDigestInput([good("leaky", `token ${secret}`), good("clean")].join("\n"));
    expect(p.records.map((r) => r.source_id)).toEqual(["clean"]);
    expect(p.dropped).toEqual(["mac-claude:leaky"]);
    expect(JSON.stringify(p)).not.toContain(secret);
  });

  it("enforces the per-run cap", () => {
    const p = parseDigestInput([good("1"), good("2"), good("3")].join("\n"), 2);
    expect(p.records).toHaveLength(2);
    expect(p.overCap).toBe(1);
  });
});
