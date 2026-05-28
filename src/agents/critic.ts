/**
 * FounderOS — Critic NODE
 * ========================
 * Quality gate that runs after every generator agent.
 * IMPORTANT: This is a NODE, not a conditional edge — it has side effects
 * (appends CritiqueRecord to state, increments revision_count).
 *
 * Anti-sycophancy design:
 *   Generator uses Gemini family → Critic uses Anthropic (Claude) first
 *   Different model families = genuine adversarial critique.
 *
 * After critic runs, a conditional EDGE (afterCriticEdge, pure function) decides:
 *   APPROVED                          → hitl
 *   NEEDS_REVISION + under limit      → generator (retry)
 *   NEEDS_REVISION + max reached      → hitl (escalated)
 */

import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { callCascade, safeParseJson } from "../infra/llm.js";
import type { CritiqueRecord } from "./state.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "critic" });

// ── Governance rules loader ───────────────────────────────────────────────────

let _rulesCache: string | undefined;

async function loadRules(): Promise<string> {
  if (_rulesCache) return _rulesCache;

  const dir = dirname(fileURLToPath(import.meta.url));
  const rulesPath = join(dir, "../../governance/critique-rules.md");

  try {
    _rulesCache = await readFile(rulesPath, "utf-8");
    log.debug({ path: rulesPath }, "Critique rules loaded");
  } catch (err) {
    log.warn({ err }, "Could not load critique-rules.md — using minimal fallback");
    _rulesCache = `# Critique Rules
## Universal Rules
1. No hallucinated facts
2. No filler phrases
3. Action-oriented with clear next steps
4. Length appropriate for the tier
5. Direct and specific tone
`;
  }

  return _rulesCache;
}

/** Extract only the relevant sections from the full rules document. */
function extractDepartmentRules(rules: string, dept: "sales" | "engineering" | "marketing"): string {
  const lines = rules.split("\n");
  const sections: string[] = [];
  let inUniversal = false;
  let inDept = false;
  const deptHeader = `## ${dept.charAt(0).toUpperCase()}${dept.slice(1)}`;

  for (const line of lines) {
    if (line.startsWith("## Universal")) {
      inUniversal = true;
      inDept = false;
      sections.push(line);
      continue;
    }
    if (line.startsWith(deptHeader) || line.toLowerCase().includes(dept.toLowerCase() + " department")) {
      inDept = true;
      inUniversal = false;
      sections.push(line);
      continue;
    }
    if (line.startsWith("## APPROVED") || line.startsWith("## ")) {
      if (inDept || inUniversal) {
        // Stop collecting this section, but include APPROVED/NEEDS_REVISION section
        if (line.startsWith("## APPROVED")) {
          inDept = false;
          inUniversal = false;
          sections.push("\n" + line);
          continue;
        }
        inDept = false;
        inUniversal = false;
      }
    }
    if (inUniversal || inDept) {
      sections.push(line);
    }
  }

  return sections.join("\n");
}

/** Extract the draft content based on department. */
function extractDraft(
  state: {
    email_draft?: { subject: string; body: string } | null;
    code_draft?: string | null;
    content_draft?: string | null;
  },
  dept: "sales" | "engineering" | "marketing",
): string {
  if (dept === "sales" && state.email_draft) {
    return `Subject: ${state.email_draft.subject}\n\n${state.email_draft.body}`;
  }
  if (dept === "engineering" && state.code_draft) {
    return state.code_draft;
  }
  if (dept === "marketing" && state.content_draft) {
    return state.content_draft;
  }
  return "(no draft available)";
}

// ── Critic Node ───────────────────────────────────────────────────────────────

export async function criticNode<S extends {
  email_draft?: { subject: string; body: string } | null;
  code_draft?: string | null;
  content_draft?: string | null;
  critiques: CritiqueRecord[];
  revision_count: number;
  tenant_id?: string;
}>(
  state: S,
  department: "sales" | "engineering" | "marketing",
): Promise<Partial<S>> {
  const tenantId = (state as unknown as Record<string, unknown>)["tenant_id"] as string ?? "turicks";

  const rules = await loadRules();
  const relevantRules = extractDepartmentRules(rules, department);
  const draft = extractDraft(state, department);

  const systemPrompt = `You are a strict quality critic for a ${department} department.
Apply these rules exactly as written and return ONLY valid JSON.

RULES:
${relevantRules}

Your task: evaluate the draft against these rules.
Return ONLY this JSON (no markdown fences, no extra text):
{"result":"APPROVED"|"NEEDS_REVISION","notes":"specific feedback","rule_violations":["rule name if violated"]}`;

  const userPrompt = `Draft to review:\n\n${draft}`;

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ];

  let record: CritiqueRecord;

  try {
    const result = await callCascade(
      "critic",
      messages,
      {
        agent: "critic",
        tenant_id: tenantId,
      },
    );

    // Parse the critique response — safeParseJson handles markdown fences + jsonrepair
    const parsed = safeParseJson<{
      result: "APPROVED" | "NEEDS_REVISION";
      notes: string;
      rule_violations: string[];
    }>(result.text);
    if (!parsed) throw new Error("safeParseJson returned null — no JSON in critique response");

    record = {
      result: parsed.result === "APPROVED" ? "APPROVED" : "NEEDS_REVISION",
      notes: parsed.notes ?? "",
      critic_model: result.model,
      timestamp: new Date().toISOString(),
      rule_violations: Array.isArray(parsed.rule_violations) ? parsed.rule_violations : [],
    };

    log.info(
      { result: record.result, violations: record.rule_violations, model: record.critic_model },
      "Critic verdict",
    );
  } catch (err) {
    // JSON parse fully failed (safeParseJson + jsonrepair both gave up).
    // Don't block the workflow — treat as APPROVED-with-warning so the run
    // can reach HITL where a human can review. Logging ensures we see this.
    log.error({ err: (err as Error).message }, "Critic JSON parse failed even with jsonrepair — auto-APPROVED with warning");
    record = {
      result: "APPROVED",
      notes: `⚠️ Critic could not parse LLM output (jsonrepair failed). Human review required. Error: ${(err as Error).message.slice(0, 200)}`,
      critic_model: "unknown",
      timestamp: new Date().toISOString(),
      rule_violations: ["critic_parse_error"],
    };
  }

  return {
    critiques: [record],
    revision_count: state.revision_count + 1,
  } as Partial<S>;
}

// ── Conditional Edge (pure function) ──────────────────────────────────────────

/** Pure function — decides next node after critique. No LLM calls here. */
export function afterCriticEdge<S extends {
  critiques: CritiqueRecord[];
  revision_count: number;
  max_revisions: number;
}>(state: S): "generator" | "hitl" {
  const latest = state.critiques.at(-1);
  if (!latest) return "hitl"; // No critique = something went wrong, escalate

  if (latest.result === "APPROVED") return "hitl";
  if (state.revision_count >= state.max_revisions) return "hitl"; // Escalate
  return "generator"; // Retry
}
