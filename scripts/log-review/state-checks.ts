// scripts/log-review/state-checks.ts
import { getPgPool } from "../../src/db/client.js";
import type { StateFinding } from "./types.js";

/** count(*) helper — read-only. Returns null on error (caller emits a loud finding). */
async function count(sql: string): Promise<number | null> {
  try {
    const res = await getPgPool().query(sql);
    return Number(res.rows[0]?.["n"] ?? 0);
  } catch {
    return null;
  }
}

/**
 * Verify prod DATA state, not schema (rule #22). The canonical 2026-06-15
 * outage was an EMPTY-but-present RAG store → confident fabrication, and the
 * error path mislabeled a Postgres/empty-store problem as "Ollama down". Each
 * finding names the REAL failing component.
 */
export async function runStateChecks(tenant: string): Promise<StateFinding[]> {
  void tenant; // part of the stable harvester interface; checks are currently tenant-global
  const findings: StateFinding[] = [];

  // 1. Keyword knowledge store (search_knowledge) — separate from vector RAG.
  const knowledgeRows = await count(`SELECT count(*)::int AS n FROM knowledge_entries`);
  if (knowledgeRows === null) {
    findings.push({
      type: "empty_store",
      severity: "high",
      summary:
        "knowledge_entries count query FAILED — Postgres unreachable or table missing.",
      evidence: ["count(*) FROM knowledge_entries threw"],
    });
  } else if (knowledgeRows === 0) {
    findings.push({
      type: "empty_store",
      severity: "high",
      summary:
        "knowledge_entries has 0 rows — search_knowledge returns empty → fabrication risk. Run `pnpm brain:sync`.",
      evidence: ["SELECT count(*) FROM knowledge_entries → 0"],
    });
  }

  // 2. Vector RAG store populated? Empty-but-present is a silent fabrication source.
  const ragRows = await count(`SELECT count(*)::int AS n FROM turicks_brain`);
  if (ragRows === null) {
    findings.push({
      type: "empty_store",
      severity: "high",
      summary:
        "turicks_brain count query FAILED — Postgres/pgvector unreachable or table missing (NOT an Ollama problem).",
      evidence: ["count(*) FROM turicks_brain threw"],
    });
  } else if (ragRows === 0) {
    findings.push({
      type: "empty_store",
      severity: "high",
      summary:
        "turicks_brain (RAG) has 0 rows — Postgres/pgvector empty, run `pnpm brain:sync`.",
      evidence: ["SELECT count(*) FROM turicks_brain → 0"],
    });
  } else {
    // 3. Rows present but embeddings NULL → vector search silently returns
    //    nothing → the same fabrication class. Verify DATA, not just presence.
    const missingEmbeddings = await count(
      `SELECT count(*)::int AS n FROM turicks_brain WHERE embedding IS NULL`,
    );
    if (missingEmbeddings === null) {
      findings.push({
        type: "empty_store",
        severity: "high",
        summary:
          "turicks_brain embedding-coverage query FAILED — Postgres/pgvector error (NOT an Ollama problem).",
        evidence: ["count(*) FROM turicks_brain WHERE embedding IS NULL threw"],
      });
    } else if (missingEmbeddings > 0) {
      findings.push({
        type: "empty_store",
        severity: "high",
        summary: `turicks_brain has ${missingEmbeddings}/${ragRows} rows with NULL embedding — vector search degraded, re-run \`pnpm brain:sync\`.`,
        evidence: [`embedding IS NULL count = ${missingEmbeddings}`],
      });
    }
  }

  // 4. Orphaned HITL approvals stuck pending far past the sweep window.
  const stuckHitl = await count(`
    SELECT count(*)::int AS n FROM hitl_approvals
    WHERE status = 'pending' AND created_at < now() - interval '24 hours'`);
  if (stuckHitl === null) {
    findings.push({
      type: "send_without_audit",
      severity: "medium",
      summary: "hitl_approvals stuck-pending query FAILED — Postgres unreachable.",
      evidence: ["count(*) FROM hitl_approvals (pending > 24h) threw"],
    });
  } else if (stuckHitl > 0) {
    findings.push({
      type: "send_without_audit",
      severity: "medium",
      summary: `${stuckHitl} HITL approval(s) pending > 24h — sweeper or resume path may be wedged.`,
      evidence: [`stuck pending = ${stuckHitl}`],
    });
  }

  // 5. Personal career RAG (search_personal_rag / read_cv) — portfolio questions hallucinate when empty.
  const personalRagRows = await count(`SELECT count(*)::int AS n FROM personal_rag`);
  if (personalRagRows === null) {
    findings.push({
      type: "empty_store",
      severity: "medium",
      summary: "personal_rag count query FAILED — Postgres/pgvector error.",
      evidence: ["count(*) FROM personal_rag threw"],
    });
  } else if (personalRagRows === 0) {
    findings.push({
      type: "empty_store",
      severity: "medium",
      summary:
        "personal_rag has 0 rows — portfolio/CV questions may hallucinate. Re-ingest personal-rag.",
      evidence: ["SELECT count(*) FROM personal_rag → 0"],
    });
  }

  return findings;
}
