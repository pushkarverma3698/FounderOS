/**
 * FounderOS — apply_cinematic_preset Tool (Engineering)
 * =====================================================
 * Copies a real cinematic-web preset scaffold into ~/Projects before claude_code
 * customizes it. Sources (priority order):
 *   1. CINEMATIC_WEB_PRESETS_ROOT/{preset}/  (cloned Website-Builder-Tool repo)
 *   2. Bundled assets/cinematic-presets/{preset}/ in FounderOS
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CINEMATIC_PRESETS,
  isValidCinematicPreset,
  type CinematicPreset,
} from "../agents/cinematic-build.js";
import { isProjectPath, projectRoot, resolveProjectPath } from "./project-workflow.js";
import type { ToolResult, UnifiedTool } from "./index.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:cinematic-preset" });

export interface ApplyCinematicPresetInput {
  preset: string;
  targetDir: string;
  client?: string;
}

export interface ApplyCinematicPresetResult {
  preset: CinematicPreset;
  targetDir: string;
  sourceDir: string;
  filesCopied: string[];
  bytesCopied: number;
}

/** Repo-relative bundled presets (works in dev + compiled dist). */
export function bundledPresetsRoot(): string {
  const override = process.env["CINEMATIC_WEB_BUNDLED_ROOT"]?.trim();
  if (override) return override;
  // process.cwd() = /opt/founderos (pinned by systemd WorkingDirectory), which is
  // always the project root regardless of whether we're running tsx src/ or node dist/.
  // import.meta.url would resolve to dist/src/tools/ in compiled mode, making the
  // "../../../assets" hop land in dist/assets/ (nonexistent) — hence "preset not found".
  return resolve(process.cwd(), "assets", "cinematic-presets");
}

/** External cinematic-web clone path (Website-Builder-Tool). */
export function externalPresetsRoot(): string | null {
  const root = process.env["CINEMATIC_WEB_PRESETS_ROOT"]?.trim();
  return root && existsSync(root) ? root : null;
}

export function resolvePresetSourceDir(preset: CinematicPreset): string | null {
  const external = externalPresetsRoot();
  if (external) {
    const extPath = join(external, preset);
    if (existsSync(extPath)) return extPath;
  }
  const bundled = join(bundledPresetsRoot(), preset);
  if (existsSync(bundled)) return bundled;
  return null;
}

function copyDir(src: string, dest: string): { files: string[]; bytes: number } {
  mkdirSync(dest, { recursive: true });
  const files: string[] = [];
  let bytes = 0;
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      const nested = copyDir(srcPath, destPath);
      files.push(...nested.files);
      bytes += nested.bytes;
    } else {
      cpSync(srcPath, destPath);
      files.push(destPath);
      bytes += st.size;
    }
  }
  return { files, bytes };
}

/** Replace {{CLIENT}} placeholders after copy. */
export function personalizePresetFiles(targetDir: string, client: string): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(html|css|md|txt|json)$/i.test(entry)) continue;
      const raw = readFileSync(p, "utf-8");
      if (!raw.includes("{{CLIENT}}")) continue;
      writeFileSync(p, raw.replaceAll("{{CLIENT}}", client), "utf-8");
    }
  };
  walk(targetDir);
}

export function executeApplyCinematicPreset(input: ApplyCinematicPresetInput): ToolResult {
  const presetRaw = input.preset?.trim().toLowerCase() ?? "";
  if (!isValidCinematicPreset(presetRaw)) {
    return {
      success: false,
      error: `Invalid preset "${input.preset}". Valid: ${CINEMATIC_PRESETS.join(", ")}`,
    };
  }
  const preset = presetRaw;

  const targetDir = resolveProjectPath(input.targetDir);
  if (!isProjectPath(targetDir)) {
    const root = projectRoot();
    return { success: false, error: `targetDir must be under ${root}: ${targetDir}` };
  }

  const sourceDir = resolvePresetSourceDir(preset);
  if (!sourceDir) {
    return {
      success: false,
      error: `Preset "${preset}" not found. Set CINEMATIC_WEB_PRESETS_ROOT or use bundled presets.`,
    };
  }

  try {
    const { files, bytes } = copyDir(sourceDir, targetDir);
    const client = input.client?.trim() || "Client";
    personalizePresetFiles(targetDir, client);

    const result: ApplyCinematicPresetResult = {
      preset,
      targetDir,
      sourceDir,
      filesCopied: files.map((f) => f.replace(targetDir + "/", "")),
      bytesCopied: bytes,
    };
    log.info({ preset, targetDir, bytes }, "apply_cinematic_preset");
    return { success: true, data: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to apply preset: ${msg}` };
  }
}

export const applyCinematicPresetTool: UnifiedTool = {
  name: "apply_cinematic_preset",
  description:
    "Copy a cinematic-web preset scaffold (neon, glass, terminal, minimal) into a ~/Projects directory. " +
    "Call BEFORE claude_code on cinematic landing builds. No approval needed — read-only copy.",
  input_schema: {
    type: "object",
    properties: {
      preset: { type: "string", description: "Preset name: neon, glass, terminal, minimal" },
      targetDir: { type: "string", description: "Destination under ~/Projects (e.g. ~/Projects/cinematic-showcase-1)" },
      client: { type: "string", description: "Client name for {{CLIENT}} placeholders" },
    },
    required: ["preset", "targetDir"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    return executeApplyCinematicPreset({
      preset: String(args["preset"] ?? ""),
      targetDir: String(args["targetDir"] ?? ""),
      ...(args["client"] ? { client: String(args["client"]) } : {}),
    });
  },
};
