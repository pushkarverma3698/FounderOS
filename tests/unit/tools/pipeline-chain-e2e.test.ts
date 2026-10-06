/**
 * The whole coding-pipeline thin slice, end to end, offline, at $0.
 *
 *   intake (agent:spec, ask verbatim) -> Pass P (verify, record, spec card) -> [Approve] tap -> executor prompt
 *   -> evidence card (contract bound to the PR) -> [Merge] tap -> post-deploy oracle report
 *
 * Every step is the real function the production wiring calls (the same scripts the bash libs shell out to, the same
 * Telegram callback handler), over ONE in-memory contracts directory. The only fakes are the edges: GitHub, Telegram,
 * the model's spec output, the evidence verdicts and the fetch to prod. Each slice's own tests prove the slice; this
 * file proves the seams: the fingerprint Pass P records is the one Approve checks, the contract Approve stores is the
 * one the executor prompt and the evidence card read, the merge sha the Merge tap writes is the one the oracle report
 * selects on, and a stale head or a spent card stops the chain instead of letting it through.
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { handleCodingCallback, type CodingDeps, type PrState } from "../../../src/gateway/coding-callbacks.js";
import { runPipelineSpec } from "../../../scripts/pipeline-spec.js";
import { runExecutorPrompt } from "../../../scripts/pipeline-executor-prompt.js";
import { runEvidenceCard, type EvidenceCardDeps } from "../../../scripts/pipeline-evidence-card.js";
import { runOracleReport, type OracleReportDeps, type ReportFs } from "../../../scripts/oracle-report.js";
import { readContractRecord } from "../../../src/tools/contract-store.js";
import { filedBody, filedLabels } from "../../../src/tools/dispatch-spec-intake.js";
import { LABEL_READY, LABEL_SPEC } from "../../../src/tools/pipeline-pending.js";
import { SPEC_OUT_FILE } from "../../../src/tools/pipeline-spec.js";
import type { FetchLike } from "../../../src/tools/oracle-http.js";
import { SHA_A, SHA_B } from "../../helpers/contract-fixture.js";
import { memFs, type MemFs } from "../../helpers/mem-fs.js";

const REPO = "pushkarverma3698/fos-journey-sandbox";
const ISSUE = 12;
const PR = 40;
const DIR = "/c";
const ENV = { AGENT_PIPELINE_V2: "1", FOUNDEROS_CONTRACTS_DIR: DIR, ORACLE_ALLOWED_HOSTS: "app.example.com" };
const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const MERGE_SHA = "e".repeat(40);
const DEPLOYED = "f".repeat(40);
const TEST_FILE = "tests/unit/tools/health.test.ts";
const ASK = "make /health report ok:true once the database is reachable\n\n  (and say so in the body)";
const CLEARED = "CLEARED — marked ready for merge (self-approval impossible; ready IS the pass) · looks right";
const NOW = new Date("2026-10-06T10:00:00.000Z");

const httpOracle = {
  id: "health",
  kind: "http",
  target: "https://app.example.com/health",
  before: { "body.ok": false },
  expected_after: { "body.ok": true },
};
const unitOracle = { id: "u1", kind: "unit-only", before: {}, expected_after: {} };

const modelDraft = (oracle: Record<string, unknown>) => ({
  task_type: "bugfix",
  current_behavior: { text: "/health always says ok:false", citations: [{ path: "src/health.ts", line: 3 }] },
  expected_behavior: "/health says ok:true when the database answers",
  scope: ["src/health.ts"],
  locked_tests: [TEST_FILE],
  oracle,
  risk: "low",
});
const manifest = [`??\tfile\t40\t${SPEC_OUT_FILE}`, `??\tfile\t900\t${TEST_FILE}`].join("\n");

type Json = Record<string, any>;
const parse = (s: string): Json => JSON.parse(s.trim().split("\n").at(-1)!) as Json;
const buttons = (markup: Json): string[] =>
  (markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat().flatMap((b) => (b.callback_data ? [b.callback_data] : []));

/** The button that merges: [Merge] on a checkable change, "I checked it — merge" when nothing will check it on prod. */
const mergeButton = (card: Json): string => buttons(card.reply_markup).find((d) => /^cp:merge(_ack)?:/.test(d)) ?? "no merge button";

