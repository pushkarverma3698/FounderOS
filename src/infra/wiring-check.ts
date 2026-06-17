/**
 * FounderOS — Wiring Check (compile/CI-time integrity guard)
 * ==========================================================
 * The single most common bug class in this project is NOT logic — it's
 * "half-wiring": a tool added to a department array but missing a barrel export,
 * an HITL classification, or a prompt mention (docs/rules/PROGRAMMING-RULES.md).
 * Those failures are SILENT at runtime ("I can't do that", dead tool) and only
 * surface in production.
 *
 * This module turns that class of failure into a deterministic, offline check
 * that runs in CI (`pnpm verify:wiring`) and as a unit test. A structural break
 * is a hard ERROR (non-zero exit / failing test); a prompt-mention gap is a
 * WARNING (several legitimately exist today and closing them is a behaviour
 * change that must be eval-gated, not silently patched here).
 *
 * Pure: env in (via the imported registry) → report out. No network, no fs.
 */

import {
  DEPARTMENT_TOOLS,
  SUPERVISOR_TOOLS,
  HITL_GATED_TOOLS,
  buildCapabilityManifest,
} from "../agents/capabilities.js";
import {
  RESEARCH_PROMPT,
  buildCommsPrompt,
  ENGINEERING_PROMPT,
  MARKETING_PROMPT,
  SALES_PROMPT,
  PERSONAL_PROMPT,
  JOBHUNT_PROMPT,
  ADMIN_PROMPT,
} from "../agents/system-prompts.js";

export interface WiringReport {
  errors: string[];
  warnings: string[];
}

/** The registry slice the pure checker operates on (injectable for tests). */
export interface WiringInput {
  departmentTools: Record<string, unknown[]>;
  supervisorTools: unknown[];
  hitlGatedTools: Iterable<string>;
  manifest: string;
  /** department → its system prompt text (for the mention warning). */
  departmentPrompts: Record<string, string>;
}

/** Tool names that only exist at the supervisor level (empty under ADR-028). */
const SUPERVISOR_ONLY_TOOLS = new Set<string>();

/** Department → its system prompt text (comms is date-injected, so call the builder). */
function departmentPrompts(): Record<string, string> {
  return {
    admin: ADMIN_PROMPT,
    research: RESEARCH_PROMPT,
    comms: buildCommsPrompt(),
    engineering: ENGINEERING_PROMPT,
    marketing: MARKETING_PROMPT,
    sales: SALES_PROMPT,
    personal: PERSONAL_PROMPT,
    jobhunt: JOBHUNT_PROMPT,
  };
}

/** A LangChain tool exposes a string `name` and a callable `invoke`. */
function isValidTool(t: unknown): t is { name: string; invoke: unknown } {
  if (typeof t !== "object" || t === null) return false;
  const name = (t as { name?: unknown }).name;
  const invoke = (t as { invoke?: unknown }).invoke;
  return typeof name === "string" && name.length > 0 && typeof invoke === "function";
}

function toolName(t: unknown): string {
  return typeof (t as { name?: unknown })?.name === "string" ? (t as { name: string }).name : "<unnamed>";
}

/**
 * Run the full wiring integrity check across the live tool registry.
 * Returns ALL violations (does not throw) so callers can render every problem
 * at once rather than failing on the first.
 */
export function checkWiring(): WiringReport {
  return evaluateWiring({
    departmentTools: DEPARTMENT_TOOLS,
    supervisorTools: SUPERVISOR_TOOLS,
    hitlGatedTools: HITL_GATED_TOOLS,
    manifest: buildCapabilityManifest(),
    departmentPrompts: departmentPrompts(),
  });
}

/**
 * Pure wiring evaluator — operates on injected registry data so the failure
 * path is unit-testable without mutating the live registry. `checkWiring()`
 * supplies the real values.
 */
