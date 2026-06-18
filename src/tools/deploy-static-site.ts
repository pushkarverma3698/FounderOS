/**
 * FounderOS — Static Site Deploy Tool (Engineering Department)
 * =============================================================
 * Copies a built landing page (index.html or static directory) from ~/Projects
 * into the VPS web root and returns a public URL. Used after claude_code builds
 * a cinematic-web / Proof Drop artifact.
 *
 * Deploy targets (in priority order):
 *   1. System web root when passwordless sudo works: /var/www/...
 *   2. Home fallback: ~/www/proof.turicks.com/...
 *
 * Public URL is built from STATIC_SITE_PUBLIC_BASE_URL (e.g. http://95.217.162.12).
 */

import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, normalize, resolve } from "node:path";
import { childLogger } from "../infra/logger.js";
import { isProjectPath } from "./project-workflow.js";
import type { ToolResult, UnifiedTool } from "./index.js";

const log = childLogger({ module: "tool:deploy-static-site" });

/** Slug-safe client/site identifier (URL path segment). */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

export interface DeployStaticSiteInput {
  slug: string;
  sourcePath: string;
  client?: string;
  presetUsed?: string;
}

export interface DeployStaticSiteResult {
  slug: string;
  deployPath: string;
  publicUrl: string;
  deployMode: "system" | "home";
  bytesCopied: number;
}

function homeDir(): string {
  return process.env["HOME"] ?? "/tmp";
}

/** Base URL for public links (no trailing slash). */
export function publicBaseUrl(): string {
  const configured = process.env["STATIC_SITE_PUBLIC_BASE_URL"]?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return "http://127.0.0.1";
}

/** System web root when sudo works; otherwise home www tree. */
export function resolveWebRoots(): { system: string; home: string } {
  const systemOverride = process.env["STATIC_SITE_SYSTEM_ROOT"]?.trim();
  const homeOverride = process.env["STATIC_SITE_HOME_ROOT"]?.trim();
  return {
    system: systemOverride ?? "/var/www",
    home: homeOverride ?? join(homeDir(), "www"),
  };
}

/** Whether passwordless sudo is available (VPS CI deploy path). */
export function hasPasswordlessSudo(): boolean {
  if (process.env["DEPLOY_STATIC_SITE_FORCE_HOME"] === "1") return false;
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** Validate slug for URL safety. */
export function isValidDeploySlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Map slug → deploy directory under a web root. */
export function deployDirForSlug(webRoot: string, slug: string): string {
  const normalized = slug.toLowerCase();
  if (normalized === "showcase-1") {
    return join(webRoot, "proof.turicks.com", "showcase-1");
  }
  return join(webRoot, "clients", normalized);
}

/** Map slug → public URL path. */
export function publicPathForSlug(slug: string): string {
  const normalized = slug.toLowerCase();
  if (normalized === "showcase-1") return "/showcase-1/";
  return `/clients/${normalized}/`;
}

export function buildPublicUrl(slug: string): string {
  const base = publicBaseUrl();
  const path = publicPathForSlug(slug);
  return `${base}${path}`;
}

/**
 * Source must be a readable file or directory under ~/Projects (build output).
 * Blocks secrets and paths outside the project root.
 */
export function isAllowedSourcePath(sourcePath: string): boolean {
  const abs = resolve(normalize(sourcePath));
  if (!existsSync(abs)) return false;
  return isProjectPath(abs);
}

function copyEntry(src: string, dest: string): number {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    let total = 0;
    for (const entry of readdirSync(src)) {
      total += copyEntry(join(src, entry), join(dest, entry));
    }
    return total;
  }
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(src, dest);
  return stat.size;
}

/** Copy source (file or dir) into destDir. Returns bytes copied. */
export function copyStaticArtifact(sourcePath: string, destDir: string): number {
  const abs = resolve(normalize(sourcePath));
  mkdirSync(destDir, { recursive: true });

  const stat = lstatSync(abs);
  if (stat.isDirectory()) {
    let total = 0;
    for (const entry of readdirSync(abs)) {
      total += copyEntry(join(abs, entry), join(destDir, entry));
    }
    return total;
  }

  const destFile = basename(abs).toLowerCase() === "index.html"
    ? join(destDir, "index.html")
    : join(destDir, basename(abs));
  return copyEntry(abs, destFile);
}

