/**
 * scripts/blocked-review-card.ts: the card pr-brain sends when it blocks a PR. GitHub is a fake gh runner and the
 * pending store an in-memory fs; the script's decisions (is there a blocking verdict for THIS head, is the PR open and a
 * draft, which issue it answers) and its output (one JSON line, a "fix" record the Fix now button points at) are real.
 */
import { describe, expect, it } from "vitest";
import { runBlockedCard, type BlockedCardDeps } from "../../../scripts/blocked-review-card.js";
import { readPending } from "../../../src/tools/pipeline-pending.js";
import { memFs, type MemFs } from "../../helpers/mem-fs.js";

const REPO = "OplifyMessage/oplify-messaging-api";
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const ENV = { FOUNDEROS_CONTRACTS_DIR: "/c" };
const ARGS = ["--repo", REPO, "--pr", "116", "--head", HEAD];

const finding = (severity: string, claim: string, extra: Record<string, unknown> = {}) => ({ severity, claim, evidence: `evidence for ${claim}`, ...extra });
const verdictBody = (head: string, decision: string, findings: unknown[]): string =>
  `Review of the PR.\n\n\`\`\`json\n${JSON.stringify({ version: 1, head_sha: head, decision, findings })}\n\`\`\`\n`;

const BLOCKING = verdictBody(HEAD, "REQUEST_CHANGES", [
  finding("blocker", "The test expects 404 where the route returns 401", { file: "test/auth-flows.test.js", line: 244 }),
  finding("blocker", "A vitest file in a repo that runs node --test", { file: "test/new.test.ts" }),
  finding("minor", "naming"),
]);

