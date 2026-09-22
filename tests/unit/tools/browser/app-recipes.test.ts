/**
 * Unit tests — app recipes, the PURE half of the browser gate.
 *
 * The two rules worth defending here both come from a measured failure on the
 * first live runs against OplifyMessage/oplify-messaging-app:
 *
 *  · An unreadable diff must WIDEN the gate, never narrow it. "I could not read
 *    the change list" and "the change list is irrelevant" are different answers,
 *    and collapsing them into a skip is the did-not-run-reads-as-clean failure.
 *  · An uncaught exception is never downgraded, whoever it names. An app that
 *    throws instead of handling a failed request is broken for any visitor whose
 *    network hiccups — the single most valuable finding this node can produce.
 */

import { describe, it, expect } from "vitest";
import {
  APP_RECIPES,
  recipeForRepo,
  recipeIsTriggered,
  resolveCommand,
  recipeTargets,
  annotateExpectedExternal,
  OFFLINE_API_ORIGIN,
} from "../../../../src/tools/browser/app-recipes.js";
import { DISPATCH_REPO_ALLOWLIST } from "../../../../src/tools/dispatch-repos.js";
import type { UiDefect } from "../../../../src/tools/browser/ui-analyze.js";

describe("APP_RECIPES — shape", () => {
  it("only describes repositories dispatch is actually allowed to touch", () => {
    // A recipe for a repo off the allowlist is a boot command for a checkout the
    // loop can never produce — dead config that reads as coverage.
    const allowed = DISPATCH_REPO_ALLOWLIST.map((r) => r.toLowerCase());
    for (const recipe of APP_RECIPES) {
      expect(allowed).toContain(recipe.repo.toLowerCase());
    }
  });

  it("gives every recipe a start command, a ready path and at least one route", () => {
    for (const recipe of APP_RECIPES) {
      expect(recipe.start.length).toBeGreaterThan(0);
      expect(recipe.readyPath.startsWith("/")).toBe(true);
      expect(recipe.routes.length).toBeGreaterThan(0);
      expect(recipe.authNote.length).toBeGreaterThan(0);
    }
  });

  it("aims the offline API at a port Chromium will actually dial", () => {
    // Chromium refuses its own restricted list (9/discard, 19/chargen, 25/smtp…)
    // with net::ERR_UNSAFE_PORT before any connection, producing a console error
    // attributed to no URL — which the annotator then cannot label as ours.
    const port = Number(OFFLINE_API_ORIGIN.split(":").pop());
    expect(port).toBeGreaterThan(1024);
  });
});

describe("recipeForRepo", () => {
  it("matches case-insensitively", () => {
    expect(recipeForRepo("oplifymessage/OPLIFY-MESSAGING-APP")?.repo).toBe(
      "OplifyMessage/oplify-messaging-app",
    );
  });

  it("returns null for a repo with no boot instructions", () => {
    expect(recipeForRepo("pushkarverma3698/FounderOS")).toBeNull();
  });
});

describe("recipeIsTriggered", () => {
  const recipe = APP_RECIPES[0]!;

  it("runs when a changed file sits under a trigger path", () => {
    expect(recipeIsTriggered(recipe, ["src/pages/Login.jsx"])).toBe(true);
  });

  it("skips when nothing changed sits under one", () => {
    expect(recipeIsTriggered(recipe, ["README.md", "docs/api.md"])).toBe(false);
  });

  it("RUNS on an empty change list — unknown must widen the gate, not narrow it", () => {
    expect(recipeIsTriggered(recipe, [])).toBe(true);
  });
});

describe("resolveCommand / recipeTargets", () => {
  it("substitutes the chosen port into every argument that names it", () => {
    expect(resolveCommand(["npm", "run", "preview", "--", "--port", "{PORT}"], 4321)).toEqual([
      "npm",
      "run",
      "preview",
      "--",
      "--port",
      "4321",
    ]);
  });

  it("builds one absolute URL per route", () => {
    const recipe = APP_RECIPES[0]!;
    const targets = recipeTargets(recipe, "http://127.0.0.1:4173");
    expect(targets).toHaveLength(recipe.routes.length);
    expect(targets[0]?.url).toBe(`http://127.0.0.1:4173${recipe.routes[0]?.path}`);
  });
});

describe("annotateExpectedExternal", () => {
  const expected = [{ match: "127.0.0.1:59999", reason: "the backend is not started by this gate" }];

  const defect = (kind: UiDefect["kind"], severity: UiDefect["severity"], detail: string): UiDefect => ({
    kind,
    severity,
    detail,
  });

  it("downgrades a failed asset belonging to the dependency it did not provide", () => {
    const [row] = annotateExpectedExternal(
      [defect("failed-asset", "high", "asked for http://127.0.0.1:59999/api/v1/me")],
      expected,
    );
    expect(row?.severity).toBe("low");
    expect(row?.detail).toContain("expected — not provided by this gate");
    expect(row?.detail).toContain("the backend is not started by this gate");
  });

  it("downgrades the matching console error too", () => {
    const [row] = annotateExpectedExternal(
      [defect("console-error", "medium", "ERR_CONNECTION_REFUSED (http://127.0.0.1:59999/api/v1/me)")],
      expected,
    );
    expect(row?.severity).toBe("low");
  });

  it("NEVER downgrades an uncaught exception, even one naming the same host", () => {
    const [row] = annotateExpectedExternal(
      [defect("page-error", "high", "TypeError fetching http://127.0.0.1:59999/api/v1/me")],
      expected,
    );
    expect(row?.severity).toBe("high");
    expect(row?.detail).not.toContain("expected — not provided");
  });

  it("leaves a defect that names nothing expected exactly as it was", () => {
    const original = defect("failed-asset", "high", "asked for /assets/index.css");
    expect(annotateExpectedExternal([original], expected)).toEqual([original]);
  });

  it("drops nothing — a row removed from a report is a row nobody can argue with", () => {
    const rows = [
      defect("failed-asset", "high", "http://127.0.0.1:59999/a"),
      defect("page-error", "high", "boom"),
      defect("missing-h1", "medium", "no h1"),
    ];
    expect(annotateExpectedExternal(rows, expected)).toHaveLength(3);
  });

  it("is a no-op when the recipe declares no expected dependencies", () => {
    const rows = [defect("failed-asset", "high", "http://127.0.0.1:59999/a")];
    expect(annotateExpectedExternal(rows)).toEqual(rows);
  });
});
