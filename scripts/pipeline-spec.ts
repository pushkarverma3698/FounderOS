/**
 * Pass P's three decisions for deploy/lib/pass-p.sh. Bash does the git, the sudo and the Telegram; every judgement
 * (is this the founder's ask, did the run stay inside its sandbox, does the spec pass the gate, what does the card say)
 * is made here, by the pure functions in src/tools/pipeline-spec.ts and src/gateway/coding-cards.ts.
 *
 *   pipeline-spec.ts ask      < issue body (text)            -> {"ok":true,"ask":"..."} | {"ok":false,"error":"..."}
 *   pipeline-spec.ts verify   < {issue_body, repo, base_sha, model_output, manifest, line_counts}
 *                                                            -> PASS | ASK | REJECT (see PassPResult)
 *   pipeline-spec.ts record   < {repo, issue, contract, effective_risk, fingerprint, spec_commit}
 *                                                            -> {"status":"RECORDED","nonce","parts":[html..],"reply_markup"}
 *                                                             | {"status":"FAILED","error"}
 *   pipeline-spec.ts failfirst < {report (vitest JSON text), locked_tests: [paths]}
 *                                                            -> {"status":"FAILS"|"PASSES"|"BROKEN","reason"}
 *
 * Always exits 0 and prints one JSON line: the caller reads the status, never the exit code. With AGENT_PIPELINE_V2 not
 * "1" every subcommand prints {"status":"DISABLED"} and touches nothing.
 */
import * as fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { renderSpecCard } from "../src/gateway/coding-cards.js";
import { contractsDir, type StoreFs } from "../src/tools/contract-store.js";
import { newNonce, pipelineV2Enabled, writePending } from "../src/tools/pipeline-pending.js";
import { judgeFailFirst } from "../src/tools/fail-first.js";
import { extractAsk, runPassP, type PassPInput } from "../src/tools/pipeline-spec.js";
import { parseTaskContract } from "../src/tools/task-contract.js";

const realFs: StoreFs = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, d) => fsp.writeFile(p, d),
  rename: (a, b) => fsp.rename(a, b),
  mkdir: async (p, o) => {
    await fsp.mkdir(p, o);
  },
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
};

export interface Deps {
  fs: StoreFs;
  nonce: () => string;
  now: () => Date;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const line = (v: unknown): string => JSON.stringify(v) + "\n";
const failed = (error: string): string => line({ status: "FAILED", error });

async function record(input: unknown, env: Record<string, string | undefined>, deps: Deps): Promise<string> {
  if (!isObj(input)) return failed("record input must be a JSON object");
  const { repo, issue, contract, effective_risk, fingerprint, spec_commit } = input;
  if (typeof repo !== "string" || typeof issue !== "number" || typeof spec_commit !== "string") {
    return failed("record needs repo (string), issue (number) and spec_commit (string)");
  }
  if (effective_risk !== "low" && effective_risk !== "medium" && effective_risk !== "high") return failed("effective_risk must be low, medium or high");
  if (typeof fingerprint !== "string") return failed("fingerprint must be a string");
  const parsed = parseTaskContract(isObj(contract) ? { ...contract, spec_commit } : contract);
  if (!parsed.ok) return failed("contract: " + parsed.errors.join("; "));
  const nonce = deps.nonce();
  const written = await writePending(
    deps.fs,
    contractsDir(env),
    {
      kind: "spec",
      nonce,
      repo,
      issue,
      contract: parsed.contract,
      effective_risk,
      fingerprint,
      spec_commit,
      created_at: deps.now().toISOString(),
    },
  );
  if (!written.ok) return failed(written.error);
  let card;
  try {
    card = renderSpecCard(parsed.contract, { status: "PASS", questions: [], effectiveRisk: effective_risk, fingerprint }, { repo, issue, nonce });
  } catch (err) {
    return failed("card: " + (err instanceof Error ? err.message : String(err)));
  }
  return line({ status: "RECORDED", nonce, parts: card.html, reply_markup: { inline_keyboard: card.keyboard.inline_keyboard } });
}

export async function runPipelineSpec(
  sub: string | undefined,
  stdin: string,
  env: Record<string, string | undefined>,
  deps: Deps,
): Promise<string> {
  if (!pipelineV2Enabled(env)) return line({ status: "DISABLED" });
  if (sub === "ask") return line(extractAsk(stdin));
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch (err) {
    return failed("stdin is not JSON: " + (err instanceof Error ? err.message : String(err)));
  }
  if (sub === "verify") {
    if (!isObj(input)) return failed("verify input must be a JSON object");
    const { issue_body, repo, base_sha, model_output, manifest, line_counts } = input;
    if (typeof issue_body !== "string" || typeof repo !== "string" || typeof base_sha !== "string" || typeof model_output !== "string" || typeof manifest !== "string" || !isObj(line_counts)) {
      return failed("verify needs issue_body, repo, base_sha, model_output, manifest (strings) and line_counts (object)");
    }
    return line(runPassP({ issue_body, repo, base_sha, model_output, manifest, line_counts } as PassPInput));
  }
  if (sub === "record") return record(input, env, deps);
  if (sub === "failfirst") {
    if (!isObj(input) || typeof input["report"] !== "string" || !Array.isArray(input["locked_tests"]) || !input["locked_tests"].every((t) => typeof t === "string")) {
      return failed("failfirst needs report (string) and locked_tests (array of strings)");
    }
    return line(judgeFailFirst(input["report"], input["locked_tests"] as string[]));
  }
  return failed("unknown subcommand " + String(sub) + " (ask | verify | record | failfirst)");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readStdin()
    .then((stdin) => runPipelineSpec(process.argv[2], stdin, process.env, { fs: realFs, nonce: newNonce, now: () => new Date() }))
    .catch((err: unknown) => failed("unexpected: " + (err instanceof Error ? err.message : String(err))))
    .then((out) => {
      process.stdout.write(out);
      process.exit(0);
    });
}
