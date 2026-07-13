import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeArtifact } from "../../../src/tools/artifact.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ARTIFACTS_ROOT = path.resolve("./artifacts");

describe("writeArtifact tool", () => {
  const threadId = "test_thread_123";
  const artifactId = "test_analysis";
  const title = "Competitor Analysis";
  const content = "Linear vs Jira comparison table...";
  const targetDir = path.join(ARTIFACTS_ROOT, threadId);
  const targetFile = path.join(targetDir, `${artifactId}.md`);

  beforeEach(async () => {
    // Cleanup any leftovers
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch {}
  });

  afterEach(async () => {
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch {}
  });

  it("writes artifact file under the thread_id directory", async () => {
    const result = await writeArtifact.invoke(
      { id: artifactId, title, content },
      { configurable: { thread_id: threadId } }
    );

    expect(result).toContain("written successfully");

    // Verify file content
    const written = await fs.readFile(targetFile, "utf-8");
    expect(written).toContain(`# ${title}`);
    expect(written).toContain(content);
  });

  it("defaults thread_id and sanitizes traversal path attempts", async () => {
    const maliciousId = "../../malicious";
    const result = await writeArtifact.invoke(
      { id: maliciousId, title, content },
      { configurable: { thread_id: "../malicious_thread" } }
    );

    expect(result).toContain("written successfully");
    
    // Traversal should be flattened to safe characters
    const expectedDir = path.join(ARTIFACTS_ROOT, ".._malicious_thread");
    const expectedFile = path.join(expectedDir, ".._.._malicious.md");
    
    const written = await fs.readFile(expectedFile, "utf-8");
    expect(written).toBeDefined();

    // Clean up malicious artifacts dir
    await fs.rm(expectedDir, { recursive: true, force: true });
  });
});
