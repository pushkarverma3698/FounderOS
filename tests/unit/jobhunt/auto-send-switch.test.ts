import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoSendSwitchPath, readRuntimeSwitch, writeRuntimeSwitch } from "../../../src/tools/jobhunt/auto-send-switch.js";

let dir = "";
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autosend-"));
  saved = process.env["APPLY_PROFILE_PATH"];
  process.env["APPLY_PROFILE_PATH"] = join(dir, "apply-profile.json");
});
afterEach(() => {
  if (saved === undefined) delete process.env["APPLY_PROFILE_PATH"];
  else process.env["APPLY_PROFILE_PATH"] = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("runtime switch", () => {
  it("is off when the file is missing", async () => {
    expect(await readRuntimeSwitch("default")).toBe(false);
  });
  it("round-trips on and off per profile", async () => {
    await writeRuntimeSwitch("p1", true);
    expect(await readRuntimeSwitch("p1")).toBe(true);
    expect(await readRuntimeSwitch("p2")).toBe(false);
    await writeRuntimeSwitch("p1", false);
    expect(await readRuntimeSwitch("p1")).toBe(false);
  });
  it("reads a corrupt or wrong-shaped file as off", async () => {
    writeFileSync(autoSendSwitchPath("p1"), "{not json");
    expect(await readRuntimeSwitch("p1")).toBe(false);
    writeFileSync(autoSendSwitchPath("p1"), JSON.stringify({ on: "yes" }));
    expect(await readRuntimeSwitch("p1")).toBe(false);
  });
});