interface World {
  pr?: Record<string, unknown>;
  comments?: string[];
  ghFail?: string;
}
function deps(fs: MemFs, w: World = {}): { d: BlockedCardDeps; calls: string[][] } {
  const calls: string[][] = [];
  const pr = {
    state: "open",
    draft: true,
    title: "feat: auth flows",
    html_url: `https://github.com/${REPO}/pull/116`,
    head: { sha: HEAD, ref: "task/issue-115-auth-flows" },
    base: { ref: "beta" },
    ...w.pr,
  };
  const d: BlockedCardDeps = {
    fs,
    nonce: () => "n0nceBlocked01",
    now: () => new Date("2026-10-09T12:00:00.000Z"),
    async gh(args) {
      calls.push(args);
      if (w.ghFail) return { code: 1, stdout: "", stderr: w.ghFail };
      const ep = args.find((a) => a.startsWith("repos/")) ?? "";
      if (ep.endsWith("/pulls/116")) return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
      if (ep.includes("/issues/116/comments")) {
        const page = (w.comments ?? [BLOCKING]).map((body) => ({ body }));
        return { code: 0, stdout: JSON.stringify(args.includes("--slurp") ? [page] : page), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "not found" };
    },
  };
  return { d, calls };
}
const run = async (fs: MemFs, w: World = {}, argv = ARGS, env: Record<string, string | undefined> = ENV) => {
  const { d, calls } = deps(fs, w);
  const out = await runBlockedCard(argv, env, d);
  return { out: JSON.parse(out) as Record<string, any>, raw: out, calls };
};

describe("scripts/blocked-review-card", () => {
  it("a blocking verdict for the head: one CARD line listing every blocker, and a fix record the button points at", async () => {
    const fs = memFs();
    const { out, raw } = await run(fs);
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(out.status).toBe("CARD");
    expect(out.nonce).toBe("n0nceBlocked01");
    const text = (out.parts as string[]).join("\n");
    expect(text).toContain("The test expects 404 where the route returns 401");
    expect(text).toContain("test/auth-flows.test.js:244");
    expect(text).toContain("A vitest file in a repo that runs node --test");
    expect(text).toContain("2 blockers");
    expect(text).toContain("1 non-blocking note");
    const data = (out.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data ?? "").filter(Boolean);
    expect(data).toEqual(["cp:fix:n0nceBlocked01", "cp:close_pr:n0nceBlocked01"]);

    const rec = await readPending(fs, "/c", "n0nceBlocked01");
    expect(rec.ok).toBe(true);
    if (rec.ok) expect(rec.value).toEqual({
      kind: "fix",
      nonce: "n0nceBlocked01",
      repo: REPO,
      pr: 116,
      issue: 115,
      head: HEAD,
      branch: "task/issue-115-auth-flows",
      blockers: 2,
      created_at: "2026-10-09T12:00:00.000Z",
    });
  });

  it("works with the coding pipeline flag off (it is not part of that flow)", async () => {
    const { out } = await run(memFs(), {}, ARGS, { FOUNDEROS_CONTRACTS_DIR: "/c", AGENT_PIPELINE_V2: "0" });
    expect(out.status).toBe("CARD");
  });

  it("a branch that is not task/issue-N still gets a card, with no Fix now button and no issue on the record", async () => {
    const fs = memFs();
    const { out } = await run(fs, { pr: { head: { sha: HEAD, ref: "feature/x" } } });
    expect(out.status).toBe("CARD");
    const data = (out.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data ?? "").filter(Boolean);
    expect(data).toEqual(["cp:close_pr:n0nceBlocked01"]);
    const rec = await readPending(fs, "/c", "n0nceBlocked01");
    expect(rec.ok && rec.value.kind === "fix" ? rec.value.issue : "x").toBeUndefined();
  });

  it("a verdict for an older head is not this head's verdict: NONE", async () => {
    const fs = memFs();
    const { out } = await run(fs, { comments: [verdictBody(OLD, "REQUEST_CHANGES", [finding("blocker", "old")])] });
    expect(out.status).toBe("NONE");
    expect(out.reason).toMatch(/no verdict/i);
    expect(fs.files.size).toBe(0);
  });

  it("an approving verdict, or one with no blocker, gets no card", async () => {
    for (const body of [verdictBody(HEAD, "APPROVE", []), verdictBody(HEAD, "REQUEST_CHANGES", [finding("major", "only major")])]) {
      const fs = memFs();
      const { out } = await run(fs, { comments: [body] });
      expect(out.status).toBe("NONE");
      expect(fs.files.size).toBe(0);
    }
  });

  it("a closed PR, a ready (non-draft) PR, or a PR whose head moved gets no card", async () => {
    for (const pr of [{ state: "closed" }, { draft: false }, { head: { sha: OLD, ref: "task/issue-115-x" } }]) {
      const fs = memFs();
      const { out } = await run(fs, { pr });
      expect(out.status).toBe("NONE");
      expect(fs.files.size).toBe(0);
    }
  });

  it("the newest verdict for the head wins when pr-brain reviewed it twice", async () => {
    const cleared = verdictBody(HEAD, "APPROVE", []);
    const { out } = await run(memFs(), { comments: [BLOCKING, cleared] });
    expect(out.status).toBe("NONE");
  });

  it("a GitHub failure is FAILED with the reason, never a card; exit stays a JSON line", async () => {
    const { out } = await run(memFs(), { ghFail: "HTTP 502" });
    expect(out.status).toBe("FAILED");
    expect(out.error).toContain("HTTP 502");
  });

  it("a fs that cannot write the record is FAILED, never a card whose buttons point at nothing", async () => {
    const fs = memFs();
    const broken: MemFs = { ...fs, writeFile: async () => { throw new Error("disk full"); } };
    const { d } = deps(broken);
    const out = JSON.parse(await runBlockedCard(ARGS, ENV, d)) as Record<string, any>;
    expect(out.status).toBe("FAILED");
    expect(out.error).toMatch(/disk full|not written/);
  });

  it("bad arguments are FAILED with usage", async () => {
    for (const argv of [[], ["--repo", "nope", "--pr", "1", "--head", HEAD], ["--repo", REPO, "--pr", "x", "--head", HEAD], ["--repo", REPO, "--pr", "1", "--head", "abc"]]) {
      const { out } = await run(memFs(), {}, argv);
      expect(out.status).toBe("FAILED");
      expect(out.error).toMatch(/usage/);
    }
  });

  it("only reads GitHub", async () => {
    const { calls } = await run(memFs());
    for (const c of calls) expect(c[0]).toBe("api");
  });
});