interface World {
  fs: MemFs;
  labels: Array<{ add: readonly string[]; remove: readonly string[] }>;
  comments: string[];
  merges: Array<{ pr: number; sha: string }>;
  audits: Array<{ action: string; key: string }>;
  pr: PrState;
  sent: Array<{ text: string; loud: boolean }>;
  fetched: string[];
  prodBody: unknown;
}

function world(): World {
  return {
    fs: memFs(),
    labels: [],
    comments: [],
    merges: [],
    audits: [],
    pr: { state: "open", merged: false, headSha: HEAD, baseSha: BASE, baseRef: "beta" },
    sent: [],
    fetched: [],
    prodBody: { ok: true },
  };
}

function callbackDeps(w: World, env: Record<string, string | undefined> = ENV): CodingDeps {
  const done = new Set<string>();
  return {
    env,
    fs: w.fs,
    dir: DIR,
    now: () => NOW,
    async setLabels(_r, _i, change) {
      w.labels.push(change);
    },
    async comment(_r, _i, body) {
      w.comments.push(body);
    },
    async inspectPr() {
      return w.pr;
    },
    async merge(_r, pr, sha) {
      w.merges.push({ pr, sha });
      return MERGE_SHA;
    },
    async alreadyDone(key) {
      return done.has(key);
    },
    async audit(row) {
      w.audits.push({ action: row.action, key: row.key });
      done.add(row.key);
      return true;
    },
  };
}

async function tap(w: World, data: string, env?: Record<string, string | undefined>) {
  const reply = vi.fn(async () => ({}));
  const ctx = {
    callbackQuery: { data },
    answerCallbackQuery: vi.fn(async () => true),
    reply,
    editMessageReplyMarkup: vi.fn(async () => true),
  } as unknown as Context;
  const handled = await handleCodingCallback(ctx, callbackDeps(w, env));
  return { handled, said: reply.mock.calls.map((c) => String((c as unknown[])[0])).join("\n") };
}

const specDeps = (w: World, nonce: string) => ({ fs: w.fs, nonce: () => nonce, now: () => NOW });

/** Pass P as pass-p.sh runs it: verify the run's output, then record the pending spec and get the card. */
async function specCard(w: World, oracle: Record<string, unknown>, issueBody: string, nonce = "specnonce1") {
  const verified = parse(
    await runPipelineSpec(
      "verify",
      JSON.stringify({ issue_body: issueBody, repo: REPO, base_sha: SHA_A, model_output: JSON.stringify(modelDraft(oracle)), manifest, line_counts: { "src/health.ts": 60 } }),
      ENV,
      specDeps(w, nonce),
    ),
  );
  expect(verified.status, JSON.stringify(verified)).toBe("PASS");
  const recorded = parse(
    await runPipelineSpec(
      "record",
      JSON.stringify({ repo: REPO, issue: ISSUE, contract: verified.contract, effective_risk: verified.effective_risk, fingerprint: verified.fingerprint, spec_commit: SHA_B }),
      ENV,
      specDeps(w, nonce),
    ),
  );
  expect(recorded.status, JSON.stringify(recorded)).toBe("RECORDED");
  return { verified, recorded };
}

function evidenceDeps(w: World, nonce: string): EvidenceCardDeps {
  return {
    fs: w.fs,
    nonce: () => nonce,
    now: () => NOW,
    async gh(args) {
      const ep = args.find((a) => a.startsWith("repos/")) ?? "";
      if (ep.endsWith(`/pulls/${PR}`)) return { code: 0, stdout: JSON.stringify({ state: "open", merged: false, html_url: `https://github.com/${REPO}/pull/${PR}`, head: { sha: w.pr.headSha }, base: { ref: "beta" } }), stderr: "" };
      if (ep.endsWith("/git/ref/heads/beta")) return { code: 0, stdout: JSON.stringify({ object: { sha: w.pr.baseSha } }), stderr: "" };
      return { code: 1, stdout: "", stderr: "not found" };
    },
    async evidence(mode) {
      return { status: "PASS", reasons: [], head_sha: mode === "spec" ? SHA_B : HEAD };
    },
  };
}

const evidenceArgs = ["--repo", REPO, "--issue", String(ISSUE), "--pr", String(PR), "--head", HEAD, "--verdict", CLEARED];

function reportFs(mem: MemFs): ReportFs {
  return {
    readFile: (p) => mem.readFile(p),
    writeFile: (p, d) => mem.writeFile(p, d),
    mkdir: (p, o) => mem.mkdir(p, o),
    async readdir(dir) {
      const names = new Set<string>();
      for (const k of mem.files.keys()) if (k.startsWith(dir + "/")) names.add(k.slice(dir.length + 1).split("/")[0]!);
      if (names.size === 0) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...names];
    },
  };
}

