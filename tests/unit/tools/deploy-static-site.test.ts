/**
 * Unit tests for deploy_static_site tool — path guards, URL building, copy logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isValidDeploySlug,
  deployDirForSlug,
  publicPathForSlug,
  buildPublicUrl,
  isAllowedSourcePath,
  copyStaticArtifact,
  executeDeployStaticSite,
  publicBaseUrl,
} from "../../../src/tools/deploy-static-site.js";
import { projectRoot } from "../../../src/tools/project-workflow.js";

describe("deploy slug validation", () => {
  it("accepts valid slugs", () => {
    expect(isValidDeploySlug("langfuse")).toBe(true);
    expect(isValidDeploySlug("showcase-1")).toBe(true);
    expect(isValidDeploySlug("client_2026")).toBe(true);
  });

  it("rejects invalid slugs", () => {
    expect(isValidDeploySlug("")).toBe(false);
    expect(isValidDeploySlug("../etc")).toBe(false);
    expect(isValidDeploySlug("a b")).toBe(false);
    expect(isValidDeploySlug("-bad")).toBe(false);
  });
});

describe("deploy paths and URLs", () => {
  it("maps showcase-1 to legacy path", () => {
    expect(deployDirForSlug("/var/www", "showcase-1")).toBe("/var/www/proof.turicks.com/showcase-1");
    expect(publicPathForSlug("showcase-1")).toBe("/showcase-1/");
  });

  it("maps client slugs to /clients/{slug}/", () => {
    expect(deployDirForSlug("/var/www", "langfuse")).toBe("/var/www/clients/langfuse");
    expect(publicPathForSlug("langfuse")).toBe("/clients/langfuse/");
  });

  it("builds public URL from env", () => {
    const prev = process.env["STATIC_SITE_PUBLIC_BASE_URL"];
    process.env["STATIC_SITE_PUBLIC_BASE_URL"] = "http://95.217.162.12";
    expect(buildPublicUrl("langfuse")).toBe("http://95.217.162.12/clients/langfuse/");
    process.env["STATIC_SITE_PUBLIC_BASE_URL"] = prev;
  });

  it("defaults public base to localhost", () => {
    const prev = process.env["STATIC_SITE_PUBLIC_BASE_URL"];
    delete process.env["STATIC_SITE_PUBLIC_BASE_URL"];
    expect(publicBaseUrl()).toBe("http://127.0.0.1");
    process.env["STATIC_SITE_PUBLIC_BASE_URL"] = prev;
  });
});

describe("source path guard", () => {
  let projectsTmp: string;

  beforeEach(() => {
    projectsTmp = mkdtempSync(join(projectRoot(), "deploy-test-"));
  });

  afterEach(() => {
    rmSync(projectsTmp, { recursive: true, force: true });
  });

  it("allows paths under ~/Projects", () => {
    const html = join(projectsTmp, "index.html");
    writeFileSync(html, "<html><title>Test</title></html>");
    expect(isAllowedSourcePath(html)).toBe(true);
  });

  it("blocks paths outside ~/Projects", () => {
    const outside = join(tmpdir(), "outside-index.html");
    writeFileSync(outside, "x");
    try {
      expect(isAllowedSourcePath(outside)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("copyStaticArtifact", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), "deploy-src-"));
    destDir = mkdtempSync(join(tmpdir(), "deploy-dest-"));
    writeFileSync(join(srcDir, "index.html"), "<html><title>AgentOps</title></html>");
    mkdirSync(join(srcDir, "assets"));
    writeFileSync(join(srcDir, "assets", "style.css"), "body{color:red}");
  });

  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  it("copies a directory tree", () => {
    const bytes = copyStaticArtifact(srcDir, destDir);
    expect(bytes).toBeGreaterThan(0);
    expect(readFileSync(join(destDir, "index.html"), "utf-8")).toContain("AgentOps");
    expect(readFileSync(join(destDir, "assets", "style.css"), "utf-8")).toContain("red");
  });

  it("copies a single index.html file", () => {
    const single = join(srcDir, "solo.html");
    writeFileSync(single, "<html>solo</html>");
    const soloDest = mkdtempSync(join(tmpdir(), "deploy-solo-"));
    try {
      copyStaticArtifact(single, soloDest);
      expect(readFileSync(join(soloDest, "solo.html"), "utf-8")).toContain("solo");
    } finally {
      rmSync(soloDest, { recursive: true, force: true });
    }
  });
});

describe("executeDeployStaticSite", () => {
  let projectsTmp: string;
  let homeRoot: string;
  const prevHome = process.env["STATIC_SITE_HOME_ROOT"];
  const prevSudo = process.env["DEPLOY_STATIC_SITE_FORCE_HOME"];

  beforeEach(() => {
    projectsTmp = mkdtempSync(join(projectRoot(), "deploy-exec-"));
    homeRoot = mkdtempSync(join(tmpdir(), "www-home-"));
    process.env["STATIC_SITE_HOME_ROOT"] = homeRoot;
    process.env["STATIC_SITE_PUBLIC_BASE_URL"] = "http://test.local";
    process.env["DEPLOY_STATIC_SITE_FORCE_HOME"] = "1";
    writeFileSync(join(projectsTmp, "index.html"), "<html><title>E2E</title></html>");
  });

  afterEach(() => {
    rmSync(projectsTmp, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env["STATIC_SITE_HOME_ROOT"];
    else process.env["STATIC_SITE_HOME_ROOT"] = prevHome;
    if (prevSudo === undefined) delete process.env["DEPLOY_STATIC_SITE_FORCE_HOME"];
    else process.env["DEPLOY_STATIC_SITE_FORCE_HOME"] = prevSudo;
  });

  it("deploys to home www tree and returns public URL", () => {
  // Force home mode by making hasPasswordlessSudo return false via env hook in tool
  const result = executeDeployStaticSite({
      slug: "agentops-demo",
      sourcePath: join(projectsTmp, "index.html"),
    });
    expect(result.success).toBe(true);
    const data = result.data as { publicUrl: string; deployMode: string; deployPath: string };
    expect(data.publicUrl).toBe("http://test.local/clients/agentops-demo/");
    expect(data.deployMode).toBe("home");
    expect(readFileSync(join(data.deployPath, "index.html"), "utf-8")).toContain("E2E");
  });

  it("rejects invalid slug", () => {
    const result = executeDeployStaticSite({
      slug: "../bad",
      sourcePath: join(projectsTmp, "index.html"),
    });
    expect(result.success).toBe(false);
  });
});