export function evaluateWiring(input: WiringInput): WiringReport {
  const { departmentTools: DEPARTMENT_TOOLS, supervisorTools: SUPERVISOR_TOOLS } = input;
  const HITL_GATED_TOOLS = input.hitlGatedTools;
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── 1. Every department has at least one valid, named, invokable tool ───────
  for (const [dept, tools] of Object.entries(DEPARTMENT_TOOLS)) {
    if (!Array.isArray(tools) || tools.length === 0) {
      errors.push(`Department "${dept}" has no tools.`);
      continue;
    }
    for (const t of tools) {
      if (!isValidTool(t)) {
        errors.push(
          `Department "${dept}" contains an invalid tool (${toolName(t)}): missing string name or invoke(). ` +
            `A non-tool object was wired into a department array.`,
        );
      }
    }
  }

  // ── 2. Supervisor tools are valid too ───────────────────────────────────────
  for (const t of SUPERVISOR_TOOLS) {
    if (!isValidTool(t)) {
      errors.push(`SUPERVISOR_TOOLS contains an invalid tool (${toolName(t)}): missing string name or invoke().`);
    }
  }

  // ── 3. All known tool names (for cross-checks below) ────────────────────────
  const departmentToolNames = new Set<string>();
  for (const tools of Object.values(DEPARTMENT_TOOLS)) {
    for (const t of tools) if (isValidTool(t)) departmentToolNames.add(t.name);
  }
  const supervisorToolNames = new Set<string>();
  for (const t of SUPERVISOR_TOOLS) if (isValidTool(t)) supervisorToolNames.add(t.name);
  const allToolNames = new Set<string>([...departmentToolNames, ...supervisorToolNames]);

  // ── 4. Every HITL-gated tool actually exists somewhere ──────────────────────
  //     A gate guarding a tool that no agent carries is dead config — and worse,
  //     a write tool NOT in the gate set is an un-approved side effect waiting to
  //     happen. Cross-check both directions.
  for (const gated of HITL_GATED_TOOLS) {
    if (SUPERVISOR_ONLY_TOOLS.has(gated)) {
      if (!allToolNames.has(gated)) {
        errors.push(`HITL_GATED_TOOLS lists "${gated}" but it is not a supervisor or department tool.`);
      }
      continue;
    }
    if (!departmentToolNames.has(gated)) {
      errors.push(`HITL_GATED_TOOLS lists "${gated}" but no department carries it (dead gate).`);
    }
  }

  // ── 5. The auto-generated capability manifest must name every tool ──────────
  //     The manifest is what the supervisor reads to know what it can do. If a
  //     wired tool is absent from it, the model is told it doesn't exist.
  const manifest = input.manifest;
  for (const name of allToolNames) {
    if (!manifest.includes(name)) {
      errors.push(`Tool "${name}" is wired but missing from the capability manifest (supervisor self-knowledge).`);
    }
  }

  // ── 6. WARNING: department tool not mentioned in its own prompt ─────────────
  //     "Layer 6 silent bug": the agent has a tool it was never told about, so it
  //     never calls it. These are warnings (some exist today; closing them shifts
  //     model behaviour and must be eval-gated — CLAUDE.md rule #16).
  const prompts = input.departmentPrompts;
  for (const [dept, tools] of Object.entries(DEPARTMENT_TOOLS)) {
    const prompt = prompts[dept] ?? "";
    for (const t of tools) {
      if (!isValidTool(t)) continue;
      if (!prompt.includes(t.name)) {
        warnings.push(`Department "${dept}" carries "${t.name}" but its prompt never mentions it (agent may never call it).`);
      }
    }
  }

  return { errors, warnings };
}

/** Throw a single aggregated error if any structural wiring break exists. */
export function assertWiringOrThrow(): WiringReport {
  const report = checkWiring();
  if (report.errors.length > 0) {
    throw new Error(`Wiring check failed (${report.errors.length} error(s)):\n- ${report.errors.join("\n- ")}`);
  }
  return report;
}
