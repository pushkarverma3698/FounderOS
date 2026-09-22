/**
 * Unit tests — the `pnpm qa:app` CLI contract and its three verdict renderings.
 *
 * The exit codes are the contract pr-brain reads, and the whole reason there are
 * THREE of them is that 0 would make "this gate did not run" look exactly like
 * "this gate found nothing". Every skipped and failed rendering must say, in
 * words, that no page was rendered — a reviewer who reads a SKIPPED pack as a
 * clean one has been misled by the tool, not by the executor.
 */

import { describe, it, expect } from "vitest";
import {
  parseAppArgs,
  renderHeader,
  renderSkipped,
  renderBootFailure,
  EXIT_CLEAN,
  EXIT_BLOCKING,
  EXIT_NOT_APPLICABLE,
} from "../../../scripts/qa-app.js";
import { APP_RECIPES } from "../../../src/tools/browser/app-recipes.js";

const recipe = APP_RECIPES[0]!;

describe("exit codes", () => {
  it("keeps 'did not run' distinguishable from 'found nothing'", () => {
    expect(new Set([EXIT_CLEAN, EXIT_BLOCKING, EXIT_NOT_APPLICABLE]).size).toBe(3);
  });
});

describe("parseAppArgs", () => {
  it("defaults to both viewports — a layout breaks on the phone first", () => {
    expect(parseAppArgs([]).viewports).toEqual(["desktop", "mobile"]);
  });

  it("reads the checkout, repo, output dir and port", () => {
    const args = parseAppArgs([
      "--dir", "/opt/review/app",
      "--repo", "OplifyMessage/oplify-messaging-app",
      "--out", "/tmp/pack",
      "--port", "4200",
    ]);
    expect(args.dir).toBe("/opt/review/app");
    expect(args.repo).toBe("OplifyMessage/oplify-messaging-app");
    expect(args.out).toBe("/tmp/pack");
    expect(args.port).toBe(4200);
  });

  it("splits a comma-separated change list and drops blanks", () => {
    expect(parseAppArgs(["--changed", "src/a.jsx, ,src/b.jsx"]).changed).toEqual([
      "src/a.jsx",
      "src/b.jsx",
    ]);
  });

  it("ignores a viewport name it does not know rather than rendering nothing", () => {
    expect(parseAppArgs(["--viewport", "watch"]).viewports).toEqual(["desktop", "mobile"]);
  });

  it("treats an unparseable port as absent so the recipe default still applies", () => {
    expect(parseAppArgs(["--port", "not-a-number"]).port).toBeUndefined();
  });
});

describe("renderHeader", () => {
  it("prints the coverage limit on every run, pass or fail", () => {
    const header = renderHeader(recipe, "http://127.0.0.1:4173");
    expect(header).toContain("Coverage");
    expect(header).toContain(recipe.authNote);
    expect(header).toContain(recipe.repo);
  });
});

describe("renderSkipped", () => {
  it("says no page was rendered, in words, and names what to do about it", () => {
    const md = renderSkipped("acme/thing", "no app recipe exists for this repository");
    expect(md).toContain("SKIPPED");
    expect(md).toContain("No page on this branch was rendered");
    expect(md).toContain("not** a clean visual result");
  });
});

describe("renderBootFailure", () => {
  it("names the stage, keeps the output, and forbids reading it as clean", () => {
    const md = renderBootFailure(recipe, {
      ok: false,
      stage: "build",
      detail: "`npm run build` exited 1.",
      output: "vite: Build failed",
    });
    expect(md).toContain("boot-build");
    expect(md).toContain("could not be built");
    expect(md).toContain("vite: Build failed");
    expect(md).toContain("must not read this as an absence of visual defects");
  });

  it("still renders a pack when the failing command produced no output at all", () => {
    const md = renderBootFailure(recipe, { ok: false, stage: "start", detail: "exited 4.", output: "" });
    expect(md).toContain("(no output captured)");
  });
});