function reportDeps(w: World): OracleReportDeps {
  const fetchImpl: FetchLike = async (url) => {
    w.fetched.push(url);
    return { status: 200, text: async () => JSON.stringify(w.prodBody) };
  };
  return {
    fs: reportFs(w.fs),
    contains: (sha) => sha === MERGE_SHA,
    fetchImpl,
    async send(text, loud) {
      w.sent.push({ text, loud });
      return true;
    },
    now: () => NOW.toISOString(),
  };
}

/** Run the chain up to and including the Merge tap. Returns what each step printed. */
async function runChain(w: World, oracle: Record<string, unknown>) {
  const issueBody = filedBody("## Goal\n\nFix the health check.", ASK, true);
  const spec = await specCard(w, oracle, issueBody);
  const approveData = buttons(spec.recorded.reply_markup).find((d) => d.startsWith("cp:approve:"))!;
  const approved = await tap(w, approveData);
  const lookup = parse(await runExecutorPrompt("lookup", [REPO, String(ISSUE)], "", ENV, w.fs));
  const built = parse(await runExecutorPrompt("build", [REPO, String(ISSUE), `task/issue-${ISSUE}`, "beta"], "", ENV, w.fs));
  const card = parse(await runEvidenceCard(evidenceArgs, ENV, evidenceDeps(w, "mergenonce1")));
  return { spec, approveData, approved, lookup, built, card };
}

