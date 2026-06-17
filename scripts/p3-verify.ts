/**
 * P3 verification — engineering handoff slice wired at pre-router + CTO hook.
 */
import { buildOfficeInput, preRouteDepartment } from "../src/gateway/pre-router.js";
import {
  ENGINEERING_HANDOFF_MARKER,
  ENGINEERING_HANDOFF_TOKEN_CEILING,
  engineeringHandoffTokenEstimate,
  extractEngineeringHandoff,
} from "../src/agents/handoff-engineering.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPT =
  "Create a GitHub issue on pushkarverma3698/FounderOS titled 'P3 verify' with body 'gate'.";

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

const dept = preRouteDepartment(PROMPT);
checks.push({
  name: "pre_router_engineering",
  ok: dept === "engineering",
  detail: String(dept),
});

const msgs = buildOfficeInput(PROMPT);
const directive = String(msgs[0]?.content ?? "");
checks.push({
  name: "routing_directive_has_handoff_envelope",
  ok: directive.includes(ENGINEERING_HANDOFF_MARKER),
  detail: directive.includes(ENGINEERING_HANDOFF_MARKER) ? "present" : "missing",
});

const handoff = extractEngineeringHandoff(PROMPT);
const tokens = engineeringHandoffTokenEstimate(handoff);
checks.push({
  name: "handoff_token_ceiling",
  ok: tokens <= ENGINEERING_HANDOFF_TOKEN_CEILING,
  detail: `${tokens} <= ${ENGINEERING_HANDOFF_TOKEN_CEILING}`,
});

const engSrc = readFileSync(join(process.cwd(), "src/agents/engineering-domain.ts"), "utf8");
checks.push({
  name: "cto_pre_model_hook_wired",
  ok: engSrc.includes("preModelHook: engineeringHandoffPreModelHook"),
  detail: engSrc.includes("preModelHook") ? "preModelHook set" : "missing",
});

let failed = 0;
for (const c of checks) {
  const mark = c.ok ? "PASS" : "FAIL";
  if (!c.ok) failed++;
  console.log(`${mark} ${c.name}: ${c.detail}`);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll P3 engineering handoff structural checks passed.");
