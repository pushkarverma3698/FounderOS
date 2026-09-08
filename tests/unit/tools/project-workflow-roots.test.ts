/**
 * The engineering agent must be able to read the code it is running.
 *
 * WHAT WAS BROKEN (issue #426 item 5, open since 2026-08-08, zero comments).
 * `projectRoot()` resolves to `$HOME/Projects`. On production that is
 * `/home/founderos/Projects`, which contains `artifacts/` and nothing else —
 * the deployed application lives at `/opt/founderos`. So `project_workflow`'s
 * `list_files` and `read_file`, run from inside a live conversation, could not
 * see a single source file of the system they were being asked about.
 *
 * That is not an abstract gap. On 2026-09-06 the founder asked why `/jobs` was
 * returning stale roles and the reply was: "Investigation incomplete. The root
 * cause could not be determined because tool limits were reached before
 * inspecting the /jobs handler." It never was determined. The agent was asked
 * to diagnose itself with its own source out of reach.
 *
 * The fix adds the RUNNING APPLICATION'S OWN ROOT as a second allowed root —
 * derived from the process, never from an argument — and changes nothing about
 * what is blocked: secrets stay blocked, traversal stays blocked, everything
 * outside both roots stays blocked, and `run_command` stays HITL-gated.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  projectRoot,
  projectRoots,
  isProjectPath,
  resolveProjectPath,
} from "../../../src/tools/project-workflow.js";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env["HOME"] = ORIGINAL["HOME"];
  delete process.env["PROJECT_WORKFLOW_ROOT"];
});

describe("projectRoots", () => {
  it("includes the ~/Projects root it always had", () => {
    expect(projectRoots()).toContain(projectRoot());
  });

  it("includes the running application's own root", () => {
    // This test file lives inside the repo, so the repo root must be reachable.
    const roots = projectRoots();
    expect(roots.some((r) => process.cwd().startsWith(r))).toBe(true);
  });

  it("never returns duplicates when the app already sits under ~/Projects (dev laptop)", () => {
    expect(new Set(projectRoots()).size).toBe(projectRoots().length);
  });

  it("honours PROJECT_WORKFLOW_ROOT as the primary root", () => {
    process.env["PROJECT_WORKFLOW_ROOT"] = "/tmp/somewhere";
    expect(projectRoot()).toBe("/tmp/somewhere");
    expect(projectRoots()[0]).toBe("/tmp/somewhere");
  });
});

describe("isProjectPath", () => {
  it("allows a source file under the application root — the /jobs handler case", () => {
    const appRoot = projectRoots().find((r) => process.cwd().startsWith(r))!;
    expect(isProjectPath(`${appRoot}/src/gateway/jobhunt-view.ts`)).toBe(true);
  });

  it("still blocks a path outside every root", () => {
    expect(isProjectPath("/etc/passwd")).toBe(false);
    expect(isProjectPath("/var/log/syslog")).toBe(false);
  });

  it("still blocks secrets inside an allowed root — widening the roots must not widen the reads", () => {
    const appRoot = projectRoots().find((r) => process.cwd().startsWith(r))!;
    expect(isProjectPath(`${appRoot}/.env`)).toBe(false);
    expect(isProjectPath(`${appRoot}/.env.production`)).toBe(false);
    expect(isProjectPath(`${appRoot}/deploy/server.pem`)).toBe(false);
    expect(isProjectPath(`${appRoot}/config/credentials.json`)).toBe(false);
  });

  it("still blocks traversal out of a root", () => {
    expect(isProjectPath(`${projectRoot()}/../../etc/shadow`)).toBe(false);
  });

  it("allows each root itself", () => {
    for (const root of projectRoots()) expect(isProjectPath(root)).toBe(true);
  });
});

describe("resolveProjectPath", () => {
  it("resolves a relative path against a root where it actually exists", () => {
    // "src" does not exist under ~/Projects, but does under the app root.
    const resolved = resolveProjectPath("src");
    expect(isProjectPath(resolved)).toBe(true);
    expect(resolved.endsWith("/src")).toBe(true);
  });

  it("leaves an absolute path alone", () => {
    expect(resolveProjectPath("/tmp/x")).toBe("/tmp/x");
  });

  it("falls back to the primary root for a path that exists nowhere", () => {
    expect(resolveProjectPath("definitely-not-a-real-directory-9f2a")).toBe(
      `${projectRoot()}/definitely-not-a-real-directory-9f2a`,
    );
  });
});
