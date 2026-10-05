/**
 * Post-deploy oracle report. Reads a JSON file of [{repo, issue, pr, oracle}], observes each task's
 * oracle against prod, and prints one line per task:  #<issue> PASS|FAIL|UNKNOWN — reason
 *
 * A report, not a gate: it always exits 0. It does not post to GitHub or Telegram, and it is not
 * wired into deploy. HTTP targets are fetched only if their host is in ORACLE_ALLOWED_HOSTS
 * (comma list). The telegram kind is UNKNOWN until the probe is wired.
 *
 * Usage: ORACLE_ALLOWED_HOSTS=app.example.com node --import tsx/esm scripts/post-deploy-oracle.ts <tasks.json>
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { OracleSchema, evaluatePostDeploy, type PostDeployVerdict } from "../src/tools/oracle.js";
import { observeHttp, type FetchLike } from "../src/tools/oracle-http.js";

const TaskSchema = z.object({
  repo: z.string().min(1),
  issue: z.number().int().positive(),
  pr: z.number().int().positive(),
  oracle: OracleSchema,
});

export interface OracleRunDeps {
  fetchImpl: FetchLike;
  allowedHosts: readonly string[];
  timeoutMs: number;
}

export function allowedHostsFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
}

/** One line only: remote content must not be able to forge extra report lines. */
function line(issue: number | "?", verdict: PostDeployVerdict): string {
  const reason = verdict.reason.replace(/\s+/g, " ").trim().slice(0, 400);
  return `#${issue} ${verdict.status} — ${reason}`;
}

function issueOf(entry: unknown): number | "?" {
  if (typeof entry === "object" && entry !== null && "issue" in entry) {
    const n = (entry as { issue: unknown }).issue;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) return n;
  }
  return "?";
}

export async function runPostDeployOracle(input: unknown, deps: OracleRunDeps): Promise<string[]> {
  if (!Array.isArray(input)) return [line("?", { status: "UNKNOWN", reason: "input is not a JSON array of tasks" })];
  const lines: string[] = [];
  for (const entry of input as unknown[]) {
    const parsed = TaskSchema.safeParse(entry);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first ? `${first.path.join(".") || "entry"}: ${first.message}` : "unknown";
      lines.push(line(issueOf(entry), { status: "UNKNOWN", reason: `invalid task entry (${where})` }));
      continue;
    }
    const { issue, oracle } = parsed.data;
    if (oracle.kind === "telegram") {
      lines.push(line(issue, { status: "UNKNOWN", reason: "telegram probe not wired" }));
      continue;
    }
    const observation =
      oracle.kind === "http" ? await observeHttp(oracle, deps.fetchImpl, deps.timeoutMs, deps.allowedHosts) : {};
    lines.push(line(issue, evaluatePostDeploy(oracle, observation)));
  }
  return lines;
}

async function main(path: string | undefined): Promise<number> {
  if (!path) {
    console.error("usage: post-deploy-oracle.ts <tasks.json>");
    return 0;
  }
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    // allow-failopen: this is a report, not a gate; an unreadable input file is reported on stderr and exits 0 by design
    console.error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  const lines = await runPostDeployOracle(input, {
    fetchImpl: fetch as FetchLike,
    allowedHosts: allowedHostsFromEnv(process.env.ORACLE_ALLOWED_HOSTS),
    timeoutMs: 10_000,
  });
  for (const l of lines) console.log(l);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).then((code) => process.exit(code));
}
