/**
 * FounderOS — pnpm qa:ui
 * ========================
 * Renders the pages a client actually sees and fails the build when they are
 * broken. This is the CI entrypoint for the UI gate; the contract it implements
 * is docs/antigravity/UI-QA-CONTRACT.md.
 *
 * Usage:
 *   pnpm qa:ui                                  # 4 cinematic presets, deterministic, $0
 *   pnpm qa:ui --out .artifacts/ui-qa           # write report.md + report.json + PNGs
 *   pnpm qa:ui --vision                         # add the paid visual review (capped)
 *   pnpm qa:ui --target neon=path/to/index.html # check something else instead
 *   pnpm qa:ui --client "Acme Robotics"         # value substituted for {{CLIENT}}
 *   pnpm qa:ui --viewport desktop               # one viewport instead of both
 *
 * Exit code is the gate: 0 when nothing blocking was found, 1 otherwise.
 *
 * COST: deterministic checks make no model call, ever. `--vision` spends Gemini
 * tokens and is capped at MAX_VISION_IMAGES per run — CLAUDE.md's zero-paid-calls
 * rule makes an unbounded image loop a bug, not a tuning knob.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runUiCheck } from "../src/tools/browser/ui-check.js";
import { renderEvidencePack, type VisionStage } from "../src/tools/browser/evidence-pack.js";
import type { UiVerdict } from "../src/tools/browser/ui-vision.js";
import { closeBrowser, type ViewportName } from "../src/tools/browser/chromium.js";
import type { UiTarget } from "../src/tools/browser/ui-facts.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The default targets: the four scaffolds every client-facing Proof Drop
 * showcase descends from. They are checked here rather than the deployed pages
 * because a defect in a scaffold ships to every client built from it, and these
 * are self-contained (only a relative styles.css) so CI renders them offline.
 */
export const PRESET_IDS = ["neon", "terminal", "minimal", "glass"] as const;

export function defaultTargets(root: string = ROOT): UiTarget[] {
  return PRESET_IDS.map((id) => ({
    id,
    url: join(root, "assets", "cinematic-presets", id, "index.html"),
  })).filter((t) => existsSync(t.url));
}

export interface CliArgs {
  out?: string;
  vision: boolean;
  client: string;
  targets: UiTarget[];
  viewports: ViewportName[];
}

/** PURE arg parsing, exported so the CLI contract is unit-tested without running it. */
export function parseArgs(argv: readonly string[], root: string = ROOT): CliArgs {
  const explicit: UiTarget[] = [];
  const viewports: ViewportName[] = [];
  let out: string | undefined;
  let vision = false;
  let client = "Acme Robotics";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--vision") vision = true;
    else if (arg === "--out") out = argv[++i];
    else if (arg === "--client") client = argv[++i] ?? client;
    else if (arg === "--viewport") {
      const v = argv[++i];
      if (v === "desktop" || v === "mobile") viewports.push(v);
    } else if (arg === "--target") {
      // "--target id=path" keeps the report's row labels meaningful; a bare path
      // falls back to the path itself as the id.
      const spec = argv[++i] ?? "";
      const eq = spec.indexOf("=");
      if (eq > 0) explicit.push({ id: spec.slice(0, eq), url: resolve(spec.slice(eq + 1)) });
      else if (spec) explicit.push({ id: spec, url: resolve(spec) });
    }
  }

  return {
    ...(out ? { out } : {}),
    vision,
    client,
    targets: explicit.length > 0 ? explicit : defaultTargets(root),
    viewports: viewports.length > 0 ? viewports : ["desktop", "mobile"],
  };
}

/**
 * Run the vision stage over the screenshots ui-check produced.
 *
 * Returns a VisionStage that is honest about not running: no key, no screenshots,
 * or the cap being hit all produce `ran: false` with a printed reason rather than
 * an empty verdict list that would read as "looked, saw nothing wrong".
 */
