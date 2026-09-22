/**
 * Unit tests — booting an app from a checkout.
 *
 * No Chromium, no npm, no network. Commands are `node -e` one-liners, which is
 * enough to prove the three things that matter: a non-zero exit is REPORTED and
 * not thrown, output is captured for the report, and a server that never answers
 * gives up instead of hanging the sweep forever.
 */

import { describe, it, expect } from "vitest";
import {
  runCommand,
  waitForServer,
  bootApp,
  OUTPUT_TAIL_CHARS,
} from "../../../../src/tools/browser/app-server.js";
import type { AppRecipe } from "../../../../src/tools/browser/app-recipes.js";

const NO_ENV: Record<string, string> = {};

describe("runCommand", () => {
  it("reports a clean exit", async () => {
    const res = await runCommand(["node", "-e", "process.exit(0)"], process.cwd(), NO_ENV, 20_000);
    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it("RETURNS a failure instead of throwing — a crash here would produce no row at all", async () => {
    const res = await runCommand(
      ["node", "-e", "console.error('boom'); process.exit(7)"],
      process.cwd(),
      NO_ENV,
      20_000,
    );
    expect(res.code).toBe(7);
    expect(res.output).toContain("boom");
  });

  it("reports a command that does not exist rather than rejecting", async () => {
    const res = await runCommand(["definitely-not-a-real-binary-xyz"], process.cwd(), NO_ENV, 20_000);
    expect(res.code).toBeNull();
    expect(res.output.length).toBeGreaterThan(0);
  });

  it("kills a command that overruns its timeout", async () => {
    const res = await runCommand(
      ["node", "-e", "setTimeout(()=>{}, 60000)"],
      process.cwd(),
      NO_ENV,
      300,
    );
    expect(res.timedOut).toBe(true);
  });

  it("keeps only the tail of a chatty command, so one build cannot blow up the report", async () => {
    const res = await runCommand(
      ["node", "-e", "process.stdout.write('x'.repeat(20000))"],
      process.cwd(),
      NO_ENV,
      20_000,
    );
    expect(res.output.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS + 1);
  });
});

describe("waitForServer", () => {
  it("gives up rather than blocking the sweep forever", async () => {
    // Port 1 has nothing on it and the test harness blocks outbound network
    // anyway; either way the poll loop must end on its own deadline.
    const ready = await waitForServer("http://127.0.0.1:1/", 200, 20);
    expect(ready).toBe(false);
  });
});

describe("bootApp", () => {
  const failingBuild: AppRecipe = {
    repo: "example/app",
    label: "Example",
    install: ["node", "-e", "process.exit(0)"],
    build: ["node", "-e", "console.error('build blew up'); process.exit(1)"],
    start: ["node", "-e", "setTimeout(()=>{}, 60000)"],
    port: 45999,
    readyPath: "/",
    routes: [{ id: "home", path: "/" }],
    authNote: "n/a",
    triggerPaths: ["src/"],
  };

  it("names the BUILD as the failing stage and never starts a server", async () => {
    const res = await bootApp(failingBuild, process.cwd());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("build");
    expect(res.output).toContain("build blew up");
    // The message has to be readable by someone who did not write this code.
    expect(res.detail).toContain("does not build");
  });

  it("names the INSTALL as the failing stage when dependencies cannot be fetched", async () => {
    const res = await bootApp(
      { ...failingBuild, install: ["node", "-e", "process.exit(3)"] },
      process.cwd(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("install");
  });

  it("reports a server that exits instead of serving", async () => {
    const res = await bootApp(
      {
        ...failingBuild,
        build: undefined as unknown as AppRecipe["build"],
        start: ["node", "-e", "process.exit(4)"],
      },
      process.cwd(),
      { skipInstall: true },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stage).toBe("start");
    expect(res.detail).toContain("exited 4");
  });

  it("gives up on a dead server in seconds, not after the full readiness timeout", async () => {
    // Without the give-up predicate this waited out READY_TIMEOUT_MS (90s) for a
    // process that had already exited — a minute and a half of sweep time per
    // broken branch, for information available in the first 200ms.
    const started = Date.now();
    await bootApp(
      { ...failingBuild, build: undefined as unknown as AppRecipe["build"], start: ["node", "-e", "process.exit(1)"] },
      process.cwd(),
      { skipInstall: true },
    );
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
