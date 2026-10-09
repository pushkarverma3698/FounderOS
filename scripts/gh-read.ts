/**
 * A gh runner for the card scripts pr-brain calls (pipeline-evidence-card.ts, blocked-review-card.ts): they read GitHub
 * and write nothing to it. readOnlyGh lets through GET `api repos/...` calls and one exact form of `pr checks` (the
 * required-check buckets, as deploy/lib/ci-state.sh reads them); everything else is refused with exit 126.
 */
import { execFile } from "node:child_process";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GhRunner = (args: string[]) => Promise<GhResult>;

const refuse = (why: string): GhResult => ({ code: 126, stdout: "", stderr: "refused: this script is read-only on GitHub: " + why });

/** `pr checks <n> --repo <owner/name> --required --json bucket,name`, and nothing looser. */
function isRequiredChecks(args: string[]): boolean {
  return (
    args.length === 8 &&
    args[0] === "pr" &&
    args[1] === "checks" &&
    /^[1-9]\d*$/.test(args[2] ?? "") &&
    args[3] === "--repo" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args[4] ?? "") &&
    args[5] === "--required" &&
    args[6] === "--json" &&
    args[7] === "bucket,name"
  );
}

export function readOnlyGh(inner: GhRunner): GhRunner {
  return async (args) => {
    if (args[0] === "pr") return isRequiredChecks(args) ? inner(args) : refuse("only `pr checks N --repo R --required --json bucket,name` is allowed");
    if (args[0] !== "api") return refuse("only `api` and `pr checks` are allowed, got `" + (args[0] ?? "") + "`");
    const positional: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i] as string;
      if (a === "--paginate" || a === "--slurp") continue;
      let method: string | undefined;
      if (a === "-X" || a === "--method") method = args[++i];
      else if (a.startsWith("--method=")) method = a.slice("--method=".length);
      else if (a.startsWith("-X")) method = a.slice(2);
      else if (a.startsWith("-")) return refuse("flag " + a + " is not allowed");
      else {
        positional.push(a);
        continue;
      }
      if ((method ?? "").toUpperCase() !== "GET") return refuse("method " + (method ?? "(none)") + " is not GET");
    }
    if (positional.length !== 1 || !(positional[0] as string).startsWith("repos/")) return refuse("api needs exactly one repos/ endpoint");
    return inner(args);
  };
}

export const execGh: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile("gh", args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 127;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || err.message });
    });
  });
