import { describe, expect, it } from "vitest";
import { runPipelineSpec, type Deps } from "../../../scripts/pipeline-spec.js";
import { verbatimAskSection } from "../../../src/tools/dispatch-spec-intake.js";
import { readPending } from "../../../src/tools/pipeline-pending.js";
import { SPEC_OUT_FILE } from "../../../src/tools/pipeline-spec.js";
import { memFs } from "../../helpers/mem-fs.js";
import { SHA_A, SHA_B } from "../../helpers/contract-fixture.js";

const ON = { AGENT_PIPELINE_V2: "1", FOUNDEROS_CONTRACTS_DIR: "/c" };
const REPO = "acme/widgets";
const TEST_FILE = "tests/unit/oracle.test.ts";
const body = ["## Goal", "", "x", "", ...verbatimAskSection("make it stable")].join("\n");
const draft = {
  task_type: "bugfix",
  current_behavior: { text: "flaps", citations: [{ path: "src/o.ts", line: 3 }] },
  expected_behavior: "stable",
  scope: ["src/o.ts"],
  locked_tests: [TEST_FILE],
  oracle: { id: "o1", kind: "unit-only", before: {}, expected_after: {} },
  risk: "low",
};
const manifest = [`??\tfile\t40\t${SPEC_OUT_FILE}`, `??\tfile\t900\t${TEST_FILE}`].join("\n");
const mk = (): Deps & { fs: ReturnType<typeof memFs> } => ({ fs: memFs(), nonce: () => "n0nce_abc123", now: () => new Date("2026-10-06T00:00:00Z") });
const verifyIn = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ issue_body: body, repo: REPO, base_sha: SHA_A, model_output: JSON.stringify(draft), manifest, line_counts: { "src/o.ts": 50 }, ...over });

describe("scripts/pipeline-spec", () => {
  it("flag off: every subcommand is a no-op and writes nothing", async () => {
    const d = mk();
    for (const sub of ["ask", "verify", "record"]) {
      expect(JSON.parse(await runPipelineSpec(sub, "{}", {}, d))).toEqual({ status: "DISABLED" });
      expect(JSON.parse(await runPipelineSpec(sub, "{}", { AGENT_PIPELINE_V2: "true" }, d))).toEqual({ status: "DISABLED" });
    }
    expect(d.fs.files.size).toBe(0);
  });

  it("ask returns the verbatim ask", async () => {
    expect(JSON.parse(await runPipelineSpec("ask", body, ON, mk()))).toEqual({ ok: true, ask: "make it stable" });
  });

  it("verify: PASS, REJECT and bad input are all one JSON line", async () => {
    const d = mk();
    expect(JSON.parse(await runPipelineSpec("verify", verifyIn(), ON, d)).status).toBe("PASS");
    expect(JSON.parse(await runPipelineSpec("verify", verifyIn({ model_output: "nope" }), ON, d)).status).toBe("REJECT");
    expect(JSON.parse(await runPipelineSpec("verify", "not json", ON, d)).status).toBe("FAILED");
    expect(JSON.parse(await runPipelineSpec("verify", JSON.stringify({ repo: REPO }), ON, d)).status).toBe("FAILED");
    expect(JSON.parse(await runPipelineSpec("bogus", "{}", ON, d)).status).toBe("FAILED");
  });

  it("record: writes a valid pending record and renders a card with Approve", async () => {
    const d = mk();
    const v = JSON.parse(await runPipelineSpec("verify", verifyIn(), ON, d));
    const out = JSON.parse(
      await runPipelineSpec(
        "record",
        JSON.stringify({ repo: REPO, issue: 7, contract: v.contract, effective_risk: v.effective_risk, fingerprint: v.fingerprint, spec_commit: SHA_B }),
        ON,
        d,
      ),
    );
    expect(out.status).toBe("RECORDED");
    expect(out.nonce).toBe("n0nce_abc123");
    expect(JSON.stringify(out.reply_markup)).toContain("cp:approve:n0nce_abc123");
    expect(out.parts.join("")).toContain("Spec for");
    const rec = await readPending(d.fs, "/c", "n0nce_abc123");
    expect(rec.ok && rec.value.kind === "spec" && rec.value.contract.ask).toBe("make it stable");
    expect(rec.ok && rec.value.kind === "spec" && rec.value.spec_commit).toBe(SHA_B);
  });

  it("record: refuses a bad sha or a contract for another repo, and writes nothing", async () => {
    const d = mk();
    const v = JSON.parse(await runPipelineSpec("verify", verifyIn(), ON, d));
    const base = { repo: REPO, issue: 7, contract: v.contract, effective_risk: "low", fingerprint: v.fingerprint, spec_commit: SHA_B };
    expect(JSON.parse(await runPipelineSpec("record", JSON.stringify({ ...base, spec_commit: "abc" }), ON, d)).status).toBe("FAILED");
    expect(JSON.parse(await runPipelineSpec("record", JSON.stringify({ ...base, repo: "evil/repo" }), ON, d)).status).toBe("FAILED");
    expect(d.fs.files.size).toBe(0);
  });

  it("failfirst: judges the vitest report, and refuses input that is not {report, locked_tests}", async () => {
    const report = JSON.stringify({ testResults: [{ name: `/w/${TEST_FILE}`, message: "", assertionResults: [{ status: "passed" }] }] });
    expect(JSON.parse(await runPipelineSpec("failfirst", JSON.stringify({ report, locked_tests: [TEST_FILE] }), ON, mk())).status).toBe("PASSES");
    expect(JSON.parse(await runPipelineSpec("failfirst", JSON.stringify({ report, locked_tests: [7] }), ON, mk())).status).toBe("FAILED");
    expect(JSON.parse(await runPipelineSpec("failfirst", JSON.stringify({ locked_tests: [TEST_FILE] }), ON, mk())).status).toBe("FAILED");
  });
});
