/**
 * Live probe — vps_run (checklist §7).
 * Calls the tool directly (bypasses HITL) against the real VPS + S3.
 * Requires: VPS_RUN_HOST (+ VPS_RUN_SSH_KEY), STORAGE_BUCKET + AWS creds.
 * Cleans up after itself: the tool deletes the sandbox; the probe's S3 object
 * is tagged "— delete me" via its filename.
 *
 *   npx tsx --env-file=.env scripts/probe-vps-run.ts
 */

import { vpsRunTool, type VpsRunData } from "../src/tools/vps-run.js";

async function main() {
  if (!process.env["VPS_RUN_HOST"]) {
    console.error("probe-vps-run: VPS_RUN_HOST not set — nothing to probe.");
    process.exit(1);
  }

  const res = await vpsRunTool.execute({
    command: `echo "probe ok $(date -u +%FT%TZ)" > probe-delete-me.txt && cat probe-delete-me.txt`,
    brief: "vps_run live probe — safe to delete",
    timeout_minutes: 2,
  });

  console.log(JSON.stringify(res, null, 2));

  const data = res.data as VpsRunData | undefined;
  const realSuccess =
    res.success === true &&
    data?.exit_code === 0 &&
    (data?.artifacts.length ?? 0) >= 1 &&
    data!.artifacts.every((a) => a.s3_key.startsWith(`agent-runs/${data!.run_id}/`));

  if (!realSuccess) {
    console.error("probe-vps-run: FAILED — success flag, exit code, or artifact handoff missing.");
    process.exit(1);
  }
  console.log(`probe-vps-run: OK — run ${data!.run_id}, ${data!.artifacts.length} artifact(s) in S3.`);
}

main().catch((err) => {
  console.error("probe-vps-run: threw —", err);
  process.exit(1);
});
