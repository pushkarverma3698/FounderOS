import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  SPEC_OUT_FILE,
  assembleContract,
  checkChanges,
  extractAsk,
  parseManifest,
  runPassP,
} from "../../../src/tools/pipeline-spec.js";
import { VERBATIM_HEADING, verbatimAskSection } from "../../../src/tools/dispatch-spec-intake.js";
import { SHA_A } from "../../helpers/contract-fixture.js";

const REPO = "acme/widgets";
const TEST_FILE = "tests/unit/tools/oracle.test.ts";

/** What the model is asked to write: no ask, repo, base_sha, version or citation sha. */
function modelDraft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_type: "bugfix",
    current_behavior: { text: "the report flaps", citations: [{ path: "src/tools/oracle.ts", line: 10 }] },
    expected_behavior: "the report is stable",
    scope: ["src/tools/oracle.ts"],
    locked_tests: [TEST_FILE],
    oracle: { id: "o1", kind: "unit-only", before: {}, expected_after: {} },
    risk: "low",
    ...over,
  };
}

const issueBody = (ask: string): string => ["## Goal", "", "Do the thing.", "", ...verbatimAskSection(ask)].join("\n");
const row = (status: string, type: string, size: number, path: string): string => `${status}\t${type}\t${size}\t${path}`;
const goodManifest = [row("??", "file", 40, SPEC_OUT_FILE), row("??", "file", 900, TEST_FILE)].join("\n");

describe("extractAsk: the founder's words, byte for byte", () => {
  it("reads back exactly what verbatimAskSection wrote", () => {
    const ask = "make   the oracle\n\n  stable, please";
    expect(extractAsk(issueBody(ask))).toEqual({ ok: true, ask });
  });

  it("survives backticks and a fake heading inside the ask", () => {
    const ask = "see ```\n## " + VERBATIM_HEADING + "\n```\nnot this";
    expect(extractAsk(issueBody(ask))).toEqual({ ok: true, ask });
  });

  it("refuses a body with no verbatim section", () => {
    const r = extractAsk("## Goal\n\nnothing here\n");
    expect(r.ok).toBe(false);
  });

  it("refuses a section that is not the last thing in the body", () => {
    const r = extractAsk(issueBody("do it") + "\n\n## Later\n\nsomething edited in\n");
    expect(r.ok).toBe(false);
  });

  it("refuses a blank ask", () => {
    expect(extractAsk(issueBody("   ")).ok).toBe(false);
  });
});

