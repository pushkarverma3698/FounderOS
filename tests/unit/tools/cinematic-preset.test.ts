/**
 * Unit tests — apply_cinematic_preset tool
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeApplyCinematicPreset,
  bundledPresetsRoot,
  resolvePresetSourceDir,
  personalizePresetFiles,
} from "../../../src/tools/cinematic-preset.js";

describe("cinematic-preset tool", () => {
  let projectsRoot: string;
  let prevRoot: string | undefined;

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), "cinematic-projects-"));
    prevRoot = process.env["PROJECT_WORKFLOW_ROOT"];
    process.env["PROJECT_WORKFLOW_ROOT"] = projectsRoot;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env["PROJECT_WORKFLOW_ROOT"];
    else process.env["PROJECT_WORKFLOW_ROOT"] = prevRoot;
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("bundled presets exist for all four presets", () => {
    for (const preset of ["neon", "glass", "terminal", "minimal"] as const) {
      expect(resolvePresetSourceDir(preset)).toBeTruthy();
      expect(existsSync(join(bundledPresetsRoot(), preset, "index.html"))).toBe(true);
    }
  });

  it("copies neon preset and personalizes client placeholder", () => {
    const target = join(projectsRoot, "cinematic-agentops");
    const res = executeApplyCinematicPreset({
      preset: "neon",
      targetDir: target,
      client: "AgentOps",
    });
    expect(res.success).toBe(true);
    const html = readFileSync(join(target, "index.html"), "utf-8");
    expect(html).toContain("AgentOps");
    expect(html).not.toContain("{{CLIENT}}");
    expect(existsSync(join(target, "styles.css"))).toBe(true);
  });

  it("rejects invalid preset", () => {
    const res = executeApplyCinematicPreset({
      preset: "holographic",
      targetDir: join(projectsRoot, "x"),
    });
    expect(res.success).toBe(false);
  });

  it("rejects target outside Projects", () => {
    const res = executeApplyCinematicPreset({
      preset: "neon",
      targetDir: "/tmp/outside",
    });
    expect(res.success).toBe(false);
  });

  it("accepts relative targetDir under ~/Projects (not process.cwd())", () => {
    const res = executeApplyCinematicPreset({
      preset: "glass",
      targetDir: "glass-template-test",
      client: "TestCo",
    });
    expect(res.success).toBe(true);
    const target = join(projectsRoot, "glass-template-test");
    expect(existsSync(join(target, "index.html"))).toBe(true);
  });

  it("accepts ~/Projects/... targetDir", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "cinematic-home-"));
    const fakeProjects = join(fakeHome, "Projects");
    const prevRoot = process.env["PROJECT_WORKFLOW_ROOT"];
    const prevHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;
    process.env["PROJECT_WORKFLOW_ROOT"] = fakeProjects;
    try {
      const res = executeApplyCinematicPreset({
        preset: "minimal",
        targetDir: "~/Projects/tilde-path-test",
        client: "TildeCo",
      });
      expect(res.success).toBe(true);
      expect(existsSync(join(fakeProjects, "tilde-path-test", "index.html"))).toBe(true);
    } finally {
      if (prevRoot === undefined) delete process.env["PROJECT_WORKFLOW_ROOT"];
      else process.env["PROJECT_WORKFLOW_ROOT"] = prevRoot;
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("personalizePresetFiles replaces placeholders", () => {
    const dir = mkdtempSync(join(tmpdir(), "preset-personalize-"));
    const file = join(dir, "index.html");
    writeFileSync(file, "<h1>{{CLIENT}}</h1>");
    personalizePresetFiles(dir, "Langfuse");
    expect(readFileSync(file, "utf-8")).toBe("<h1>Langfuse</h1>");
    rmSync(dir, { recursive: true, force: true });
  });
});
