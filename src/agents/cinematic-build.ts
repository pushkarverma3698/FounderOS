/**
 * FounderOS — Cinematic Web Build (pure functions)
 * =================================================
 * Deterministic parsing + brief generation for cinematic-web / website builder
 * E2E. Push logic out of LLM prompts (rule #16).
 */

export const CINEMATIC_PRESETS = ["neon", "glass", "terminal", "minimal"] as const;
export type CinematicPreset = (typeof CINEMATIC_PRESETS)[number];

const PRESET_RE = /\b(neon|glass|terminal|minimal)\s+preset\b/i;
const CLIENT_RE =
  /\bcalled\s+["']?([A-Za-z][\w.-]{1,40})["']?|\bfor\s+["']?([A-Za-z][\w.-]{1,40})["']?|\bstartup\s+["']?([A-Za-z][\w.-]{1,40})["']?/i;
const SLUG_KV_RE = /\bslug[=:\s]+["']?([a-z0-9][a-z0-9_-]{0,62})["']?/i;
const DEPLOY_SLUG_RE =
  /\bdeploy(?:\s+as)?\s+(?:to\s+)?["']?([a-z0-9][a-z0-9_-]{0,62})["']?/i;
const SHOWCASE_RE = /\bshowcase[-_]?(\d+)\b/i;

export interface ParsedCinematicBuild {
  client: string;
  preset: CinematicPreset;
  slug: string;
  deploy: boolean;
}

export function isValidCinematicPreset(value: string): value is CinematicPreset {
  return (CINEMATIC_PRESETS as readonly string[]).includes(value.toLowerCase());
}

/** URL-safe slug from client name when user did not specify one. */
export function slugFromClient(client: string): string {
  const base = client
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.slice(0, 63) || "landing";
}

/** Parse founder message into structured build params (best-effort). */
export function parseCinematicBuildRequest(text: string): Partial<ParsedCinematicBuild> {
  const presetMatch = PRESET_RE.exec(text);
  const presetRaw = presetMatch?.[1]?.toLowerCase();
  const preset = presetRaw && isValidCinematicPreset(presetRaw) ? presetRaw : undefined;

  const clientMatch = CLIENT_RE.exec(text);
  const client = (clientMatch?.[1] ?? clientMatch?.[2] ?? clientMatch?.[3])?.trim();

  let slug: string | undefined;
  const showcaseMatch = SHOWCASE_RE.exec(text);
  if (showcaseMatch?.[1]) {
    slug = `showcase-${showcaseMatch[1]}`;
  } else {
    const deployMatch = DEPLOY_SLUG_RE.exec(text);
    if (deployMatch?.[1]) slug = deployMatch[1].toLowerCase();
    else {
      const slugKv = SLUG_KV_RE.exec(text);
      if (slugKv?.[1]) slug = slugKv[1].toLowerCase();
    }
  }

  const deploy =
    /\b(deploy|publish|push live|go live)\b/i.test(text) ||
    /\bshowcase[-_]?\d+\b/i.test(text) ||
    /\bproof\.turicks\.com\b/i.test(text);

  const out: Partial<ParsedCinematicBuild> = {};
  if (client) out.client = client;
  if (preset) out.preset = preset;
  if (slug) out.slug = slug;
  if (deploy) out.deploy = true;
  return out;
}

/** Merge parsed text + explicit workflow params into a complete build spec. */
export function resolveCinematicBuildParams(
  text: string,
  overrides: Partial<ParsedCinematicBuild> = {},
): ParsedCinematicBuild {
  const parsed = parseCinematicBuildRequest(text);
  const client = overrides.client ?? parsed.client ?? "Landing";
  const preset = overrides.preset ?? parsed.preset ?? "neon";
  if (!isValidCinematicPreset(preset)) {
    throw new Error(`Invalid preset "${preset}". Use: ${CINEMATIC_PRESETS.join(", ")}`);
  }
  const slug = (overrides.slug ?? parsed.slug ?? slugFromClient(client)).toLowerCase();
  const deploy = overrides.deploy ?? parsed.deploy ?? false;
  return { client, preset, slug, deploy };
}

/** Workspace directory for a cinematic build under ~/Projects. */
export function cinematicWorkspaceDir(slug: string, projectsRoot?: string): string {
  const home = process.env["HOME"] ?? "/tmp";
  const root = projectsRoot?.trim() || process.env["PROJECT_WORKFLOW_ROOT"]?.trim() || `${home}/Projects`;
  return `${root}/cinematic-${slug}`;
}

/** Deterministic claude_code brief after apply_cinematic_preset. */
export function buildCinematicClaudeBrief(params: ParsedCinematicBuild & { workspaceDir: string }): string {
  const { client, preset, slug, workspaceDir } = params;
  return (
    `Customize the cinematic-web "${preset}" preset landing page for client "${client}" in ${workspaceDir}.\n` +
    `Requirements:\n` +
    `- Start from the scaffold already copied by apply_cinematic_preset (index.html + assets)\n` +
    `- Replace placeholder copy with compelling hero headline, subhead, and primary CTA for ${client}\n` +
    `- Add one features section (3 bullets) relevant to ${client}'s fictional product\n` +
    `- Keep the ${preset} aesthetic — do not flatten to generic Bootstrap\n` +
    `- Ensure a working index.html at ${workspaceDir}/index.html (build Vite if present, else static HTML)\n` +
    `- Do NOT git push, do NOT deploy, do NOT start a long-running dev server\n` +
    `- End your reply with: FILES: <paths> and HERO: <exact hero headline>`
  );
}

/** Pre-router directive fragment for the full E2E pipeline. */
export function buildCinematicPipelineDirective(params: ParsedCinematicBuild): string {
  const workspace = cinematicWorkspaceDir(params.slug);
  const brief = buildCinematicClaudeBrief({ ...params, workspaceDir: workspace });
  const deployStep = params.deploy
    ? `3) deploy_static_site(slug="${params.slug}", sourcePath="${workspace}/index.html", client="${params.client}", presetUsed="${params.preset}") — REQUIRED after build succeeds.`
    : `3) Skip deploy unless the founder asked to deploy — if they did, call deploy_static_site(slug="${params.slug}", sourcePath="${workspace}/index.html", client="${params.client}", presetUsed="${params.preset}").`;

  return (
    `CRITICAL — CINEMATIC BUILD PIPELINE (exact order, same turn after approvals):\n` +
    `1) apply_cinematic_preset(preset="${params.preset}", targetDir="${workspace}", client="${params.client}") — copies real cinematic-web scaffold\n` +
    `2) claude_code with this EXACT brief:\n"""${brief}"""\n` +
    `${deployStep}\n` +
    `NEVER use project_workflow for scaffolding. NEVER stop after step 2 if deploy was requested.`
  );
}