export async function runVision(
  screenshots: Array<{ target: string; viewport: string; path: string }>,
): Promise<VisionStage> {
  if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
    return { ran: false, skippedReason: "GOOGLE_GENERATIVE_AI_API_KEY is not set" };
  }
  if (screenshots.length === 0) {
    return { ran: false, skippedReason: "no screenshots were captured (pass --out to enable them)" };
  }

  try {
    // Imported HERE, not at module scope: ui-vision reaches gemini-rest, which
    // reaches src/core/config.ts and its required DATABASE_URL / Telegram token.
    // Loading it eagerly would make the free, deterministic CI run demand
    // production secrets it never uses.
    const { judgeScreenshot, MAX_VISION_IMAGES } = await import("../src/tools/browser/ui-vision.js");

    const budget = Math.min(screenshots.length, MAX_VISION_IMAGES);
    if (screenshots.length > MAX_VISION_IMAGES) {
      console.warn(
        `⚠️  ${screenshots.length} screenshots but the vision cap is ${MAX_VISION_IMAGES}; ` +
          `reviewing the first ${budget}.`,
      );
    }

    const verdicts: UiVerdict[] = [];
    const errors: Array<{ target: string; viewport: string; error: string }> = [];

    for (const shot of screenshots.slice(0, budget)) {
      const png = readFileSync(shot.path);
      const res = await judgeScreenshot(png, {
        target: shot.target,
        viewport: shot.viewport,
        purpose: "a polished, finished launch page shown to a prospective client",
      });
      if (res.success) verdicts.push(res.verdict);
      else errors.push({ target: shot.target, viewport: shot.viewport, error: res.error });
    }

    // Every image failing is not a stage that ran clean — it is a stage that did
    // not work, and the report must say so rather than print an empty pass.
    if (verdicts.length === 0 && errors.length > 0) {
      return {
        ran: false,
        skippedReason: `every vision call failed (${errors[0]?.error ?? "unknown error"})`,
        errors,
      };
    }

    return { ran: true, verdicts, errors };
  } catch (err) {
    // A stage that could not even start (its import chain hit a requirement CI
    // never sets, a transport threw before any judgeScreenshot call, etc.) is
    // SKIPPED — one stage failing must never take the already-computed
    // deterministic results down with it.
    return { ran: false, skippedReason: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.targets.length === 0) {
    console.error("❌ qa:ui found no targets to check. Pass --target id=path, or run from the repo root.");
    process.exit(1);
  }

  console.log(
    `🔍 qa:ui — ${args.targets.length} target(s) x ${args.viewports.length} viewport(s)` +
      `${args.vision ? " + vision" : " (deterministic only, $0)"}`,
  );

  const screenshotDir = args.out ? join(args.out, "screenshots") : undefined;
  const rows = await runUiCheck({
    targets: args.targets,
    viewports: args.viewports,
    substitutions: { CLIENT: args.client },
    ...(screenshotDir ? { screenshotDir } : {}),
  });

  let stage: VisionStage = { ran: false, skippedReason: "--vision was not requested" };
  if (args.vision) {
    const shots = rows
      .filter((r) => r.screenshotPath)
      .map((r) => ({ target: r.target, viewport: r.viewport, path: r.screenshotPath! }));
    stage = await runVision(shots);
  }

  const pack = renderEvidencePack(rows, stage);

  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, "report.md"), pack.markdown);
    writeFileSync(join(args.out, "report.json"), pack.json);
    console.log(`\n📦 Evidence pack written to ${args.out}/report.md`);
  }

  console.log("\n" + pack.markdown);

  await closeBrowser();
  process.exit(pack.pass ? 0 : 1);
}

// Only run when invoked as a script, so the exported helpers (parseArgs,
// defaultTargets) stay importable by unit tests without launching a browser.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error("❌ qa:ui failed to run:", err);
    await closeBrowser();
    process.exit(1);
  });
}
