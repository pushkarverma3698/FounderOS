/**
 * Success-message wording for synthesizeSkillImpl, in ISOLATION from the real
 * `tsc --noEmit` invocation (that path — actual synthesis + real typecheck —
 * is exercised by skill-synthesizer.test.ts). `node:child_process`'s `exec`
 * is mocked to resolve instantly so this file stays fast: these tests are
 * about STRING CONTENT (does the success message honestly describe the
 * boot-time loader and the current SKILL_SYNTHESIS_ENABLED state), not about
 * whether tsc itself works.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  exec: (
    _cmd: string,
    _opts: unknown,
    callback: (err: unknown, stdout: string, stderr: string) => void,
  ) => callback(null, "", ""),
}));

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { synthesizeSkillImpl } from "../../../src/tools/skill-synthesizer.js";

describe("synthesizeSkillImpl success message — flag-state honesty", () => {
  const originalFlag = process.env["SKILL_SYNTHESIS_ENABLED"];

  afterEach(async () => {
    if (originalFlag === undefined) delete process.env["SKILL_SYNTHESIS_ENABLED"];
    else process.env["SKILL_SYNTHESIS_ENABLED"] = originalFlag;
    try { await fs.unlink(path.resolve("./src/tools/custom/msg_probe_on.ts")); } catch {}
    try { await fs.unlink(path.resolve("./src/tools/custom/msg_probe_off.ts")); } catch {}
  });

  it("says ON + next-restart wording when the flag is currently on", async () => {
    process.env["SKILL_SYNTHESIS_ENABLED"] = "true";
    const res = await synthesizeSkillImpl({
      name: "msg_probe_on",
      description: "flag-on message probe",
      tsCode: `export const probe = 1;\n`,
    });
    expect(res.success).toBe(true);
    expect(res.message).toContain("NEXT process restart");
    expect(res.message).toContain("SKILL_SYNTHESIS_ENABLED is currently ON");
    // The old, no-longer-true claim must be gone.
    expect(res.message).not.toContain("successfully synthesized, typechecked, and saved");
  });

  it("says OFF + will-NOT-load wording when the flag is currently off", async () => {
    process.env["SKILL_SYNTHESIS_ENABLED"] = "false";
    const res = await synthesizeSkillImpl({
      name: "msg_probe_off",
      description: "flag-off message probe",
      tsCode: `export const probe = 1;\n`,
    });
    expect(res.success).toBe(true);
    expect(res.message).toContain("SKILL_SYNTHESIS_ENABLED is currently OFF");
    expect(res.message).toContain("will NOT load it even after a restart");
  });
});
