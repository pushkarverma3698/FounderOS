/**
 * FounderOS - coding pipeline v2: does the locked test fail before the fix? (AGENT_PIPELINE_V2=1)
 * ===============================================================================================
 * A locked test is the spec's proof that something is wrong today. One that already passes on the unchanged code proves
 * nothing: #956 (2026-10-06) specced a bug #834 had already fixed, the test passed, and the executor opened a PR with no
 * fix in it. deploy/lib/pass-p.sh runs the locked tests in the spec sandbox with vitest's JSON reporter and asks this
 * function (through scripts/pipeline-spec.ts failfirst) what the report means:
 *   FAILS   at least one locked assertion fails, and every locked file loaded (or is missing only a module the task will
 *           create) — the spec may go to the founder;
 *   PASSES  every locked file ran and nothing failed — what was asked for looks done already; no card, the founder is asked;
 *   BROKEN  a locked file was not run, did not load, or there is no usable report — the run was wrong, an attempt is counted.
 * Pure: the report arrives as text.
 */

export type FailFirstStatus = "FAILS" | "PASSES" | "BROKEN";
export interface FailFirstVerdict {
  status: FailFirstStatus;
  reason: string;
}

interface FileResult {
  name: string;
  message: string;
  assertions: string[];
}

/** A load error that only says an imported module does not exist yet: the file the task is meant to create. */
const MISSING_MODULE = /Failed to load url .*Does the file exist\?|Cannot find module|ERR_MODULE_NOT_FOUND/s;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseReport(text: string): FileResult[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || !Array.isArray(raw["testResults"])) return null;
  const out: FileResult[] = [];
  for (const t of raw["testResults"]) {
    if (!isObj(t) || typeof t["name"] !== "string") return null;
    const asserts = Array.isArray(t["assertionResults"]) ? t["assertionResults"] : [];
    out.push({
      name: t["name"].replace(/\\/g, "/"),
      message: typeof t["message"] === "string" ? t["message"] : "",
      assertions: asserts.map((a) => (isObj(a) && typeof a["status"] === "string" ? a["status"] : "unknown")),
    });
  }
  return out;
}

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 240);

export function judgeFailFirst(reportText: string, lockedTests: readonly string[]): FailFirstVerdict {
  if (lockedTests.length === 0) return { status: "BROKEN", reason: "no locked tests to run" };
  const files = parseReport(reportText);
  if (!files) return { status: "BROKEN", reason: "vitest left no usable JSON report (it crashed or timed out before reporting)" };

  let total = 0;
  let failed = 0;
  let missingModule = false;
  for (const path of lockedTests) {
    const f = files.find((r) => r.name === path || r.name.endsWith("/" + path));
    if (!f) return { status: "BROKEN", reason: `${path} was not run (is it under tests/unit/ and named *.test.ts?)` };
    if (f.assertions.length === 0 && f.message) {
      if (!MISSING_MODULE.test(f.message)) return { status: "BROKEN", reason: `${path} does not load: ${firstLine(f.message)}` };
      missingModule = true;
      continue;
    }
    total += f.assertions.length;
    failed += f.assertions.filter((s) => s === "failed").length;
  }
  if (failed > 0) return { status: "FAILS", reason: `${failed} of ${total} locked assertions fail on the unchanged code` };
  if (missingModule) return { status: "FAILS", reason: "a locked test imports a module that does not exist yet" };
  return {
    status: "PASSES",
    reason: total === 0 ? "the locked tests assert nothing (only skipped or empty tests)" : `all ${total} locked assertions already pass on the unchanged code`,
  };
}
