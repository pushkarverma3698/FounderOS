/**
 * Receipt integrity — a tool failure phrased as prose must not be recorded as a
 * verified action.
 *
 * THE INCIDENT (2026-09-22 20:30, production). The founder asked "Ping claude and
 * check what all models are available". `claude_code` refused the call and the
 * wrapper returned the plain string
 *   "Claude Code failed: Access denied: cwd /home/pushkar/Projects/agent-workspace …"
 * That string starts with "Claude", carries no ❌ and no [[TOOL_FAILURE marker, so
 * isFailureResult() returned false, the ToolReceipt was written ok:true, and
 * founderReceiptsBlock() printed
 *   "✓ 1 action completed and verified"
 * directly under a reply that read "Mission incomplete … execution failed".
 *
 * The receipts block is the mechanism that makes action claims non-fabricable.
 * When it counts a refusal as a verified action, the mechanism is the fabricator.
 *
 * 58 wrappers in src/agents/agent-tools/ return failure this way — including
 * "Email send failed:", "Calendar event creation failed:", "Deploy failed:" and
 * "Command failed:". Fixing them one by one leaves the detector still wrong and
 * every future wrapper free to regress it, so the fix belongs in the detector:
 * it is the single choke point every tool result passes through
 * (worker.ts: `ok = !isFailureResult(resultStr)`).
 */

import { describe, expect, it } from "vitest";
import { isFailureResult, TOOL_FAILURE_MARKER } from "../../../src/kernel/worker.js";

describe("isFailureResult — prose failures from tool wrappers", () => {
  // Verbatim from the 2026-09-22 production trace.
  it("detects the exact claude_code refusal that was counted as a verified action", () => {
    expect(
      isFailureResult(
        "Claude Code failed: Access denied: cwd /home/pushkar/Projects/agent-workspace is outside ~/Projects.",
      ),
    ).toBe(true);
  });

  it.each([
    ["comms.ts:174", "Email send failed: 401 invalid_grant"],
    ["comms.ts:430", "Calendar event creation failed: token expired"],
    ["comms.ts:267", "LinkedIn post failed: rate limited"],
    ["comms.ts:655", "Email read failed: unknown error. (Check gws auth.)"],
    ["engineering.ts:331", "Command failed: exit 127"],
    ["engineering.ts:499", "Deploy failed: bucket missing"],
    ["engineering.ts:306", "project_workflow (read_file) failed: ENOENT"],
    ["creative.ts:62", "generate_image failed (upload): 500 from S3"],
    ["jobhunt.ts:115", "Tailoring failed: no CV on disk"],
    ["personal.ts:36", "ERROR: personal RAG unreachable"],
    ["claude-code.ts", "Access denied: cwd /tmp is outside ~/Projects."],
    ["gap-scan.ts:29", "AI visibility scan failed: unknown error"],
  ])("detects the unmarked failure returned by %s", (_site, result) => {
    expect(isFailureResult(result)).toBe(true);
  });

  it("still detects the three structural conventions", () => {
    expect(isFailureResult("❌ send_email threw: boom")).toBe(true);
    expect(isFailureResult(`something ${TOOL_FAILURE_MARKER} stage=tool]]`)).toBe(true);
    expect(isFailureResult('{"success":false,"error":"nope"}')).toBe(true);
  });

  /**
   * The guard that keeps this from becoming the opposite defect. A successful
   * result whose CONTENT happens to discuss failure is not a failed call —
   * read_logs returning error lines is the normal case, and marking it failed
   * would hide real evidence behind a false receipt.
   */
  it.each([
    ["a log read whose content is errors", '{"success":true,"data":{"summary":{"errors":12},"note":"12 line(s) read (12 error, 0 warn)."}}'],
    ["a CI summary", "Gate complete: 4482 passed, 0 failed."],
    ["a job funnel report", "Free ingest complete — boards 3224, failed 30, screened 1."],
    ["an email body quoting the word", "Drafted reply to Anna: 'sorry the delivery failed, resending today'."],
    ["a status line", "Deploy succeeded after an earlier attempt failed."],
    ["a plain success", "✅ Context updated: notes"],
    ["an empty result", ""],
  ])("does NOT mark %s as a failure", (_case, result) => {
    expect(isFailureResult(result)).toBe(false);
  });
});
