/**
 * Apply the same execution-guard detectors the Telegram gateway uses.
 * Office invoker scripts (stress, probe) bypass office-run — this closes the gap.
 */
import {
  detectLinkedInRefusalWithoutTool,
  detectUnbackedGithubReadClaim,
  detectUnbackedGithubWriteClaim,
  detectUnbackedInboxClaim,
  detectUnbackedKnowledgeClaim,
  detectUnbackedMemoryClaim,
  detectUnbackedShellClaim,
  type OfficeMessageLike,
} from "../../src/gateway/execution-guard.js";

export type GuardKind = "shell" | "linkedin" | "inbox" | "github" | "memory" | "knowledge";

export function detectGuardViolation(
  userInput: string,
  messages: OfficeMessageLike[],
  reply: string,
): GuardKind | null {
  if (detectUnbackedShellClaim(userInput, messages, reply)) return "shell";
  if (detectLinkedInRefusalWithoutTool(userInput, messages, reply)) return "linkedin";
  if (detectUnbackedInboxClaim(userInput, messages, reply)) return "inbox";
  if (detectUnbackedGithubWriteClaim(userInput, messages, reply)) return "github";
  if (detectUnbackedGithubReadClaim(userInput, messages, reply)) return "github";
  if (detectUnbackedMemoryClaim(userInput, messages, reply)) return "memory";
  if (detectUnbackedKnowledgeClaim(userInput, messages, reply)) return "knowledge";
  return null;
}