/** Deploy via sudo cp when system mode is required. */
function deployViaSudo(sourcePath: string, destDir: string): number {
  const abs = resolve(normalize(sourcePath));
  execSync(`sudo mkdir -p "${destDir}"`, { timeout: 10_000 });
  if (lstatSync(abs).isDirectory()) {
    execSync(`sudo cp -r "${abs}/." "${destDir}/"`, { timeout: 60_000 });
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else total += s.size;
      }
    };
    walk(destDir);
    return total;
  }
  const destFile = join(destDir, "index.html");
  execSync(`sudo cp "${abs}" "${destFile}"`, { timeout: 30_000 });
  return statSync(destFile).size;
}

/**
 * Core deploy logic — pure aside from filesystem/sudo side effects.
 * Never throws; returns ToolResult.
 */
export function executeDeployStaticSite(input: DeployStaticSiteInput): ToolResult {
  const slug = input.slug.trim();
  if (!isValidDeploySlug(slug)) {
    return {
      success: false,
      error: `Invalid slug "${slug}". Use letters, numbers, hyphens (1–63 chars).`,
    };
  }

  if (!input.sourcePath?.trim()) {
    return { success: false, error: "sourcePath is required." };
  }

  const sourcePath = resolve(normalize(input.sourcePath.trim()));
  if (!existsSync(sourcePath)) {
    return { success: false, error: `Source not found: ${sourcePath}` };
  }
  if (!isAllowedSourcePath(sourcePath)) {
    return {
      success: false,
      error: `Source must be a file or directory under ~/Projects: ${sourcePath}`,
    };
  }

  const roots = resolveWebRoots();
  const useSystem = hasPasswordlessSudo();
  const webRoot = useSystem ? roots.system : roots.home;
  const deployDir = deployDirForSlug(webRoot, slug);
  const publicUrl = buildPublicUrl(slug);

  let bytesCopied = 0;
  try {
    if (useSystem) {
      bytesCopied = deployViaSudo(sourcePath, deployDir);
      log.info({ slug, deployDir, bytesCopied, mode: "system" }, "deploy_static_site");
    } else {
      bytesCopied = copyStaticArtifact(sourcePath, deployDir);
      log.info({ slug, deployDir, bytesCopied, mode: "home" }, "deploy_static_site");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Deploy failed: ${msg}` };
  }

  const result: DeployStaticSiteResult = {
    slug,
    deployPath: deployDir,
    publicUrl,
    deployMode: useSystem ? "system" : "home",
    bytesCopied,
  };

  return { success: true, data: result };
}

export const deployStaticSiteTool: UnifiedTool = {
  name: "deploy_static_site",
  description:
    "Deploy a static landing page (index.html or directory) from ~/Projects to the public web root. " +
    "Returns the public URL. Use after claude_code builds a cinematic-web / Proof Drop site. " +
    "Slug becomes the URL path (/clients/{slug}/ or /showcase-1/). Requires founder approval.",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "URL-safe client slug (e.g. langfuse, showcase-1)" },
      sourcePath: { type: "string", description: "Path to index.html or static site directory under ~/Projects" },
      client: { type: "string", description: "Client display name for site_deployed signal (defaults to slug)" },
      presetUsed: { type: "string", description: "cinematic-web preset used (neon, glass, etc.)" },
    },
    required: ["slug", "sourcePath"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    return executeDeployStaticSite({
      slug: String(args["slug"] ?? ""),
      sourcePath: String(args["sourcePath"] ?? ""),
      ...(args["client"] ? { client: String(args["client"]) } : {}),
      ...(args["presetUsed"] ? { presetUsed: String(args["presetUsed"]) } : {}),
    });
  },
};
