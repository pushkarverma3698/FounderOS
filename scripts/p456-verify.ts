/**
 * P4/P5/P6 combined verification scripts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPgPool, closeDatabaseConnections } from "../src/db/client.js";

async function p4Checks() {
  const src = readFileSync(join(process.cwd(), "src/db/queries.ts"), "utf8");
  return [
    {
      name: "p4_publish_with_audit",
      ok: src.includes("publishDeptEventWithAudit"),
      detail: "helper present",
    },
    {
      name: "p4_signals_uses_transaction",
      ok: readFileSync(join(process.cwd(), "src/agents/agent-tools/signals.ts"), "utf8").includes(
        "publishDeptEventWithAudit",
      ),
      detail: "signals.ts wired",
    },
  ];
}

async function p5Checks() {
  const pool = getPgPool();
  const schemas = await pool.query(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('agents','brain') ORDER BY 1`,
  );
  const names = schemas.rows.map((r: { schema_name: string }) => r.schema_name);
  const tables = await pool.query(
    `SELECT table_schema, count(*)::int AS n
     FROM information_schema.tables
     WHERE table_schema IN ('agents','brain') AND table_type='BASE TABLE'
     GROUP BY table_schema ORDER BY 1`,
  );
  return [
    { name: "p5_schemas_exist", ok: names.includes("agents") && names.includes("brain"), detail: names.join(",") },
    {
      name: "p5_agents_has_tables",
      ok: tables.rows.some((r: { table_schema: string; n: number }) => r.table_schema === "agents" && r.n >= 5),
      detail: JSON.stringify(tables.rows),
    },
    {
      name: "p5_checkpointer_agents_schema",
      ok: readFileSync(join(process.cwd(), "src/infra/checkpointer.ts"), "utf8").includes('schema: "agents"'),
      detail: "checkpointer schema set",
    },
  ];
}

function p6Checks() {
  const trace = readFileSync(join(process.cwd(), "src/infra/trace.ts"), "utf8");
  const cb = readFileSync(join(process.cwd(), "src/infra/trace-callback.ts"), "utf8");
  return [
    { name: "p6_hierarchy_seams", ok: trace.includes("hierarchy.enter"), detail: "seams defined" },
    { name: "p6_depth_helper", ok: trace.includes("hierarchyDepth"), detail: "depth map" },
    { name: "p6_callback_wired", ok: cb.includes("hierarchy.enter"), detail: "callback emits" },
  ];
}

async function main() {
  const checks = [...(await p4Checks()), ...(await p5Checks()), ...p6Checks()];
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "PASS" : "FAIL";
    if (!c.ok) failed++;
    console.log(`${mark} ${c.name}: ${c.detail}`);
  }
  if (failed > 0) process.exit(1);
  console.log("\nAll P4/P5/P6 structural checks passed.");
  await closeDatabaseConnections();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
