/**
 * Post-deploy oracle report, one run per deploy (AGENT_PIPELINE_V2).
 *
 * Reads the approved contracts that were merged (merged_sha), keeps those whose merge commit is in the deployed tree
 * and not yet reported, checks each oracle against prod, sends ONE Telegram message, and marks what it reported so the
 * next deploy does not repeat it. A report, never a gate: it always exits 0, and it changes nothing but its own marks.
 *
 * Usage: AGENT_PIPELINE_V2=1 ORACLE_ALLOWED_HOSTS=h1,h2 TELEGRAM_BOT_TOKEN=.. TELEGRAM_CHAT_ID=.. \
 *          node --import tsx/esm scripts/oracle-report.ts --deployed <40-hex sha>
 * Prints the report, then one JSON line: {status: "DISABLED"|"OK"|"FAILED", checked, sent, error?}.
 */

import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractRecordSchema, contractsDir, type ContractRecord } from "../src/tools/contract-store.js";
import { judgeTask, nextMark, renderReport, reportKey, selectTasks, type ReportMark, type ReportRow } from "../src/tools/oracle-report.js";
import type { FetchLike } from "../src/tools/oracle-http.js";
import { pipelineV2Enabled } from "../src/tools/pipeline-pending.js";

export interface ReportFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
}

export interface OracleReportDeps {
  fs: ReportFs;
  contains(sha: string): boolean;
  fetchImpl: FetchLike;
  /** Resolves true only when Telegram accepted the message. */
  send(text: string, loud: boolean): Promise<boolean>;
  now(): string;
}

const CONTRACT_FILE = /^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+__\d+\.json$/;
const SHA = /^[0-9a-f]{40}$/;
const out = (o: Record<string, unknown>): string => JSON.stringify(o);

async function readRecords(fs: ReportFs, dir: string): Promise<ContractRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    // allow-failopen: no contracts directory yet means nothing has been approved; the report has nothing to say
    return [];
  }
  const records: ContractRecord[] = [];
  for (const name of names.filter((n) => CONTRACT_FILE.test(n)).sort()) {
    try {
      const parsed = ContractRecordSchema.safeParse(JSON.parse(await fs.readFile(posix.join(dir, name))));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // allow-failopen: one unreadable record must not hide the others; it is simply not reported
    }
  }
  return records;
}

async function readMarks(fs: ReportFs, dir: string, records: readonly ContractRecord[]): Promise<Map<string, ReportMark>> {
  const marks = new Map<string, ReportMark>();
  for (const r of records) {
    if (!r.merged_sha) continue;
    const key = reportKey(r.repo, r.issue, r.merged_sha);
    try {
      marks.set(key, JSON.parse(await fs.readFile(posix.join(dir, "oracle-reports", `${key}.json`))) as ReportMark);
    } catch {
      // allow-failopen: no mark yet is the normal case for a task that has not been reported
    }
  }
  return marks;
}

export async function runOracleReport(argv: readonly string[], env: Record<string, string | undefined>, deps: OracleReportDeps): Promise<string> {
  if (!pipelineV2Enabled(env)) return out({ status: "DISABLED" });
  const at = argv.indexOf("--deployed");
  const deployed = at >= 0 ? argv[at + 1] : undefined;
  if (argv.length !== 2 || deployed === undefined || !SHA.test(deployed)) return out({ status: "FAILED", error: "usage: --deployed <40-character lowercase sha>" });

  const dir = contractsDir(env);
  const records = await readRecords(deps.fs, dir);
  const marks = await readMarks(deps.fs, dir, records);
  const tasks = selectTasks(records, deps.contains, marks);
  if (tasks.length === 0) return out({ status: "OK", checked: 0, sent: false });

  const hosts = (env.ORACLE_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter((h) => h !== "");
  const rows: ReportRow[] = [];
  for (const t of tasks) rows.push(await judgeTask(t, deps.fetchImpl, 10_000, hosts));

  const text = renderReport(deployed, rows);
  const sent = await deps.send(text, rows.some((r) => r.status === "FAIL"));
  // Marks only after the founder has the message: a failed send is retried at the next deploy, not lost.
  if (sent) {
    await deps.fs.mkdir(posix.join(dir, "oracle-reports"), { recursive: true });
    for (const r of rows) {
      const key = reportKey(r.task.repo, r.task.issue, r.task.merged_sha);
      await deps.fs.writeFile(posix.join(dir, "oracle-reports", `${key}.json`), JSON.stringify(nextMark(r, marks.get(key), deployed, deps.now())));
    }
  }
  return `${text}\n${out({ status: "OK", checked: rows.length, pass: rows.filter((r) => r.status === "PASS").length, fail: rows.filter((r) => r.status === "FAIL").length, sent })}`;
}

function realSend(env: Record<string, string | undefined>): OracleReportDeps["send"] {
  return async (text, loud) => {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chat = env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true, disable_notification: !loud }),
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok;
    } catch {
      // allow-failopen: a failed send leaves the task unmarked, so the next deploy sends it again
      return false;
    }
  };
}

async function main(): Promise<void> {
  const deployedAt = process.argv.indexOf("--deployed");
  const deployed = deployedAt >= 0 ? process.argv[deployedAt + 1] ?? "" : "";
  const root = process.env.ORACLE_REPORT_REPO ?? process.cwd();
  const contains = (sha: string): boolean => {
    if (!SHA.test(sha) || !SHA.test(deployed)) return false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, deployed], { cwd: root, stdio: "ignore" });
      return true;
    } catch {
      // allow-failopen: not an ancestor, or git could not say: the task is simply not reported at this deploy
      return false;
    }
  };
  const line = await runOracleReport(process.argv.slice(2), process.env, {
    fs: { readdir: (p) => nodeFs.readdir(p), readFile: (p) => nodeFs.readFile(p, "utf8"), writeFile: (p, d) => nodeFs.writeFile(p, d), mkdir: async (p, o) => void (await nodeFs.mkdir(p, o)) },
    contains,
    fetchImpl: fetch as FetchLike,
    send: realSend(process.env),
    now: () => new Date().toISOString(),
  });
  console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      // allow-failopen: a report is not a gate; a crash is printed as FAILED and the deploy stays green
      console.log(out({ status: "FAILED", error: err instanceof Error ? err.message : String(err) }));
      process.exit(0);
    },
  );
}
