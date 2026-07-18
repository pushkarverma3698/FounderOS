/**
 * vps-run-smoke.js — proves the vps_run sandbox can execute code AND reach the
 * public internet, then leaves an artifact behind so S3 harvest is exercised too.
 *
 * Runs INSIDE the ephemeral Docker container on the VPS (node:22-bookworm-slim).
 * Node 22 ships a global `fetch`, so no deps and no npm install are needed.
 *
 * IMPORTANT: this must run with network: "bridge". The vps_run default is
 * "none" (no network) — with the default the fetch will fail with ENOTFOUND /
 * EAI_AGAIN, which only proves execution, not connectivity.
 *
 * Success = exit 0 + /work/result.json uploaded to S3 under agent-runs/{run_id}/.
 */

async function main() {
  const url = "https://api.github.com/zen"; // tiny, unauthenticated, stable public endpoint
  const startedAt = new Date().toISOString();

  const res = await fetch(url, { headers: { "User-Agent": "founderos-vps-smoke" } });
  if (!res.ok) {
    throw new Error(`public API returned HTTP ${res.status}`);
  }
  const body = (await res.text()).trim();

  const result = {
    ok: true,
    url,
    httpStatus: res.status,
    body,
    node: process.version,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  // Write to /work so vps_run harvests it to S3 (this is the round-trip proof).
  const { writeFile } = await import("node:fs/promises");
  await writeFile("/work/result.json", JSON.stringify(result, null, 2));

  console.log("SMOKE OK:", JSON.stringify(result));
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err?.message ?? err);
  process.exit(1);
});
