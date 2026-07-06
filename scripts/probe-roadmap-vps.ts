/**
 * VPS roadmap verification probe.
 * =================================
 * Exercises the merged roadmap work against the REAL prod DB + (optionally) the
 * real Nano Banana image API. Designed to be SAFE on production:
 *   - agent_assets / checkpoints / cost: READ-ONLY (counts, no deletes).
 *   - checkpoint sweep: reports how many threads WOULD be purged at 30d — does
 *     NOT delete (so a verification run never destroys prod state).
 *   - creative image-gen: ONE real draft image (~$0.01) only if --image is passed
 *     AND GOOGLE_GENERATIVE_AI_API_KEY is set; writes one agent_assets row.
 *
 * Run on the VPS:
 *   node --env-file=.env --import tsx/esm scripts/probe-roadmap-vps.ts [--image]
 *
 * Exit 0 = all checked items passed; non-zero = a check failed (CI-friendly).
 */
import { getPgPool } from "../src/db/client.js";
import { getCostByDepartment } from "../src/db/queries.js";
import { summarizeDepartmentCost } from "../src/infra/cost-report.js";
import { TENANT } from "../src/core/config.js";

const withImage = process.argv.includes("--image");
let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

async function main() {
  const pool = getPgPool();

  // ── 1. S3 migration fix: agents.agent_assets must exist (P0/S3 bug) ──────────
  const tbl = await pool.query(
    `SELECT to_regclass('agents.agent_assets') IS NOT NULL AS exists`,
  );
  const assetsExist = tbl.rows[0]?.exists === true;
  ok("agent_assets table exists (S3 migration journal fix)", assetsExist);
  if (assetsExist) {
    const c = await pool.query(`SELECT count(*)::int AS n FROM agents.agent_assets`);
    console.log(`   agent_assets rows: ${c.rows[0].n}`);
  }

  // ── 2. Checkpoint TTL sweep — DRY (report, no delete) (P0 #3) ────────────────
  try {
    const total = await pool.query(`SELECT count(*)::int AS n FROM agents.checkpoints`);
    const stale = await pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT thread_id FROM agents.checkpoints
          GROUP BY thread_id
         HAVING MAX((checkpoint->>'ts')::timestamptz) < NOW() - ($1 || ' days')::interval
       ) s`,
      ["30"],
    );
    ok("checkpoint TTL sweep query runs against prod schema", true,
       `total checkpoints=${total.rows[0].n}, threads stale@30d=${stale.rows[0].n} (NOT deleted by this probe)`);
  } catch (e) {
    ok("checkpoint TTL sweep query runs against prod schema", false, (e as Error).message);
  }

  // ── 3. Per-department cost attribution (P2 #9) ───────────────────────────────
  try {
    const rows = await getCostByDepartment(TENANT, 7);
    const summary = summarizeDepartmentCost(rows);
    ok("getCostByDepartment runs against prod ai_call_costs", true,
       `${rows.length} dept(s), total $${summary.totalUsd.toFixed(4)}, cost/task $${summary.costPerTask.toFixed(5)}`);
    for (const d of summary.byDepartment) console.log(`   ${d.department}: $${d.usd.toFixed(4)} (${d.calls} calls)`);
  } catch (e) {
    ok("getCostByDepartment runs against prod ai_call_costs", false, (e as Error).message);
  }

  // ── 4. Creative image-gen — REAL draft call (P1), opt-in via --image ─────────
  if (withImage) {
    if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
      ok("creative draft image generated", false, "GOOGLE_GENERATIVE_AI_API_KEY not set on VPS");
    } else {
      try {
        const { generateImage } = await import("../src/tools/image-gen.js");
        const img = await generateImage("a simple test mascot, flat vector, on white", { final: false });
        const isImage = img.base64.length > 100 && img.tier === "draft";
        ok("creative draft image generated (Nano Banana draft tier)", isImage,
           `model=${img.model}, bytes≈${Math.round(img.base64.length * 0.75)}, $${img.usd}`);
      } catch (e) {
        ok("creative draft image generated (Nano Banana draft tier)", false, (e as Error).message);
      }
    }
  } else {
    console.log("⏭️  creative image-gen skipped (pass --image to make a real ~$0.01 draft call)");
  }

  console.log(`\n${failures === 0 ? "RESULT: ALL CHECKED ITEMS PASS ✅" : `RESULT: ${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("PROBE ERROR", e); process.exit(2); });
