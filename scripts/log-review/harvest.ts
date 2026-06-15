// scripts/log-review/harvest.ts
import { writeFileSync } from "node:fs";
import { parseLogLines } from "./sources.js";
import { buildTimeline } from "./timeline.js";
import { runDetectors } from "./detectors.js";
import { buildDigest } from "./digest.js";
import { runStateChecks } from "./state-checks.js";
import type { Digest, StateFinding } from "./types.js";

/** Pure: raw log text + state findings → Digest. */
export function assembleDigest(rawLog: string, state: StateFinding[], windowDays: number): Digest {
  const lines = parseLogLines(rawLog);
  const turns = buildTimeline(lines);
  const anomalies = runDetectors(turns);
  return buildDigest(turns, anomalies, state, { windowDays });
}

/** Human-readable summary for the Telegram notify + report header. */
export function renderSummary(d: Digest): string {
  const lines = [
    `Prod QA digest — ${d.generatedAt} (last ${d.windowDays}d)`,
    `turns=${d.counts.turns} healthy=${d.counts.healthyTurns} errors=${d.counts.errors} warns=${d.counts.warns}`,
    ``,
    `Hard anomalies (${d.hardAnomalies.length}):`,
    ...d.hardAnomalies.map((a) => `  • [${a.severity}] ${a.summary}`),
    ``,
    `State findings (${d.stateFindings.length}):`,
    ...d.stateFindings.map((s) => `  • [${s.severity}] ${s.summary}`),
    ``,
    `Borderline turns for Claude to judge: ${d.borderlineTurns.length}${d.truncated ? " (capped)" : ""}`,
  ];
  return lines.join("\n");
}

/** CLI entry: reads journalctl from stdin, writes digest.json + summary.txt. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const windowDays = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 7);
  const outPath = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "digest.json";
  const tenant = args.find((a) => a.startsWith("--tenant="))?.split("=")[1] ?? "turicks";

  const rawLog = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });

  let state: StateFinding[] = [];
  try {
    state = await runStateChecks(tenant);
  } catch (err) {
    // fail loud in the summary, never silently drop state checks
    state = [{
      type: "empty_store", severity: "high",
      summary: `state-checks FAILED to run: ${(err as Error).message}`,
      evidence: [String(err)],
    }];
  }

  const digest = assembleDigest(rawLog, state, windowDays);
  writeFileSync(outPath, JSON.stringify(digest, null, 2));
  writeFileSync(outPath.replace(/\.json$/, ".summary.txt"), renderSummary(digest));
  process.stdout.write(renderSummary(digest) + "\n");
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
