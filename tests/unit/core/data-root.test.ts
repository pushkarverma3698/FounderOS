import { describe, it, expect } from "vitest";
import { DEFAULT_DATA_ROOT, dataRoot } from "../../../src/core/data-root.js";
import { notifyStatePath } from "../../../src/evolution/jobhunt-notify-state.js";
import { boardHealthDeps } from "../../../src/tools/jobhunt/board-health.js";

describe("dataRoot — the one place the deploy-surviving directory is decided", () => {
  it("defaults to /opt/founderos-data", () => {
    expect(DEFAULT_DATA_ROOT).toBe("/opt/founderos-data");
    expect(dataRoot({})).toBe("/opt/founderos-data");
  });

  it("honours FOUNDEROS_DATA_ROOT, trimmed", () => {
    expect(dataRoot({ FOUNDEROS_DATA_ROOT: "  /srv/data  " })).toBe("/srv/data");
  });

  it("treats a blank value as unset", () => {
    expect(dataRoot({ FOUNDEROS_DATA_ROOT: "   " })).toBe("/opt/founderos-data");
    expect(dataRoot({ FOUNDEROS_DATA_ROOT: "" })).toBe("/opt/founderos-data");
  });

  it("is what the modules that keep files there actually use, so they cannot drift apart", () => {
    const previous = process.env["FOUNDEROS_DATA_ROOT"];
    process.env["FOUNDEROS_DATA_ROOT"] = "/srv/moved";
    try {
      expect(boardHealthDeps().root).toBe("/srv/moved");
      expect(notifyStatePath()).toBe("/srv/moved/jobhunt-findings-state.json");
    } finally {
      if (previous === undefined) delete process.env["FOUNDEROS_DATA_ROOT"];
      else process.env["FOUNDEROS_DATA_ROOT"] = previous;
    }
  });
});
