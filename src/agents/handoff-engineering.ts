/**
 * FounderOS — Engineering handoff slice (P3)
 * ==========================================
 * Deterministic extraction + boundary isolation for COS → CTO transfers.
 * Only declared keys cross into the engineering subgraph; routing bloat is
 * stripped before the CTO's first model call.
 */

import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { ENGINEERING_HANDOFF_SCHEMA_VERSION } from "./state.js";
import { estimateMessageTokens } from "../infra/context-manager.js";

export const ENGINEERING_HANDOFF_MARKER = `[ENGINEERING_HANDOFF:v${ENGINEERING_HANDOFF_SCHEMA_VERSION}:`;

/** Max chars for taskBrief — prevents unbounded user paste into subgraph. */
export const ENGINEERING_TASK_BRIEF_MAX_CHARS = 800;

export const EngineeringHandoffSchema = z.object({
  schemaVersion: z.literal(ENGINEERING_HANDOFF_SCHEMA_VERSION),
  taskBrief: z.string().min(1).max(ENGINEERING_TASK_BRIEF_MAX_CHARS),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
});

export type EngineeringHandoff = z.infer<typeof EngineeringHandoffSchema>;

export type HandoffValidation =
  | { ok: true; handoff: EngineeringHandoff }
  | { ok: false; error: string };

const GITHUB_REPO_RE =
  /(?:https?:\/\/github\.com\/|github\.com\/|(?:repo(?:sitory)?|on)\s+)([\w.-]+)\/([\w.-]+)/i;
const BRANCH_RE = /\bbranch[:\s]+['"`]?([\w./-]+)['"`]?/i;
const CWD_RE = /\b(?:cwd|working directory|in\s+(?:folder|directory))\s+['"`]?([^\s'"`]+)['"`]?/i;

/** Deterministic repo/branch/cwd parse from founder text — no LLM. */
export function extractEngineeringHandoff(text: string): EngineeringHandoff {
  const trimmed = text.trim();
  const taskBrief = trimmed.slice(0, ENGINEERING_TASK_BRIEF_MAX_CHARS);

  const repoMatch = GITHUB_REPO_RE.exec(trimmed);
  const branchMatch = BRANCH_RE.exec(trimmed);
  const cwdMatch = CWD_RE.exec(trimmed);

  const handoff: EngineeringHandoff = {
    schemaVersion: ENGINEERING_HANDOFF_SCHEMA_VERSION,
    taskBrief,
  };

  if (repoMatch) {
    handoff.owner = repoMatch[1];
    handoff.repo = repoMatch[2];
  }
  if (branchMatch) {
    handoff.branch = branchMatch[1];
  }
  if (cwdMatch) {
    handoff.cwd = cwdMatch[1];
  }

  return handoff;
}

/** Pure boundary gate — never throws (mirrors validateSignalPayload). */
export function validateEngineeringHandoff(payload: unknown): HandoffValidation {
  const result = EngineeringHandoffSchema.safeParse(payload);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Invalid engineering handoff — ${detail}` };
  }
  return { ok: true, handoff: result.data };
}

/** Compact envelope embedded in routing directives for the CTO middleware parser. */
export function formatEngineeringHandoffEnvelope(handoff: EngineeringHandoff): string {
  const validated = validateEngineeringHandoff(handoff);
  if (!validated.ok) throw new Error(validated.error);
  return `${ENGINEERING_HANDOFF_MARKER}${JSON.stringify(validated.handoff)}]`;
}

/** Parse the first handoff envelope from message text, if present. */
export function parseEngineeringHandoffEnvelope(text: string): EngineeringHandoff | null {
  const start = text.indexOf(ENGINEERING_HANDOFF_MARKER);
  if (start === -1) return null;
  const jsonStart = start + ENGINEERING_HANDOFF_MARKER.length;
  const end = text.indexOf("]", jsonStart);
  if (end === -1) return null;
  try {
    const raw = JSON.parse(text.slice(jsonStart, end)) as unknown;
    const validated = validateEngineeringHandoff(raw);
    return validated.ok ? validated.handoff : null;
  } catch {
    return null;
  }
}

/**
 * Find a validated handoff in the message list (system routing directive or human).
 */
export function findEngineeringHandoff(messages: BaseMessage[]): EngineeringHandoff | null {
  for (const message of messages) {
    const text = typeof message.content === "string" ? message.content : "";
    const handoff = parseEngineeringHandoffEnvelope(text);
    if (handoff) return handoff;
  }
  return null;
}

/**
 * Replace bloated cross-boundary history with the typed slice only.
 * CTO sees: system context line + human taskBrief (no routing directives / admin bloat).
 */
export function isolateEngineeringMessages(
  messages: BaseMessage[],
  handoff: EngineeringHandoff,
): BaseMessage[] {
  const sliceLine = [
    "ENGINEERING_HANDOFF (typed slice — use only these fields):",
    `taskBrief: ${handoff.taskBrief}`,
    handoff.owner && handoff.repo ? `target: ${handoff.owner}/${handoff.repo}` : null,
    handoff.branch ? `branch: ${handoff.branch}` : null,
    handoff.cwd ? `cwd: ${handoff.cwd}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [new SystemMessage(sliceLine), new HumanMessage(handoff.taskBrief)];
}

/** Token estimate for isolated slice — used by P3 live gate. */
export function engineeringHandoffTokenEstimate(handoff: EngineeringHandoff): number {
  return estimateMessageTokens(isolateEngineeringMessages([], handoff));
}

/**
 * Max tokens allowed for CTO input after isolation (slice + system overhead).
 * Measured from golden handoff fixtures; bloat above this fails the gate.
 */
export const ENGINEERING_HANDOFF_TOKEN_CEILING = 350;
