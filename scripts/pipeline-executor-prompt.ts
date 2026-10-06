/**
 * The executor's two decisions for deploy/lib/executor-prompt.sh. Bash does the git and the CLI; what the run is told,
 * and whether an approved contract exists at all, is decided here by src/tools/executor-prompt.ts and the contract store.
 *
 *   pipeline-executor-prompt.ts lookup <repo> <issue>
 *       -> {"status":"CONTRACT","spec_commit":"<40 hex>"} | {"status":"NONE"} | {"status":"INVALID","error":"..."}
 *   pipeline-executor-prompt.ts build  <repo> <issue> <branch> <target>   (stdin: docs/antigravity/STANDARDS.md, may be empty)
 *       -> {"status":"PROMPT","prompt":"..."} | {"status":"INVALID","error":"..."}
 *
 * Always exits 0 and prints one JSON line: the caller reads the status, never the exit code. With AGENT_PIPELINE_V2 not
 * "1" every subcommand prints {"status":"DISABLED"} and reads nothing. NONE means the issue was never specced (the legacy
 * path runs); anything that stops a stored contract from being used is INVALID, which the dispatcher turns into a refusal.
 */
import * as fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { contractsDir, readContractRecord, type ContractRecord, type StoreFs } from "../src/tools/contract-store.js";
import { buildExecutorPrompt } from "../src/tools/executor-prompt.js";
import { pipelineV2Enabled } from "../src/tools/pipeline-pending.js";

const realFs: StoreFs = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, d) => fsp.writeFile(p, d),
  rename: (a, b) => fsp.rename(a, b),
  mkdir: async (p, o) => {
    await fsp.mkdir(p, o);
  },
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
};

const line = (v: unknown): string => JSON.stringify(v) + "\n";
const invalid = (error: string): string => line({ status: "INVALID", error });

type Found = { ok: true; record: ContractRecord; specCommit: string } | { ok: false; none: boolean; error: string };

async function find(fs: StoreFs, env: Record<string, string | undefined>, repo: string, issue: number): Promise<Found> {
  const r = await readContractRecord(fs, contractsDir(env), repo, issue);
  if (!r.ok) return { ok: false, none: r.code === "not_found", error: r.error };
  const specCommit = r.value.spec_commit ?? r.value.contract.spec_commit;
  if (!specCommit) return { ok: false, none: false, error: "the stored contract has no spec_commit: no locked test is committed" };
  return { ok: true, record: r.value, specCommit };
}

export async function runExecutorPrompt(
  sub: string | undefined,
  args: string[],
  stdin: string,
  env: Record<string, string | undefined>,
  fs: StoreFs = realFs,
): Promise<string> {
  if (!pipelineV2Enabled(env)) return line({ status: "DISABLED" });
  if (sub !== "lookup" && sub !== "build") return invalid("unknown subcommand " + String(sub) + " (lookup | build)");
  const [repo, issueRaw, branch, target] = args;
  const issue = Number(issueRaw);
  if (!repo || !Number.isInteger(issue) || issue <= 0) return invalid("needs <repo> <issue>");
  const found = await find(fs, env, repo, issue);
  if (!found.ok) return found.none && sub === "lookup" ? line({ status: "NONE" }) : invalid(found.error);
  if (sub === "lookup") return line({ status: "CONTRACT", spec_commit: found.specCommit });
  if (!branch || !target) return invalid("build needs <repo> <issue> <branch> <target>");
  const built = buildExecutorPrompt({
    contract: { ...found.record.contract, spec_commit: found.specCommit },
    issue,
    repo,
    branch,
    targetBranch: target,
    standards: stdin.trim() ? stdin : undefined,
  });
  return built.ok ? line({ status: "PROMPT", prompt: built.prompt }) : invalid(built.error);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sub = process.argv[2];
  (sub === "build" ? readStdin() : Promise.resolve(""))
    .then((stdin) => runExecutorPrompt(sub, process.argv.slice(3), stdin, process.env))
    .catch((err: unknown) => invalid("unexpected: " + (err instanceof Error ? err.message : String(err))))
    .then((out) => {
      process.stdout.write(out);
      process.exit(0);
    });
}
