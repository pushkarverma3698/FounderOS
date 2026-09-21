/**
 * Architectural constraints — ensuring the Worker Contract architecture
 * maintains proper boundaries and does not violate design principles.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKERS_DIR = resolve("src/workers");
const CONTRACTS_DIR = join(WORKERS_DIR, "contracts");
const RUNTIMES_DIR = join(WORKERS_DIR, "runtimes");
const CAPABILITIES_DIR = join(WORKERS_DIR, "capabilities");

/** Recursively collect all .ts files in a directory. */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("Architectural constraints", () => {
  const contractFiles = collectTsFiles(CONTRACTS_DIR);
  const runtimeFiles = collectTsFiles(RUNTIMES_DIR);
  const capabilityFiles = collectTsFiles(CAPABILITIES_DIR);

  // 1. Worker Contracts do not directly execute tools
  test("contracts do not import ToolGateway", () => {
    for (const file of contractFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("ToolGateway");
      expect(content).not.toContain("toolGateway");
      expect(content).not.toContain("gateway.js");
    }
  });

  // 2. Worker Contracts do not contain tool transport details
  test("contracts do not reference transport types", () => {
    for (const file of contractFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("ToolTransport");
      expect(content).not.toContain("InternalFunctionAdapter");
      expect(content).not.toContain("McpAdapter");
      expect(content).not.toContain("HttpAdapter");
    }
  });

  // 3. Worker Contracts do not depend directly on Antigravity
  test("contracts do not import Antigravity-specific modules", () => {
    for (const file of contractFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("antigravity");
      expect(content).not.toContain("Antigravity");
    }
  });

  // 4. Worker Contracts do not contain runtime-specific prompts
  test("contracts do not contain system prompts or LLM templates", () => {
    for (const file of contractFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("SystemMessage");
      expect(content).not.toContain("HumanMessage");
      expect(content).not.toContain("ChatPromptTemplate");
      expect(content).not.toContain("system_prompt");
    }
  });

  // 5. Runtime adapters do not own durable business state
  test("runtime adapters do not import database modules", () => {
    for (const file of runtimeFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("from \"../../db/");
      expect(content).not.toContain("from '../db/");
      expect(content).not.toContain("drizzle");
    }
  });

  // 6. ToolRegistry remains the tool-definition authority
  test("capability resolver does not define tool schemas", () => {
    for (const file of capabilityFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("ToolInputSchema");
      // manifest.ts imports ToolDefinition for reading, which is fine
      // but should not create new ToolDefinitions
      if (!file.includes("manifest.ts")) {
        expect(content).not.toContain("ToolDefinition");
      }
    }
  });

  // 7. Workers module does not import from Claude Code, OpenClaw, or Antigravity
  test("workers module has no runtime-specific dependencies", () => {
    const allWorkerFiles = collectTsFiles(WORKERS_DIR);
    for (const file of allWorkerFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("claude_code");
      expect(content).not.toContain("ClaudeCode");
      expect(content).not.toContain("openclaw");
      expect(content).not.toContain("OpenClaw");
    }
  });

  // 8. Manifest entries strip transport details
  test("manifest types do not include transport fields", () => {
    const manifestFile = readFileSync(join(CAPABILITIES_DIR, "manifest.ts"), "utf-8");
    // The ToolManifestEntry interface should NOT have transport/layer/executorRef
    // Check by inspecting the interface definition
    const interfaceMatch = manifestFile.match(/interface ToolManifestEntry \{[\s\S]*?\}/);
    expect(interfaceMatch).toBeTruthy();
    const iface = interfaceMatch![0];
    expect(iface).not.toContain("transport");
    expect(iface).not.toContain("layer");
    expect(iface).not.toContain("executorRef");
    expect(iface).not.toContain("metadata");
  });

  // 9. Contracts do not bypass approval by calling tools directly
  test("contracts have no tool execution code", () => {
    for (const file of contractFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain(".invoke(");
      expect(content).not.toContain(".execute(");
      expect(content).not.toContain("adapter.invoke");
    }
  });

  // 10. DEPARTMENT_TOOLS is strictly a legacy compatibility layer
  test("workers architecture never imports legacy DEPARTMENT_TOOLS", () => {
    const allWorkerFiles = collectTsFiles(WORKERS_DIR);
    for (const file of allWorkerFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("DEPARTMENT_TOOLS");
    }
  });
});
