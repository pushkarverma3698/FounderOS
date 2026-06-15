// scripts/log-review/detectors.ts
import type { Anomaly, Turn } from "./types.js";

const LATENCY_MS = 30_000; // turn.out ms over this = slow
const COST_USD = 0.05; // per-turn cost over this = spike

const hasSeam = (t: Turn, seam: string): boolean => t.lines.some((l) => l.seam === seam);
const lineText = (t: Turn): string =>
  t.lines.map((l) => `${l.msg ?? ""} ${l.raw}`).join(" ").toLowerCase();

/** level>=50 anywhere in the turn. */
function detectError(t: Turn): Anomaly | null {
  if (!t.hadError && t.toolErrors === 0) return null;
  const evidence = t.lines.filter((l) => l.level >= 50).map((l) => l.raw).slice(0, 5);
  return {
    type: "error",
    severity: t.hadError ? "high" : "medium",
    turnId: t.turnId,
    summary: `Turn ${t.turnId} hit ${t.hadError ? "an error" : `${t.toolErrors} tool error(s)`}.`,
    evidence: evidence.length ? evidence : [`toolErrors=${t.toolErrors}`],
  };
}

/** recursion/budget abort or wedge recovery. */
function detectWedge(t: Turn): Anomaly | null {
  const text = lineText(t);
  const wedged =
    hasSeam(t, "wedge.recovered") ||
    text.includes("recursion limit") ||
    (text.includes("budget") && text.includes("abort"));
  if (!wedged) return null;
  return {
    type: "wedge",
    severity: "high",
    turnId: t.turnId,
    summary: `Turn ${t.turnId} hit a recursion/budget abort or wedge recovery.`,
    evidence: t.lines.filter((l) => /wedge|recursion|abort/i.test(l.raw)).map((l) => l.raw).slice(0, 5),
  };
}

/** latency or cost spike from turn.out. */
function detectLatencyCost(t: Turn): Anomaly | null {
  const slow = (t.durationMs ?? 0) > LATENCY_MS;
  const pricey = (t.usd ?? 0) > COST_USD;
  if (!slow && !pricey) return null;
  return {
    type: "latency_cost",
    severity: "medium",
    turnId: t.turnId,
    summary: `Turn ${t.turnId} ${slow ? `took ${t.durationMs}ms` : ""}${slow && pricey ? " and " : ""}${pricey ? `cost $${t.usd}` : ""}.`,
    evidence: [`ms=${t.durationMs ?? "?"} usd=${t.usd ?? "?"}`],
  };
}

/**
 * Borderline router (NOT an assertion). A confident-looking reply with no
 * supporting tool.result / rag hit in the turn is a fabrication CANDIDATE —
 * Claude judges it in Stage 3. Honest refusals are excluded.
 */
function detectHallucinationCandidate(t: Turn): Anomaly | null {
  const reply = (t.reply ?? "").trim();
  if (!reply) return null;
  const refusal = /\b(i don't have|i do not have|cannot|can't|no information|not able|don't know)\b/i.test(reply);
  if (refusal) return null; // honest refusal = good behaviour, never a candidate
  const grounded = hasSeam(t, "tool.result") || lineText(t).includes("rag") || lineText(t).includes("search_knowledge");
  if (grounded) return null;
  // confident, substantive, ungrounded → candidate only
  if (reply.length < 40) return null;
  return {
    type: "hallucination_candidate",
    severity: "low",
    turnId: t.turnId,
    summary: `Turn ${t.turnId}: confident reply with no tool/RAG support — Claude to judge.`,
    evidence: [reply.slice(0, 200)],
  };
}

const DETECTORS = [detectError, detectWedge, detectLatencyCost, detectHallucinationCandidate];

/** Run every detector over every turn. Pure. */
export function runDetectors(turns: Turn[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (const t of turns) {
    for (const d of DETECTORS) {
      const a = d(t);
      if (a) out.push(a);
    }
  }
  return out;
}
