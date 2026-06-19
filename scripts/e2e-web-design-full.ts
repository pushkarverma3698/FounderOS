/**
 * Full E2E — preset scaffold → deploy (no claude_code; proves static pipeline).
 *
 * Run: node --env-file=.env --import tsx/esm scripts/e2e-web-design-full.ts
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { executeApplyCinematicPreset } from "../src/tools/cinematic-preset.js";
import { executeDeployStaticSite, buildPublicUrl } from "../src/tools/deploy-static-site.js";
import { closeDatabaseConnections } from "../src/db/client.js";

async function main(): Promise<void> {
  console.log("\n🔬 Full E2E — preset → deploy (no LLM)\n");

  const projectsBase = mkdtempSync(join("/tmp", "e2e-full-projects-"));
  const wwwBase = mkdtempSync(join("/tmp", "e2e-full-www-"));
  const prevProjects = process.env["PROJECT_WORKFLOW_ROOT"];
  const prevHome = process.env["STATIC_SITE_HOME_ROOT"];
  const prevBase = process.env["STATIC_SITE_PUBLIC_BASE_URL"];
  const prevForce = process.env["DEPLOY_STATIC_SITE_FORCE_HOME"];

  process.env["PROJECT_WORKFLOW_ROOT"] = projectsBase;
  process.env["DEPLOY_STATIC_SITE_FORCE_HOME"] = "1";
  process.env["STATIC_SITE_HOME_ROOT"] = wwwBase;
  process.env["STATIC_SITE_PUBLIC_BASE_URL"] = "http://e2e-full.test";

  const workspace = join(projectsBase, "cinematic-showcase-1");
  const slug = "showcase-1";

  try {
    const preset = executeApplyCinematicPreset({
      preset: "neon",
      targetDir: workspace,
      client: "AgentOps",
    });
    if (!preset.success) {
      console.error("❌ preset failed:", preset.error);
      process.exit(1);
    }
    console.log("✅ Preset applied:", workspace);

    // Simulate claude_code customization
    const htmlPath = join(workspace, "index.html");
    const html = readFileSync(htmlPath, "utf-8");
    writeFileSync(
      htmlPath,
      html.replace("Replace this subhead", "See every agent decision in production"),
    );

    const deploy = executeDeployStaticSite({ slug, sourcePath: htmlPath, client: "AgentOps", presetUsed: "neon" });
    if (!deploy.success) {
      console.error("❌ deploy failed:", deploy.error);
      process.exit(1);
    }

    const url = (deploy.data as { publicUrl: string }).publicUrl;
    const expected = buildPublicUrl(slug);
    if (url !== expected) {
      console.error("❌ URL mismatch", url, expected);
      process.exit(1);
    }

    const deployed = readFileSync(join(wwwBase, "proof.turicks.com", "showcase-1", "index.html"), "utf-8");
    if (!deployed.includes("AgentOps")) {
      console.error("❌ deployed HTML missing client name");
      process.exit(1);
    }

    console.log("✅ Deployed:", url);
    console.log("\n✅ FULL E2E PIPELINE PASSED (preset → customize → deploy)");
  } finally {
    rmSync(projectsBase, { recursive: true, force: true });
    rmSync(wwwBase, { recursive: true, force: true });
    if (prevProjects === undefined) delete process.env["PROJECT_WORKFLOW_ROOT"];
    else process.env["PROJECT_WORKFLOW_ROOT"] = prevProjects;
    if (prevHome === undefined) delete process.env["STATIC_SITE_HOME_ROOT"];
    else process.env["STATIC_SITE_HOME_ROOT"] = prevHome;
    if (prevBase === undefined) delete process.env["STATIC_SITE_PUBLIC_BASE_URL"];
    else process.env["STATIC_SITE_PUBLIC_BASE_URL"] = prevBase;
    if (prevForce === undefined) delete process.env["DEPLOY_STATIC_SITE_FORCE_HOME"];
    else process.env["DEPLOY_STATIC_SITE_FORCE_HOME"] = prevForce;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closeDatabaseConnections().catch(() => {}));