describe("coding pipeline v2: the whole chain, offline", () => {
  it("intake -> spec -> approve -> executor -> evidence card -> merge -> oracle report, with every seam holding", async () => {
    const w = world();

    // 1. Intake: the issue is filed agent:spec and the founder's words are the last section, byte for byte.
    expect(filedLabels([LABEL_READY, "agent:antigravity"], true)).toEqual([LABEL_SPEC, "agent:antigravity"]);
    expect(filedLabels([LABEL_READY], false)).toEqual([LABEL_READY]);

    const { spec, approved, lookup, built, card } = await runChain(w, httpOracle);

    // 2. Pass P: gate passed, a spec card with Approve / Change / Cancel, and the ask is the founder's, not the model's.
    expect(spec.verified.contract.ask).toBe(ASK);
    expect(buttons(spec.recorded.reply_markup).map((d) => d.split(":")[1]).sort()).toEqual(["approve", "cancel", "change"]);

    // 3. Approve: the contract record is stored under the SAME fingerprint, labels move to ready, one audit row.
    expect(approved.handled).toBe(true);
    expect(approved.said).toContain("spec approved");
    const stored = await readContractRecord(w.fs, DIR, REPO, ISSUE);
    expect(stored.ok && stored.value.fingerprint).toBe(spec.verified.fingerprint);
    expect(stored.ok && stored.value.spec_commit).toBe(SHA_B);
    expect(w.labels).toEqual([{ add: [LABEL_READY], remove: ["agent:spec-review"] }]);
    expect(w.audits.map((a) => a.action)).toEqual(["pipeline_spec_approved"]);

    // 4. Executor: finds the approved contract and its spec commit, and is told the ask word for word.
    expect(lookup).toEqual({ status: "CONTRACT", spec_commit: SHA_B });
    expect(built.status).toBe("PROMPT");
    expect(built.prompt).toContain(ASK);
    expect(built.prompt).toContain(TEST_FILE);

    // 5. Evidence card: bound to the PR, mergeable, with a Merge button that points at a pending merge record.
    expect(card.status).toBe("CARD");
    expect(card.mergeable).toBe(true);
    const mergeData = mergeButton(card);
    expect(mergeData).toBe("cp:merge:mergenonce1");
    const bound = await readContractRecord(w.fs, DIR, REPO, ISSUE);
    expect(bound.ok && bound.value.pr).toBe(PR);

    // 6. Merge tap: GitHub is asked to merge exactly the reviewed head, and the merge sha lands in the contract record.
    const merged = await tap(w, mergeData);
    expect(merged.said).toContain(`Merged ${REPO}#${PR}`);
    expect(w.merges).toEqual([{ pr: PR, sha: HEAD }]);
    const after = await readContractRecord(w.fs, DIR, REPO, ISSUE);
    expect(after.ok && after.value.merged_sha).toBe(MERGE_SHA);
    expect(w.audits.map((a) => a.action)).toEqual(["pipeline_spec_approved", "pipeline_merge"]);

    // 7. Deploy: the report selects that merge sha, asks prod, and sends ONE quiet message saying it passed.
    const out = await runOracleReport(["--deployed", DEPLOYED], ENV, reportDeps(w));
    expect(parse(out)).toMatchObject({ status: "OK", checked: 1, pass: 1, fail: 0, sent: true });
    expect(w.fetched).toEqual(["https://app.example.com/health"]);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.loud).toBe(false);
    expect(w.sent[0]!.text).toContain("PASS");

    // The next deploy does not say it again.
    const again = await runOracleReport(["--deployed", DEPLOYED], ENV, reportDeps(w));
    expect(parse(again)).toMatchObject({ status: "OK", checked: 0, sent: false });
    expect(w.sent).toHaveLength(1);
  });

  it("a prod that still answers ok:false is reported loud, not passed", async () => {
    const w = world();
    const { card } = await runChain(w, httpOracle);
    await tap(w, mergeButton(card));
    w.prodBody = { ok: false };
    const out = parse(await runOracleReport(["--deployed", DEPLOYED], ENV, reportDeps(w)));
    expect(out).toMatchObject({ checked: 1, pass: 0, fail: 1, sent: true });
    expect(w.sent[0]!.loud).toBe(true);
    expect(w.sent[0]!.text).toContain("FAIL");
  });

  it("a unit-only oracle is reported UNKNOWN with the warning, never PASS", async () => {
    const w = world();
    const { card } = await runChain(w, unitOracle);
    expect(mergeButton(card)).toBe("cp:merge_ack:mergenonce1");
    expect(card.parts.join("\n")).toContain("unit-only");
    await tap(w, mergeButton(card));
    await runOracleReport(["--deployed", DEPLOYED], ENV, reportDeps(w));
    expect(w.fetched).toEqual([]);
    expect(w.sent[0]!.text).toContain("0 PASS, 0 FAIL, 1 UNKNOWN");
    expect(w.sent[0]!.text).not.toMatch(/^PASS /m);
    expect(w.sent[0]!.text).toContain("does not mean it works");
  });

  it("a head that moved after the review stops the Merge tap: nothing reaches GitHub, nothing is recorded", async () => {
    const w = world();
    const { card } = await runChain(w, httpOracle);
    w.pr = { ...w.pr, headSha: "9".repeat(40) };
    const r = await tap(w, mergeButton(card));
    expect(r.said).toContain("not merging");
    expect(w.merges).toEqual([]);
    const rec = await readContractRecord(w.fs, DIR, REPO, ISSUE);
    expect(rec.ok && rec.value.merged_sha).toBeUndefined();
    // and so there is nothing for the deploy report to check
    expect(parse(await runOracleReport(["--deployed", DEPLOYED], ENV, reportDeps(w)))).toMatchObject({ checked: 0, sent: false });
  });

  it("a spent card cannot be used twice: the second Approve changes nothing", async () => {
    const w = world();
    const { approveData } = await runChain(w, httpOracle);
    const labelsBefore = w.labels.length;
    const auditsBefore = w.audits.length;
    const again = await tap(w, approveData);
    expect(again.said).toMatch(/already used|expired/);
    expect(w.labels).toHaveLength(labelsBefore);
    expect(w.audits).toHaveLength(auditsBefore);
  });

  it("with the flag off nothing is read, written, sent or fetched at any step", async () => {
    const w = world();
    const off = { ...ENV, AGENT_PIPELINE_V2: "true" };
    const specOut = parse(await runPipelineSpec("verify", "{}", off, specDeps(w, "n")));
    const lookup = parse(await runExecutorPrompt("lookup", [REPO, String(ISSUE)], "", off, w.fs));
    const card = parse(await runEvidenceCard(evidenceArgs, off, evidenceDeps(w, "n")));
    const report = parse(await runOracleReport(["--deployed", DEPLOYED], off, reportDeps(w)));
    const t = await tap(w, "cp:approve:whatever", off);
    expect([specOut.status, lookup.status, card.status, report.status]).toEqual(["DISABLED", "DISABLED", "DISABLED", "DISABLED"]);
    expect(t.said).toContain("switched off");
    expect(w.fs.files.size).toBe(0);
    expect(w.sent).toEqual([]);
    expect(w.fetched).toEqual([]);
    expect(w.merges).toEqual([]);
  });
});