describe("assembleContract: code owns ask, repo, base_sha, citation sha and the limits", () => {
  const ctx = { ask: "the real ask", repo: REPO, base_sha: SHA_A };

  it("fills in version, ask, repo, base_sha, citation sha and default limits", () => {
    const r = assembleContract(modelDraft(), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.version).toBe(1);
    expect(r.contract.ask).toBe("the real ask");
    expect(r.contract.repo).toBe(REPO);
    expect(r.contract.base_sha).toBe(SHA_A);
    expect(r.contract.current_behavior.citations[0]?.sha).toBe(SHA_A);
    expect(r.contract.limits).toEqual(DEFAULT_LIMITS);
  });

  it("ignores an ask, repo, base_sha or citation sha the model supplied", () => {
    const draft = modelDraft({
      ask: "a different ask",
      repo: "evil/repo",
      base_sha: "f".repeat(40),
      current_behavior: { text: "x", citations: [{ path: "src/a.ts", line: 1, sha: "f".repeat(40) }] },
    });
    const r = assembleContract(draft, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.ask).toBe("the real ask");
    expect(r.contract.repo).toBe(REPO);
    expect(r.contract.base_sha).toBe(SHA_A);
    expect(r.contract.current_behavior.citations[0]?.sha).toBe(SHA_A);
  });

  it("lets the model lower a limit, never raise one", () => {
    const lower = assembleContract(modelDraft({ limits: { files: 2, lines: 50 } }), ctx);
    expect(lower.ok && lower.contract.limits).toEqual({ ...DEFAULT_LIMITS, files: 2, lines: 50 });
    const higher = assembleContract(modelDraft({ limits: { files: 9999, lines: 9999999, deleted_lines: 9999 } }), ctx);
    expect(higher.ok && higher.contract.limits).toEqual(DEFAULT_LIMITS);
  });

  it("never allows a new dependency, whatever the model says", () => {
    const r = assembleContract(modelDraft({ limits: { new_dependencies: true } }), ctx);
    expect(r.ok && r.contract.limits.new_dependencies).toBe(false);
  });

  it("reports every schema problem with its field path", () => {
    const r = assembleContract(modelDraft({ locked_tests: [], expected_behavior: "  " }), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toContain("locked_tests");
    expect(r.errors.join("\n")).toContain("expected_behavior");
  });

  it("refuses output that is not an object", () => {
    for (const bad of [null, 7, "text", []]) expect(assembleContract(bad, ctx).ok).toBe(false);
  });
});

describe("parseManifest and checkChanges: the run may write the locked tests and one JSON file, nothing else", () => {
  const contract = (() => {
    const r = assembleContract(modelDraft(), { ask: "a", repo: REPO, base_sha: SHA_A });
    if (!r.ok) throw new Error(r.errors.join(";"));
    return r.contract;
  })();
  const check = (manifest: string) => {
    const p = parseManifest(manifest);
    return p.ok ? checkChanges(p.entries, contract) : { ok: false as const, reasons: [p.error] };
  };

  it("accepts exactly the contract file and the declared test", () => {
    expect(check(goodManifest)).toEqual({ ok: true, testFiles: [TEST_FILE] });
  });

  it("refuses an edit outside the locked tests", () => {
    const r = check(goodManifest + "\n" + row(" M", "file", 10, "src/tools/oracle.ts"));
    expect(r.ok).toBe(false);
  });

  it("refuses a deleted file", () => {
    expect(check(goodManifest + "\n" + row(" D", "missing", 0, "README.md")).ok).toBe(false);
  });

  it("refuses a symlink, even at a locked path", () => {
    const m = [row("??", "file", 40, SPEC_OUT_FILE), row("??", "symlink", 3, TEST_FILE)].join("\n");
    expect(check(m).ok).toBe(false);
  });

  it("refuses an oversized test file", () => {
    const m = [row("??", "file", 40, SPEC_OUT_FILE), row("??", "file", 300_000, TEST_FILE)].join("\n");
    expect(check(m).ok).toBe(false);
  });

  it("refuses any other file under the spec-out directory", () => {
    expect(check(goodManifest + "\n" + row("??", "file", 5, ".spec-out/extra.sh")).ok).toBe(false);
  });

  it("refuses a run that did not write a declared test", () => {
    const r = check(row("??", "file", 40, SPEC_OUT_FILE));
    expect(r.ok).toBe(false);
    expect((r.ok ? [] : r.reasons).join(" ")).toContain(TEST_FILE);
  });

  it("refuses a malformed manifest line", () => {
    expect(parseManifest("??\tfile\tnot-a-number\tsome/path").ok).toBe(false);
    expect(parseManifest("only-one-field").ok).toBe(false);
    expect(parseManifest("??\tfile\t1\t../escape").ok).toBe(true);
    expect(check(goodManifest + "\n" + row("??", "file", 1, "../escape")).ok).toBe(false);
  });
});

describe("runPassP: the whole decision, as one pure function", () => {
  const base = {
    issue_body: issueBody("make the report stable"),
    repo: REPO,
    base_sha: SHA_A,
    manifest: goodManifest,
    line_counts: { "src/tools/oracle.ts": 120 } as Record<string, number | null>,
  };
  const out = (draft: Record<string, unknown> = modelDraft()): string => JSON.stringify(draft);

  it("PASS: carries the verbatim ask, the risk, a fingerprint and the test files to commit", () => {
    const r = runPassP({ ...base, model_output: out() });
    expect(r.status).toBe("PASS");
    if (r.status !== "PASS") return;
    expect(r.contract.ask).toBe("make the report stable");
    expect(r.contract.limits).toEqual(DEFAULT_LIMITS);
    expect(r.test_files).toEqual([TEST_FILE]);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(["low", "medium", "high"]).toContain(r.effective_risk);
  });

  it("ASK: a citation past the end of the file becomes a question for the founder, not a card", () => {
    const r = runPassP({ ...base, model_output: out(), line_counts: { "src/tools/oracle.ts": 3 } });
    expect(r.status).toBe("ASK");
    if (r.status !== "ASK") return;
    expect(r.questions.join(" ")).toContain("src/tools/oracle.ts");
  });

  it("ASK: a cited file that does not exist at the base commit", () => {
    const r = runPassP({ ...base, model_output: out(), line_counts: { "src/tools/oracle.ts": null } });
    expect(r.status).toBe("ASK");
  });

  it("ASK: a missing line count is treated as a missing file, never as a pass", () => {
    const r = runPassP({ ...base, model_output: out(), line_counts: {} });
    expect(r.status).toBe("ASK");
  });

  it("REJECT: model output that is not JSON", () => {
    const r = runPassP({ ...base, model_output: "I wrote the spec, see above" });
    expect(r.status).toBe("REJECT");
  });

  it("REJECT: a run that edited a file outside the locked tests, even when the spec is fine", () => {
    const r = runPassP({ ...base, model_output: out(), manifest: goodManifest + "\n" + row(" M", "file", 5, "src/tools/oracle.ts") });
    expect(r.status).toBe("REJECT");
  });

  it("REJECT: no verbatim ask in the issue, so there is nothing to bind the contract to", () => {
    const r = runPassP({ ...base, model_output: out(), issue_body: "## Goal\n\nonly this" });
    expect(r.status).toBe("REJECT");
  });

  it("raises the effective risk when the scope reaches a risk path", () => {
    const draft = modelDraft({ scope: ["src/db/schema.ts"] });
    const r = runPassP({ ...base, model_output: out(draft) });
    expect(r.status).toBe("PASS");
    if (r.status === "PASS") expect(r.effective_risk).toBe("high");
  });
});
